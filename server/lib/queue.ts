// 生成任务队列：本地 GPU 车道串行（一次一个占满显存），云车道小并发，mock 车道并发。
// 产物即文件、状态可从磁盘还原，队列本身进程内即可（重启不丢已生成产物）。

import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import { characterDir, getProject, getChoices, listCharacterRefs, listShotOutputs, saveProject, setChoice, shotDir, shotKey } from "./projects.ts";
import { getStyle, StyleError } from "./styles.ts";
import { refSetsOf, setCharacterGenerationReference } from "./character-refs.ts";
import { assembleCharRefAnchors, assembleRefs, buildCharRefNegatives, buildCharRefPrompt, buildKeyframeNegatives, buildKeyframePrompt, buildVideoPrompts, h3Frames, wanFrames } from "./prompt.ts";
import { comfyGenerate } from "./providers/comfyui.ts";
import { falVideoGenerate } from "./providers/fal.ts";
import { mockKeyframe, mockVideo } from "./providers/mock.ts";
import { pixmindDuration, pixmindImageGenerate, pixmindVideoGenerate } from "./providers/pixmind.ts";
import { seedreamGenerate } from "./providers/seedream.ts";
import type { CharRefMode, ComfyWorkflowConfig, GenJob, JobKind, Project, StudioConfig, StyleProfile } from "./types.ts";
import { getGpuLease, releaseGpu, tryAcquireGpu } from "./gpu-lease.ts";
import { artifactPrefix, artifactTs } from "../../shared/contracts/artifact-name.ts";
import { affinity, weightsOf } from "./weight-affinity.ts";

const jobs: GenJob[] = [];
let seq = 0;

/** 每个在途任务的中止句柄；任务一结束就回收，别攒着泄漏。 */
const controllers = new Map<string, AbortController>();

function isFinished(status: GenJob["status"]): boolean {
  return status === "done" || status === "error" || status === "canceled";
}

type Lane = "local" | "cloud" | "mock";
const LANE_LIMIT: Record<Lane, number> = { local: 1, cloud: 2, mock: 2 };

/**
 * 本地 ComfyUI 驱动、但出口 id 不以 comfyui 开头的档位。
 * 这类出口同样吃本机 GPU，必须走 local 车道（串行 + 抢 GPU 租约），
 * 否则会落进 cloud 车道并发 2 且不抢租约——H3 单条常驻约 21GB/24GB，
 * 并发两条或与 Wan2.2 / LoRA 训练并行必 OOM。
 */
const LOCAL_GPU_PROVIDERS = new Set(["hunyuan-video", "h3-video", "h3-video-final"]);

/** pickNext 的返回：任务 + 它的权重指纹（指纹在选取阶段算好，派发段只做赋值）。 */
type PickedJob = { job: GenJob; weights: Set<string> | null };

/** 被更亲和的后来者插队多少次后强制放行。与换模代价同量纲，且桩测可确定性断言。 */
const DEFAULT_AFFINITY_MAX_SKIPS = 16;
/** 每条排队任务被插队的次数；任务终态后清掉，别攒着泄漏。 */
const skipCount = new Map<string, number>();

/** 出片出口 -> 它吃的 workflow 槽。产物命名要据此判断种子是否真会进图。 */
function videoWorkflowOf(cfg: StudioConfig, provider: string): ComfyWorkflowConfig | undefined {
  switch (provider) {
    case "comfyui-video": return cfg.comfyVideo;
    case "hunyuan-video": return cfg.comfyVideoHunyuan;
    case "h3-video": return cfg.comfyVideoH3;
    case "h3-video-final": return cfg.comfyVideoH3Final;
    default: return undefined;
  }
}

export function laneOf(provider: string): Lane {
  if (provider.startsWith("comfyui") || LOCAL_GPU_PROVIDERS.has(provider)) return "local";
  if (provider.startsWith("mock")) return "mock";
  return "cloud";
}

/** 出口 -> 它吃的 workflow 槽（含出图，出图同样吃 local 车道与同一块显存）。 */
function workflowOf(cfg: StudioConfig, provider: string): ComfyWorkflowConfig | undefined {
  switch (provider) {
    case "comfyui-image": return cfg.comfyImage;
    case "comfyui-image2": return cfg.comfyImage2;
    case "comfyui-video": return cfg.comfyVideo;
    case "hunyuan-video": return cfg.comfyVideoHunyuan;
    case "h3-video": return cfg.comfyVideoH3;
    case "h3-video-final": return cfg.comfyVideoH3Final;
    default: return undefined;
  }
}

/**
 * 上一个已派发的 local 任务留下的权重指纹。null = 无先验（退化成入队顺序）。
 * 只在 local 任务真正被派发时更新；失去依据时作废（见 invalidateLocalWeights）。
 */
let lastLocalWeights: Set<string> | null = null;

/**
 * 作废「显存里还热着哪组权重」的信念。
 * 两种情形下这个信念不再成立：GPU 租约被 LoRA 训练占用过、上一轮以失联/任务丢失告终。
 * 实测已证 ComfyUI 每执行一个节点就清掉上一代 ModelPatcher，训练跑完后「H3 还热着」是假的。
 */
export function invalidateLocalWeights(): void {
  lastLocalWeights = null;
}

/**
 * 选下一个可派发的任务。
 * cloud / mock 车道**严格保持先进先出**，一行不动；
 * local 车道按「与上一个 local 任务的权重交集大小降序、入队时间升序」选，
 * 并用被插队次数兜住饥饿。
 */
function pickNext(runningByLane: Record<Lane, number>): PickedJob | undefined {
  const ready = (j: GenJob) => {
    const lane = laneOf(j.provider);
    if (j.status !== "queued" || runningByLane[lane] >= LANE_LIMIT[lane]) return false;
    return lane !== "local" || getGpuLease() === null;
  };

  const localReady = jobs.filter((j) => ready(j) && laneOf(j.provider) === "local");
  if (localReady.length === 0) {
    // 非 local 车道：原样 FIFO
    const firstNonLocal = jobs.find((j) => ready(j) && laneOf(j.provider) !== "local");
    return firstNonLocal ? { job: firstNonLocal, weights: null } : undefined;
  }

  // 配置读坏不该弄死调度：亲和排序是优化不是正确性，读不到就退化成 FIFO。
  // （这条路径跑在 pump 的微任务里，异常逃逸出去会整进程退出。）
  let cfg: StudioConfig | null = null;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error("[调度] 读配置失败，本轮退化为先进先出", e);
  }
  const maxSkips = cfg?.localLaneAffinityMaxSkips ?? DEFAULT_AFFINITY_MAX_SKIPS;
  const head = localReady[0]!; // 入队最早的那条

  let chosen = head;
  // maxSkips = 0 即严格 FIFO（运维回退开关）；无先验、或配置读不到时同样退化成 FIFO
  if (cfg && maxSkips > 0 && lastLocalWeights && lastLocalWeights.size > 0) {
    // 已被插队到上限的那条必须放行，否则会饿死
    const starved = localReady.find((j) => (skipCount.get(j.id) ?? 0) >= maxSkips);
    if (starved) {
      chosen = starved;
    } else {
      let best = -1;
      for (const j of localReady) {
        const score = affinity(lastLocalWeights, weightsOf(workflowOf(cfg, j.provider), j.provider));
        if (score > best) {
          best = score;
          chosen = j;
        }
      }
    }
  }

  if (chosen !== head) {
    // 被插队的都记一笔——次数与换模代价同量纲，且能在桩测里确定性断言
    for (const j of localReady) {
      if (j === chosen) break;
      skipCount.set(j.id, (skipCount.get(j.id) ?? 0) + 1);
    }
  }
  // 指纹在这里就算好随 job 一起交出去：dispatchOnce 里那段「已改全局状态、
  // 尚未注册回收回调」的窗口必须不可抛，否则任务会永远卡在 running、租约没人还、
  // 且因为 controllers 里没有句柄而取消不掉。
  return { job: chosen, weights: cfg ? weightsOf(workflowOf(cfg, chosen.provider), chosen.provider) : null };
}

export function listJobs(projectId?: string): GenJob[] {
  return projectId ? jobs.filter((j) => j.projectId === projectId) : jobs;
}

/**
 * 清掉已结束任务的记录（前端的失败/告警横幅据 jobs 渲染，不清就一直挂着）。
 * 只动 done / error / canceled，queued 与 running 一律不碰——删在跑的任务会让调度器丢失状态。
 * 返回实际清掉的条数。
 */
export function dismissJobs(opts: { projectId?: string; ids?: string[] } = {}): number {
  const idSet = opts.ids?.length ? new Set(opts.ids) : undefined;
  let removed = 0;
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i]!;
    if (!isFinished(j.status)) continue;
    if (opts.projectId && j.projectId !== opts.projectId) continue;
    if (idSet && !idSet.has(j.id)) continue;
    jobs.splice(i, 1);
    skipCount.delete(j.id);
    removed++;
  }
  return removed;
}

/**
 * 中止一个任务。
 * queued 直接落 canceled（调度器不会再选它）；running 走 abort——
 * provider 侧的 fetch 应声而断，`runJob` 的 catch 认出 abort 落 canceled，
 * finally 照常释放 GPU 租约并 `pump()`，后面排队的立刻开跑。
 * 已结束的任务幂等返回，不报错。
 */
export function cancelJob(id: string): GenJob | null {
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  if (isFinished(job.status)) return job;
  if (job.status === "queued") {
    job.status = "canceled";
    job.finishedAt = Date.now();
    controllers.delete(job.id);
    skipCount.delete(job.id);
    return job;
  }
  controllers.get(job.id)?.abort(new Error("用户中止"));
  return job;
}

/** 批量中止某项目的在途任务；不跨项目。返回被动到的任务。 */
export function cancelProjectJobs(projectId: string): GenJob[] {
  return jobs
    .filter((j) => j.projectId === projectId && !isFinished(j.status))
    .map((j) => cancelJob(j.id))
    .filter((j): j is GenJob => j != null);
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
/** 派发循环在跑时又来了唤醒请求：记下来，让循环收尾前再扫一遍，而不是清掉守卫。 */
let pumpRequested = false;

/**
 * 派发一轮：把当前能开跑的都开起来。
 * **必须整体同步执行**——中途一旦 await，另一条派发循环就能在
 * `next.status = "running"` 落定之前挤进来，把同一个 job 派发两次。
 * 所以选取逻辑（含权重指纹查表）一律走同步 IO + 缓存，别改成 async。
 */
function dispatchOnce(): void {
  while (true) {
    const runningByLane: Record<Lane, number> = { local: 0, cloud: 0, mock: 0 };
    for (const j of jobs) if (j.status === "running") runningByLane[laneOf(j.provider)]++;
    const picked = pickNext(runningByLane);
    if (!picked) break;
    const next = picked.job;
    const lane = laneOf(next.provider);
    // 抢不到租约就收工，等下次唤醒。`continue` 会原地忙等——pickNext 的前置条件目前
    // 恰好走不到这一步，但那是运气，不该拿 CPU 空转做兜底。
    if (lane === "local" && !tryAcquireGpu("generation", next.id)) break;
    next.status = "running";
    next.startedAt = Date.now();
    // 从这里到 .finally 挂上为止必须【不可抛】：中途抛出会让任务永远停在 running、
    // GPU 租约没人归还、controllers 里也没句柄（取消不掉），local 车道被永久焊死。
    // 所以指纹是 pickNext 里算好的纯值，这里只做赋值。
    if (lane === "local") lastLocalWeights = picked.weights;
    skipCount.delete(next.id);
    const controller = new AbortController();
    controllers.set(next.id, controller);
    // 不 await 串死其他车道；每个 job 完成后再 pump
    void runJob(next, controller.signal).finally(() => {
      controllers.delete(next.id);
      if (lane === "local") releaseGpu(next.id);
      pump();
    });
    // local 车道串行：本轮已派 local 后继续找其他车道的活
  }
}

function pump() {
  // 先登记请求再看守卫：循环在跑时不清守卫（清掉就等于没守卫，两条循环会并存），
  // 而是让它收尾前多扫一遍，唤醒一次都不会丢。
  pumpRequested = true;
  if (pumping) return;
  pumping = true;
  queueMicrotask(() => {
    try {
      while (pumpRequested) {
        pumpRequested = false;
        // 调度器是全局单点，且这里跑在微任务里——异常逃逸出去会整进程退出，
        // 把「单任务可恢复错误」升级成「所有在途任务陪葬」。一律就地吞并打日志。
        try {
          dispatchOnce();
        } catch (e) {
          console.error("[调度] 派发轮出错，本轮跳过（队列不受影响）", e);
        }
      }
    } finally {
      pumping = false;
    }
  });
}

/** LoRA 租约释放后唤醒可能在等待的本地生成任务。 */
export function resumeGenerationPump(): void {
  // 训练刚占用过 GPU：显存里早不是我们上次留下的那组权重了，先前的指纹作废
  invalidateLocalWeights();
  pump();
}

async function runJob(job: GenJob, signal: AbortSignal) {
  try {
    const cfg = loadConfig();
    const p = getProject(job.projectId);
    if (!p) throw new Error("项目不存在");
    const style = p.styleId ? getStyle(p.styleId) : null;
    // 前缀含 job.id（内含全局递增 seq），杜绝同毫秒撞名覆盖
    const ts = artifactTs(Date.now(), job.id.split("-")[0]!);
    const comfyCommon = { signal, stallToleranceMs: cfg.comfyStallToleranceMs };
    let outputs: string[] = [];
    /** 按秒计价的出口（PixMind）记下实际计费秒数；其余出口留 undefined 走 prices 固定价 */
    let billedSec: number | undefined;

    // 角色参考图（人设锚点）：自成一支，产物直接落角色源图库，不涉及镜头。
    if (job.kind === "charref") {
      await runCharRefJob(job, p, style, cfg, ts, signal);
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
          ...comfyCommon,
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
          signal,
        });
      } else if (job.provider === "pixmind-image") {
        if (!cfg.pixmindKey) throw new Error("未配置 pixmindKey（PixMind API Key）");
        // multi-image 策略：多图直喂集，预算 14（nano-banana 系上限）
        const plan = assembleRefs(p, shot, style, cfg, job.provider);
        if (plan.warnings.length > 0) job.warnings = [...(job.warnings ?? []), ...plan.warnings];
        outputs = await pixmindImageGenerate({
          pixmindKey: cfg.pixmindKey,
          model: cfg.pixmindImageModel,
          prompt: buildKeyframePrompt(p, shot, style, plan),
          negative: buildKeyframeNegatives(p, style, shot),
          refImages: plan.refImages,
          refBudget: cfg.refPolicies[job.provider]?.refBudget,
          size: cfg.pixmindImageSize,
          width: cfg.keyframeWidth,
          height: cfg.keyframeHeight,
          outDir,
          outPrefix: prefix,
          signal,
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
      // 本地 comfy 系出口的种子提到分支外生成一次，并落进产物名：
      // 「这条是哪个出口、什么种子出的」成为磁盘上的事实，而不依赖界面状态。
      // 云出口无本地种子概念，命名保持原样。
      const seed = Math.floor(Math.random() * 2 ** 31);
      // 种子只在【本次真会被注进图】时才落进文件名。
      // 判据两条缺一不可：① 本地采样出口（云出口没有我方种子概念）；
      // ② 该槽的 nodeMap 登记了 seed —— comfyGenerate 对未登记的 seed 是静默跳过
      // （providers/comfyui.ts 的 `opts.seed != null && map.seed`），自带模板漏登记时
      // 图里跑的是模板写死的那个值。此时若照拼 `-s<seed>`，文件名就是磁盘上的假话，
      // 用户拿它复现只会得到无关结果。
      const seedInjected = laneOf(job.provider) === "local" && !!videoWorkflowOf(cfg, job.provider)?.nodeMap.seed;
      const prefix = seedInjected
        ? artifactPrefix(job.provider, ts, seed)
        : artifactPrefix(job.provider, ts);
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
          seed,
          width: cfg.videoWidth,
          height: cfg.videoHeight,
          frames: wanFrames(durationSec, cfg.videoFps),
          outDir,
          outPrefix: prefix,
          ...comfyCommon,
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
          seed,
          frames: wanFrames(durationSec, 24),
          outDir,
          outPrefix: prefix,
          ...comfyCommon,
        });
      } else if (job.provider === "h3-video") {
        if (!cfg.comfyVideoH3) throw new Error("未配置 H3 workflow（settings → comfyVideoH3）");
        if (!kfPath) throw new Error("该镜还没有 keyframe，先出图再出片");
        // H3 无负分支（权重已 CFG 蒸馏），不传 negative；固定 24fps，帧数按 17k+5 栅格吸附
        outputs = await comfyGenerate({
          comfyUrl: cfg.comfyUrl,
          wf: cfg.comfyVideoH3,
          prompt: pos,
          startImage: kfPath,
          seed,
          width: cfg.videoWidth,
          height: cfg.videoHeight,
          frames: h3Frames(durationSec),
          outDir,
          outPrefix: prefix,
          ...comfyCommon,
        });
      } else if (job.provider === "h3-video-final") {
        if (!cfg.comfyVideoH3Final) throw new Error("未配置 H3 成片档 workflow（settings → comfyVideoH3Final）");
        if (!kfPath) throw new Error("该镜还没有 keyframe，先出图再出片");
        // 与抽卡档同为无负分支、24fps、17k+5 栅格；差别在配方（步数/SigmaShift/加速 LoRA），
        // 全写死在模板图里。分辨率也归模板管，故不传 width/height（同混元档的先例）。
        outputs = await comfyGenerate({
          comfyUrl: cfg.comfyUrl,
          wf: cfg.comfyVideoH3Final,
          prompt: pos,
          startImage: kfPath,
          seed,
          frames: h3Frames(durationSec),
          outDir,
          outPrefix: prefix,
          ...comfyCommon,
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
          signal,
        });
      } else if (job.provider === "pixmind-video") {
        if (!cfg.pixmindKey) throw new Error("未配置 pixmindKey（PixMind API Key）");
        if (!kfPath) throw new Error("该镜还没有 keyframe，先出图再出片");
        // eco 线路无 negative 字段（supports.negativePrompt=false），不传负面；音轨默认开（核心能力）
        outputs = await pixmindVideoGenerate({
          pixmindKey: cfg.pixmindKey,
          model: cfg.pixmindVideoModel,
          prompt: pos,
          imagePath: kfPath,
          durationSec,
          resolution: cfg.pixmindVideoResolution,
          width: cfg.videoWidth,
          height: cfg.videoHeight,
          outDir,
          outPrefix: prefix,
          signal,
        });
        // 计费按实际请求秒数（与 provider 内的归一口径一致），不是镜头建议秒数
        billedSec = pixmindDuration(durationSec);
      } else {
        throw new Error(`未知 video provider: ${job.provider}`);
      }
      job.output = `videos/${shotKey(shot.index)}/${outputs[0]}`;
      const fresh = getProject(p.id)!;
      if (!getChoices(fresh, shot.index).video) setChoice(fresh, shot.index, "video", outputs[0]);
    }

    // 成本入账。PixMind 出片按秒计价（网关任务响应无价格快照字段，只能本地估算）；
    // 其余 provider 沿用 prices 的单条固定价。
    const cost = billedSec !== undefined
      ? Number((cfg.pixmindVideoPricePerSec * billedSec).toFixed(4))
      : cfg.prices[job.provider] ?? 0;
    if (cost > 0) {
      const fresh = getProject(p.id)!;
      fresh.costLedger.push({ at: Date.now(), provider: job.provider, kind: job.kind, shotIndex: shot.index, cost });
      saveProject(fresh);
    }
    job.status = "done";
  } catch (e) {
    // 用户中止不是失败：判据用 signal 而不是异常类型——provider 各自抛什么由它们决定，
    // 但「这次结束是不是用户按的」只有信号说了算。
    if (signal.aborted) {
      job.status = "canceled";
    } else {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
    }
    // 本地任务非正常结束（失速/孤儿/OOM/中止）后，「显存里装着什么」已不可推断，
    // 别拿一个作废的指纹去给下一轮排序
    if (laneOf(job.provider) === "local") invalidateLocalWeights();
  } finally {
    // 不可中断的 provider（mock）可能在 abort 之后才跑完；此时状态已是 canceled，不倒回 done。
    if (signal.aborted && job.status === "done") job.status = "canceled";
    job.finishedAt = Date.now();
  }
}

/** 角色参考图（人设锚点）生成：产物写角色源图库，即刻进双参考集。 */
async function runCharRefJob(job: GenJob, p: Project, style: StyleProfile | null, cfg: StudioConfig, ts: string, signal: AbortSignal) {
  const charName = job.charName;
  if (!charName) throw new Error("charref 任务缺少 charName");
  const character = p.doc.characters.find((c) => c.name === charName);
  if (!character) throw new Error(`角色不存在：${charName}`);
  const mode: CharRefMode = job.charRefMode ?? "single";
  const outDir = characterDir(p.id, charName);
  // mock 占位产物带 mock 标识，避免灰图混进真图堆被误当真产物
  const prefix = job.provider === "mock-image" ? `gen-mock-${mode}-${ts}` : `gen-${mode}-${ts}`;
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
      signal,
      stallToleranceMs: cfg.comfyStallToleranceMs,
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
      signal,
    });
  } else if (job.provider === "pixmind-image") {
    if (!cfg.pixmindKey) throw new Error("未配置 pixmindKey（PixMind API Key）");
    outputs = await pixmindImageGenerate({
      pixmindKey: cfg.pixmindKey,
      model: cfg.pixmindImageModel,
      prompt,
      negative,
      refImages: anchors,
      refBudget: cfg.refPolicies[job.provider]?.refBudget,
      size: cfg.pixmindImageSize,
      width: cfg.keyframeWidth,
      height: cfg.keyframeHeight,
      outDir,
      outPrefix: prefix,
      signal,
    });
  } else {
    throw new Error(`未知 charref provider: ${job.provider}（仅支持 comfyui-image / comfyui-image2 / seedream-image / pixmind-image / mock-image）`);
  }

  const file = outputs[0];
  if (!file || !listCharacterRefs(p.id, charName).includes(file)) {
    throw new Error("角色参考图产物未落入源图库");
  }
  job.output = `characters/${basename(outDir)}/${file}`;

  // single 产物本来就是单人图：无显式主参考时自动补位（整图），有则绝不覆盖
  if (mode === "single" && !refSetsOf(getProject(p.id)!).single[charName]) {
    await setCharacterGenerationReference(p.id, charName, { source: file });
  }

  const cost = cfg.prices[job.provider] ?? 0;
  if (cost > 0) {
    const fresh = getProject(p.id)!;
    fresh.costLedger.push({ at: Date.now(), provider: job.provider, kind: "charref", shotIndex: 0, cost });
    saveProject(fresh);
  }
}
