// 导出：命名遵循 return-v1 草案（wip/ai-drama-pipeline-research/07-查漏补证.md）
//   <slug>-<beatId>-s<n>.mp4 → exports/aidrama/，ffprobe 实测时长，manifest 记录
//   建议秒数 vs 实测时长差值（回轨手动对齐时的参考）。

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffprobe } from "./ffprobe.ts";
import { getChoices, listShotOutputs, projectDir, shotKey } from "./projects.ts";
import type { Project } from "./types.ts";

export interface ExportItem {
  shotIndex: number;
  file: string;
  /** 产出本条的源候选文件名（候选墙上那个名字）——回落时用户靠它认出这次用的是哪一条 */
  sourceFile: string;
  suggestedSec: number | null;
  measuredSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  deltaSec: number | null;
  /** 导出文件是否带音轨——回轨时据此判断会不会与口播轨叠声 */
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  /** 源候选带音轨但按策略被剥离（想找回改开关重导即可，不必重新出片） */
  audioStripped: boolean;
  /** 选中产物已丢失、本条是回落到的其余候选时，记下丢失的那个选中文件名（正常导出为 null） */
  fallbackFrom: string | null;
}

/** 没能产出导出文件的镜。reason 是可直接展示给用户的中文整句，Web / CLI 不再各自拼文案。 */
export interface ExportSkip {
  shotIndex: number;
  /** 悬空的选中文件名；该镜从未选过任何产物时为 null */
  lostChoice: string | null;
  reason: string;
}

export interface ExportManifest {
  slug: string;
  beatId: string;
  exportedAt: string;
  trackSt?: number;
  trackEd?: number;
  totalSuggestedSec: number;
  totalMeasuredSec: number;
  totalCost: number;
  /** 本次导出的音轨策略，写进包里自证 */
  keepAudio: boolean;
  items: ExportItem[];
  /** 未产出导出文件的镜序号。字段名与语义是 agent 的机读契约（AGENT.md §3），只增不改。 */
  skipped: number[];
  /** 与 skipped 同序同长：逐条中文原因，区分「选中产物已丢失」与「本来就没出过片」 */
  skippedDetail: ExportSkip[];
}

/**
 * 流拷贝去音轨：不重编码、不动画面（视频流逐字节一致）。
 * 失败则回落到整文件复制并如实上报仍带音轨，绝不静默产出空文件。
 */
function copyWithoutAudio(src: string, dst: string): boolean {
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-map", "0:v", "-c", "copy", "-an", dst],
    { encoding: "utf-8", windowsHide: true },
  );
  if (r.status === 0 && existsSync(dst)) return true;
  if (existsSync(dst)) rmSync(dst, { force: true });
  copyFileSync(src, dst);
  return false;
}

export function exportProject(p: Project, opts: { keepAudio?: boolean } = {}): ExportManifest {
  const keepAudio = opts.keepAudio ?? false;
  // beatId 可能来自手工 shots.json / UI 补齐，进文件名前必须消毒
  const beat = (p.doc.beatId || "b00").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "b00";
  const slug = p.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "") || p.id;
  const outDir = join(projectDir(p.id), "exports", "aidrama");
  mkdirSync(outDir, { recursive: true });

  const items: ExportItem[] = [];
  const skipped: number[] = [];
  const skippedDetail: ExportSkip[] = [];
  const skip = (shotIndex: number, lostChoice: string | null, reason: string) => {
    skipped.push(shotIndex);
    skippedDetail.push({ shotIndex, lostChoice, reason });
  };

  for (const shot of p.doc.shots) {
    // 选中项以文件系统为准：choices 是 project.json 里的持久指针，产物被删 / 手工清盘 / 换机器后会悬空。
    // 悬空是良性状态（磁盘是事实、指针只是过期记录），该回落上报，不该把整包导出炸掉。
    const choice = getChoices(p, shot.index).video ?? null;
    // 直接拼路径而不用 shotDir()——那个会 mkdir，导出对项目目录应当只读
    const dir = join(projectDir(p.id), "videos", shotKey(shot.index));
    const chosenAlive = choice != null && existsSync(join(dir, choice));
    // 回落只取第一个候选，不猜「最新」「最像」——挑片权是用户的，回落只为这一镜别空着
    const chosen = chosenAlive ? choice : listShotOutputs(p.id, "videos", shot.index)[0];
    const fallbackFrom = chosenAlive ? null : choice;
    if (!chosen) {
      skip(
        shot.index,
        choice,
        choice
          ? `s${shot.index} 选中的产物「${choice}」已不在盘上，该镜也没有其余候选，已跳过（需重新出片）`
          : `s${shot.index} 没有任何视频产物，已跳过`,
      );
      continue;
    }
    const src = join(dir, chosen);
    const ext = chosen.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp4";
    const name = `${slug}-${beat}-s${shot.index}${ext}`;
    const dst = join(outDir, name);
    // 先探源：决定要不要剥音轨，并留下「源本来有音轨」这个事实供 manifest 提示
    const srcHasAudio = ffprobe(src).hasAudio;
    try {
      if (srcHasAudio && !keepAudio) copyWithoutAudio(src, dst);
      else copyFileSync(src, dst);
    } catch (e) {
      // 复制失败（被占用 / 磁盘满 / 刚好被删）同样只连坐这一镜，其余镜照导；
      // 底层错误摘要留在 reason 尾部，用来区分「产物丢了」和「产物在但写不出去」。
      skip(shot.index, fallbackFrom, `s${shot.index} 的候选「${chosen}」复制失败，已跳过该镜：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const probe = ffprobe(dst);
    items.push({
      shotIndex: shot.index,
      file: name,
      sourceFile: chosen,
      suggestedSec: shot.durationSec,
      measuredSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      deltaSec:
        probe.durationSec != null && shot.durationSec != null
          ? Math.round((probe.durationSec - shot.durationSec) * 100) / 100
          : null,
      hasAudio: probe.hasAudio,
      audioCodec: probe.audioCodec,
      audioSampleRate: probe.audioSampleRate,
      audioChannels: probe.audioChannels,
      audioStripped: srcHasAudio && !probe.hasAudio,
      fallbackFrom,
    });
  }

  const manifest: ExportManifest = {
    slug: p.slug,
    beatId: p.doc.beatId || "b00",
    exportedAt: new Date().toISOString(),
    trackSt: p.doc.trackSt,
    trackEd: p.doc.trackEd,
    totalSuggestedSec: p.doc.shots.reduce((a, s) => a + (s.durationSec ?? 0), 0),
    totalMeasuredSec: Math.round(items.reduce((a, i) => a + (i.measuredSec ?? 0), 0) * 100) / 100,
    totalCost: Math.round(p.costLedger.reduce((a, c) => a + c.cost, 0) * 100) / 100,
    keepAudio,
    items,
    skipped,
    skippedDetail,
  };

  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, "manifest.md"), manifestMd(manifest));
  return manifest;
}

function manifestMd(m: ExportManifest): string {
  const withAudio = m.items.filter((i) => i.hasAudio);
  const stripped = m.items.filter((i) => i.audioStripped);
  const fellBack = m.items.filter((i) => i.fallbackFrom);
  const lines = [
    `# AI 再现导出清单 · beat ${m.beatId}`,
    "",
    `- 导出时间：${m.exportedAt}`,
    m.trackSt != null ? `- 回轨区间：${m.trackSt}s → ${m.trackEd}s（对齐时以此为准，超出裁齐）` : null,
    `- 建议总时长：${m.totalSuggestedSec}s ｜ 实测总时长：${m.totalMeasuredSec}s`,
    `- 本项目累计生成成本：¥${m.totalCost}`,
    `- 音轨策略：${m.keepAudio ? "保留" : "剥离"}`,
    stripped.length
      ? `- 已剥离 ${stripped.length} 条自带音轨（s${stripped.map((i) => i.shotIndex).join(", s")}）。片段自带的原生音轨仍在项目候选里，改设置 \`exportKeepAudio\` 后重导即可找回，不必重新出片。`
      : null,
    withAudio.length
      ? `- ⚠️ 有 ${withAudio.length} 条片段带音轨（s${withAudio.map((i) => i.shotIndex).join(", s")}）。拖回 NLE 时会与口播轨叠声，按需静音或解除音视频链接。`
      : null,
    fellBack.length
      ? [
          `- ⚠️ 有 ${fellBack.length} 个镜的选中产物已丢失，已回落到该镜其余候选——**这不是你挑的那条**，回工作台可重挑或重出：`,
          ...fellBack.map((i) => `  - s${i.shotIndex}：原选中「${i.fallbackFrom}」已不在盘上 → 本次用了「${i.sourceFile}」，导出为 ${i.file}`),
        ].join("\n")
      : null,
    m.skippedDetail.length
      ? [`- ⚠️ 未导出的分镜：`, ...m.skippedDetail.map((d) => `  - ${d.reason}`)].join("\n")
      : null,
    "",
    "| 镜 | 文件 | 建议 | 实测 | 差值 | 分辨率 | 音轨 |",
    "|---|---|---|---|---|---|---|",
    ...m.items.map((i) => {
      const audio = i.hasAudio
        ? `${i.audioCodec ?? "有"} ${i.audioSampleRate ? i.audioSampleRate / 1000 + "k" : ""}${i.audioChannels === 2 ? " 立体声" : i.audioChannels ? " " + i.audioChannels + "ch" : ""}`.trim()
        : i.audioStripped
          ? "已剥离"
          : "无";
      return `| s${i.shotIndex} | ${i.file}${i.fallbackFrom ? " ⚠️回落" : ""} | ${i.suggestedSec ?? "-"}s | ${i.measuredSec?.toFixed(2) ?? "?"}s | ${i.deltaSec ?? "?"}s | ${i.width}×${i.height} | ${audio} |`;
    }),
    "",
    "> 下一步：540p 抽卡满意的镜，可先放大到 720p 后替换；再把片段拖回你的 NLE，按 beat 区间对齐。",
  ];
  return lines.filter((l) => l != null).join("\n");
}
