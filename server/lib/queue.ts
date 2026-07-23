// 生成任务队列：本地 GPU 车道串行（一次一个占满显存），云车道小并发，mock 车道并发。
// 产物即文件、状态可从磁盘还原，队列本身进程内即可（重启不丢已生成产物）。

import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import { characterDir, getProject, getChoices, listCharacterRefs, listShotOutputs, saveProject, setChoice, shotDir, shotKey } from "./projects.ts";
import { getStyle, StyleError } from "./styles.ts";
import { assembleCharRefAnchors, assembleRefs, buildCharRefNegatives, buildCharRefPrompt, buildKeyframeNegatives, buildKeyframePrompt, buildVideoPrompts, wanFrames } from "./prompt.ts";
import { comfyGenerate } from "./providers/comfyui.ts";
import { falVideoGenerate } from "./providers/fal.ts";
import { mockKeyframe, mockVideo } from "./providers/mock.ts";
import { seedreamGenerate } from "./providers/seedream.ts";
import type { CharRefMode, GenJob, JobKind, Project, StudioConfig, StyleProfile } from "./types.ts";
import { getGpuLease, releaseGpu, tryAcquireGpu } from "./gpu-lease.ts";

const jobs: GenJob[] = [];
let seq = 0;

type Lane = "local" | "cloud" | "mock";
const LANE_LIMIT: Record<Lane, number> = { local: 1, cloud: 2, mock: 2 };

function laneOf(provider: string): Lane {
  if (provider.startsWith("comfyui")) return "local";
  if (provider.startsWith("mock")) return "mock";
  return "cloud";
}

export function listJobs(projectId?: string): GenJob[] {
  return projectId ? jobs.filter((j) => j.projectId === projectId) : jobs;
}

/** 是否已有同镜同类任务在排队/运行（防重复入队烧钱烧卡） */
function pendingJob(projectId: string, shotIndex: number, kind: JobKind): GenJob | undefined {
  return jobs.find(
    (j) => j.projectId === projectId && j.shotIndex === shotIndex && j.kind === kind && (j.status === "queued" || j.status === "running"),
  );
}

export function enqueue(projectId: string, shotIndex: number, kind: JobKind, provider: string, chainVideoProvider?: string): GenJob {
  if (provider === "comfyui-image2") {
    const project = getProject(projectId);
    const style = project?.styleId ? getStyle(project.styleId) : null;
    if (!style?.lora) {
      throw new StyleError("本地 ComfyUI · B（LoRA）需要当前项目选择一个已绑定 LoRA 的画风", 409, "CONFLICT");
    }
  }
  const job: GenJob = {
    id: `j${++seq}-${Date.now().toString(36)}`,
    projectId,
    shotIndex,
    kind,
    provider,
    status: "queued",
    createdAt: Date.now(),
    chainVideoProvider,
  };
  jobs.push(job);
  pump();
  return job;
}

/** 入队一个角色参考图（人设锚点）生成任务；shotIndex 用 0 哨兵，走同一队列/GPU 租约。 */
export function enqueueCharRef(projectId: string, charName: string, mode: CharRefMode, provider: string, desc?: string): GenJob {
  const p = getProject(projectId);
  if (!p) throw new Error("项目不存在");
  if (!p.doc.characters.some((c) => c.name === charName)) {
    throw new StyleError(`角色不存在：${charName}`, 404, "NOT_FOUND");
  }
  if (provider === "comfyui-image2") {
    const style = p.styleId ? getStyle(p.styleId) : null;
    if (!style?.lora) {
      throw new StyleError("本地 ComfyUI · B（LoRA）需要当前项目选择一个已绑定 LoRA 的画风", 409, "CONFLICT");
    }
  }
  const job: GenJob = {
    id: `j${++seq}-${Date.now().toString(36)}`,
    projectId,
    shotIndex: 0,
    kind: "charref",
    provider,
    status: "queued",
    createdAt: Date.now(),
    charName,
    charRefMode: mode,
    ...(desc ? { charRefDesc: desc } : {}),
  };
  jobs.push(job);
  pump();
  return job;
}

/** 全自动：缺 keyframe 的镜先出图并接力出片；有 keyframe 缺视频的直接出片 */
export function enqueueAuto(projectId: string, kfProvider: string, vidProvider: string): GenJob[] {
  const p = getProject(projectId);
  if (!p) throw new Error("项目不存在");
  const out: GenJob[] = [];
  for (const shot of p.doc.shots) {
    const ch = getChoices(p, shot.index);
    const kfs = listShotOutputs(p.id, "keyframes", shot.index);
    const vids = listShotOutputs(p.id, "videos", shot.index);
    const hasKf = ch.keyframe || kfs.length > 0;
    const hasVid = ch.video || vids.length > 0;
    if (hasVid || pendingJob(projectId, shot.index, "video")) continue;
    if (!hasKf) {
      const pendingKf = pendingJob(projectId, shot.index, "keyframe");
      if (pendingKf) {
        // 已有出图任务在途：确保完成后会接力出片，不再重复入队
        if (!pendingKf.chainVideoProvider) pendingKf.chainVideoProvider = vidProvider;
        continue;
      }
      out.push(enqueue(projectId, shot.index, "keyframe", kfProvider, vidProvider));
    } else {
      out.push(enqueue(projectId, shot.index, "video", vidProvider));
    }
  }
  return out;
}

let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  queueMicrotask(async () => {
    try {
      while (true) {
        const runningByLane: Record<Lane, number> = { local: 0, cloud: 0, mock: 0 };
        for (const j of jobs) if (j.status === "running") runningByLane[laneOf(j.provider)]++;
        const next = jobs.find((j) => {
          const lane = laneOf(j.provider);
          if (j.status !== "queued" || runningByLane[lane] >= LANE_LIMIT[lane]) return false;
          return lane !== "local" || getGpuLease() === null;
        });
        if (!next) break;
        const lane = laneOf(next.provider);
        if (lane === "local" && !tryAcquireGpu("generation", next.id)) continue;
        next.status = "running";
        next.startedAt = Date.now();
        // 不 await 串死其他车道；每个 job 完成后再 pump
        void runJob(next).finally(() => {
          if (lane === "local") releaseGpu(next.id);
          pumping = false;
          pump();
        });
        // local 车道串行：本轮已派 local 后继续找其他车道的活
      }
    } finally {
      pumping = false;
    }
  });
}

/** LoRA 租约释放后唤醒可能在等待的本地生成任务。 */
export function resumeGenerationPump(): void {
  pump();
}

async function runJob(job: GenJob) {
  try {
    const cfg = loadConfig();
    const p = getProject(job.projectId);
    if (!p) throw new Error("项目不存在");
    const style = p.styleId ? getStyle(p.styleId) : null;
    // 前缀含 job.id（内含全局递增 seq），杜绝同毫秒撞名覆盖
    const ts = `${Date.now().toString(36)}-${job.id.split("-")[0]}`;
    let outputs: string[] = [];

    // 角色参考图（人设锚点）：自成一支，产物直接落角色源图库，不涉及镜头。
    if (job.kind === "charref") {
      await runCharRefJob(job, p, style, cfg, ts);
      job.status = "done";
      return;
    }

    const shot = p.doc.shots.find((s) => s.index === job.shotIndex);
    if (!shot) throw new Error(`分镜 ${job.shotIndex} 不存在`);

    if (job.kind === "keyframe") {
      const outDir = shotDir(p.id, "keyframes", shot.index);
      const prefix = `${job.provider}-${ts}`;
      if (job.provider === "mock-image") {
        outputs = await mockKeyframe({ outDir, outPrefix: prefix, label: `${shotKey(shot.index)} ${shot.title}`, width: cfg.keyframeWidth, height: cfg.keyframeHeight });
      } else if (job.provider === "comfyui-image" || job.provider === "comfyui-image2") {
        const wf = job.provider === "comfyui-image2" ? cfg.comfyImage2 : cfg.comfyImage;
        if (!wf) throw new Error(`未配置图像 workflow（settings → ${job.provider === "comfyui-image2" ? "comfyImage2" : "comfyImage"}）`);
        const styleLora = job.provider === "comfyui-image2" ? style?.lora : undefined;
        if (job.provider === "comfyui-image2" && !styleLora) {
          throw new StyleError("当前项目画风未绑定 LoRA，不能运行 B 档", 409, "CONFLICT");
        }
        const configuredStrength = styleLora?.training?.inferenceStrength;
        // 按 provider 策略组装参考计划（B 档策略内自带「空镜不补锚图」语义）；预算裁减告警挂 job。
        const plan = assembleRefs(p, shot, style, cfg, job.provider);
        if (plan.warnings.length > 0) job.warnings = [...(job.warnings ?? []), ...plan.warnings];
        outputs = await comfyGenerate({
          comfyUrl: cfg.comfyUrl,
          wf,
          prompt: buildKeyframePrompt(p, shot, style, plan),
          negative: buildKeyframeNegatives(p, style, shot),
          refImages: plan.refImages,
          styleLora: styleLora ? {
            weightsPath: styleLora.weightsPath,
            triggerWords: styleLora.triggerWords,
            strength: typeof configuredStrength === "number" ? configuredStrength : 0.8,
          } : undefined,
          seed: Math.floor(Math.random() * 2 ** 31),
          width: cfg.keyframeWidth,
          height: cfg.keyframeHeight,
          outDir,
          outPrefix: prefix,
        });
      } else if (job.provider === "seedream-image") {
        if (!cfg.arkApiKey) throw new Error("未配置 arkApiKey（火山方舟 API Key）");
        // multi-image 策略：多图直喂集（默认全选 − excluded），预算 10，按角色分组连续编号。
        const plan = assembleRefs(p, shot, style, cfg, job.provider);
        if (plan.warnings.length > 0) job.warnings = [...(job.warnings ?? []), ...plan.warnings];
        outputs = await seedreamGenerate({
          arkApiKey: cfg.arkApiKey,
          model: cfg.seedreamModel,
          prompt: buildKeyframePrompt(p, shot, style, plan),
          negative: buildKeyframeNegatives(p, style, shot),
          refImages: plan.refImages,
          size: cfg.seedreamSize,
          outDir,
          outPrefix: prefix,
        });
      } else {
        throw new Error(`未知 keyframe provider: ${job.provider}`);
      }
      job.output = `keyframes/${shotKey(shot.index)}/${outputs[0]}`;
      const fresh = getProject(p.id)!;
      if (!getChoices(fresh, shot.index).keyframe) setChoice(fresh, shot.index, "keyframe", outputs[0]);
      // 全自动接力出片（该镜已有视频/在途视频任务时不重复）
      if (
        job.chainVideoProvider &&
        listShotOutputs(p.id, "videos", shot.index).length === 0 &&
        !pendingJob(p.id, shot.index, "video")
      ) {
        enqueue(p.id, shot.index, "video", job.chainVideoProvider);
      }
    } else {
      const outDir = shotDir(p.id, "videos", shot.index);
      const prefix = `${job.provider}-${ts}`;
      const durationSec = shot.durationSec ?? cfg.defaultShotSec;
      const chosen = getChoices(p, shot.index).keyframe ?? listShotOutputs(p.id, "keyframes", shot.index)[0];
      const kfPath = chosen ? join(shotDir(p.id, "keyframes", shot.index), chosen) : undefined;
      const { pos, neg } = buildVideoPrompts(p, shot, style);

      if (job.provider === "mock-video") {
        outputs = await mockVideo({ outDir, outPrefix: prefix, imagePath: kfPath, durationSec, width: cfg.videoWidth, height: cfg.videoHeight, fps: cfg.videoFps });
      } else if (job.provider === "comfyui-video") {
        if (!cfg.comfyVideo) throw new Error("未配置视频 workflow（settings → comfyVideo）");
        if (!kfPath) throw new Error("该镜还没有 keyframe，先出图再出片");
        outputs = await comfyGenerate({
          comfyUrl: cfg.comfyUrl,
          wf: cfg.comfyVideo,
          prompt: pos,
          negative: neg,
          startImage: kfPath,
          seed: Math.floor(Math.random() * 2 ** 31),
          width: cfg.videoWidth,
          height: cfg.videoHeight,
          frames: wanFrames(durationSec, cfg.videoFps),
          outDir,
          outPrefix: prefix,
        });
      } else if (job.provider === "hunyuan-video") {
        if (!cfg.comfyVideoHunyuan) throw new Error("未配置混元 workflow（settings → comfyVideoHunyuan）");
        if (!kfPath) throw new Error("该镜还没有 keyframe，先出图再出片");
        // 混元原生 480p（848×480），分辨率由模板固定、不注入 width/height；24fps、length=4n+1
        outputs = await comfyGenerate({
          comfyUrl: cfg.comfyUrl,
          wf: cfg.comfyVideoHunyuan,
          prompt: pos,
          negative: neg,
          startImage: kfPath,
          seed: Math.floor(Math.random() * 2 ** 31),
          frames: wanFrames(durationSec, 24),
          outDir,
          outPrefix: prefix,
        });
      } else if (job.provider === "fal-video") {
        if (!cfg.falKey) throw new Error("未配置 falKey");
        if (!kfPath) throw new Error("该镜还没有 keyframe，先出图再出片");
        outputs = await falVideoGenerate({
          falKey: cfg.falKey,
          model: cfg.falVideoModel,
          prompt: pos,
          negative: neg,
          imagePath: kfPath,
          durationSec,
          fps: cfg.videoFps,
          resolution: cfg.videoHeight >= 720 ? "720p" : cfg.videoHeight >= 580 ? "580p" : "480p",
          outDir,
          outPrefix: prefix,
        });
      } else {
        throw new Error(`未知 video provider: ${job.provider}`);
      }
      job.output = `videos/${shotKey(shot.index)}/${outputs[0]}`;
      const fresh = getProject(p.id)!;
      if (!getChoices(fresh, shot.index).video) setChoice(fresh, shot.index, "video", outputs[0]);
    }

    // 成本入账
    const cost = cfg.prices[job.provider] ?? 0;
    if (cost > 0) {
      const fresh = getProject(p.id)!;
      fresh.costLedger.push({ at: Date.now(), provider: job.provider, kind: job.kind, shotIndex: shot.index, cost });
      saveProject(fresh);
    }
    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
  } finally {
    job.finishedAt = Date.now();
  }
}

/** 角色参考图（人设锚点）生成：产物写角色源图库，即刻进双参考集。 */
async function runCharRefJob(job: GenJob, p: Project, style: StyleProfile | null, cfg: StudioConfig, ts: string) {
  const charName = job.charName;
  if (!charName) throw new Error("charref 任务缺少 charName");
  const character = p.doc.characters.find((c) => c.name === charName);
  if (!character) throw new Error(`角色不存在：${charName}`);
  const mode: CharRefMode = job.charRefMode ?? "single";
  const outDir = characterDir(p.id, charName);
  const prefix = `gen-${mode}-${ts}`;
  const prompt = buildCharRefPrompt(p, character, mode, style, job.charRefDesc);
  const negative = buildCharRefNegatives(p, mode, style);
  const anchors = assembleCharRefAnchors(p, style, cfg, job.provider);

  let outputs: string[] = [];
  if (job.provider === "mock-image") {
    outputs = await mockKeyframe({ outDir, outPrefix: prefix, label: `${charName} ${mode}`, width: cfg.keyframeWidth, height: cfg.keyframeHeight });
  } else if (job.provider === "comfyui-image" || job.provider === "comfyui-image2") {
    const wf = job.provider === "comfyui-image2" ? cfg.comfyImage2 : cfg.comfyImage;
    if (!wf) throw new Error(`未配置图像 workflow（settings → ${job.provider === "comfyui-image2" ? "comfyImage2" : "comfyImage"}）`);
    const styleLora = job.provider === "comfyui-image2" ? style?.lora : undefined;
    if (job.provider === "comfyui-image2" && !styleLora) {
      throw new StyleError("当前项目画风未绑定 LoRA，不能运行 B 档", 409, "CONFLICT");
    }
    const configuredStrength = styleLora?.training?.inferenceStrength;
    outputs = await comfyGenerate({
      comfyUrl: cfg.comfyUrl,
      wf,
      prompt,
      negative,
      refImages: anchors,
      styleLora: styleLora ? {
        weightsPath: styleLora.weightsPath,
        triggerWords: styleLora.triggerWords,
        strength: typeof configuredStrength === "number" ? configuredStrength : 0.8,
      } : undefined,
      seed: Math.floor(Math.random() * 2 ** 31),
      width: cfg.keyframeWidth,
      height: cfg.keyframeHeight,
      outDir,
      outPrefix: prefix,
    });
  } else if (job.provider === "seedream-image") {
    if (!cfg.arkApiKey) throw new Error("未配置 arkApiKey（火山方舟 API Key）");
    outputs = await seedreamGenerate({
      arkApiKey: cfg.arkApiKey,
      model: cfg.seedreamModel,
      prompt,
      negative,
      refImages: anchors,
      size: cfg.seedreamSize,
      outDir,
      outPrefix: prefix,
    });
  } else {
    throw new Error(`未知 charref provider: ${job.provider}（仅支持 comfyui-image / comfyui-image2 / seedream-image / mock-image）`);
  }

  const file = outputs[0];
  if (!file || !listCharacterRefs(p.id, charName).includes(file)) {
    throw new Error("角色参考图产物未落入源图库");
  }
  job.output = `characters/${basename(outDir)}/${file}`;

  const cost = cfg.prices[job.provider] ?? 0;
  if (cost > 0) {
    const fresh = getProject(p.id)!;
    fresh.costLedger.push({ at: Date.now(), provider: job.provider, kind: "charref", shotIndex: 0, cost });
    saveProject(fresh);
  }
}
