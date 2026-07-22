// 导出：命名遵循 return-v1 草案（wip/ai-drama-pipeline-research/07-查漏补证.md）
//   <slug>-<beatId>-s<n>.mp4 → exports/aidrama/，ffprobe 实测时长，manifest 记录
//   建议秒数 vs 实测时长差值（回轨手动对齐时的参考）。

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffprobe } from "./ffprobe.ts";
import { getChoices, listShotOutputs, projectDir, shotDir } from "./projects.ts";
import type { Project } from "./types.ts";

export interface ExportItem {
  shotIndex: number;
  file: string;
  suggestedSec: number | null;
  measuredSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  deltaSec: number | null;
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
  items: ExportItem[];
  skipped: number[];
}

export function exportProject(p: Project): ExportManifest {
  // beatId 可能来自手工 shots.json / UI 补齐，进文件名前必须消毒
  const beat = (p.doc.beatId || "b00").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "b00";
  const slug = p.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "") || p.id;
  const outDir = join(projectDir(p.id), "exports", "aidrama");
  mkdirSync(outDir, { recursive: true });

  const items: ExportItem[] = [];
  const skipped: number[] = [];

  for (const shot of p.doc.shots) {
    const chosen = getChoices(p, shot.index).video ?? listShotOutputs(p.id, "videos", shot.index)[0];
    if (!chosen) {
      skipped.push(shot.index);
      continue;
    }
    const src = join(shotDir(p.id, "videos", shot.index), chosen);
    const ext = chosen.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp4";
    const name = `${slug}-${beat}-s${shot.index}${ext}`;
    const dst = join(outDir, name);
    copyFileSync(src, dst);
    const probe = ffprobe(dst);
    items.push({
      shotIndex: shot.index,
      file: name,
      suggestedSec: shot.durationSec,
      measuredSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      deltaSec:
        probe.durationSec != null && shot.durationSec != null
          ? Math.round((probe.durationSec - shot.durationSec) * 100) / 100
          : null,
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
    items,
    skipped,
  };

  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, "manifest.md"), manifestMd(manifest));
  return manifest;
}

function manifestMd(m: ExportManifest): string {
  const lines = [
    `# AI 再现导出清单 · beat ${m.beatId}`,
    "",
    `- 导出时间：${m.exportedAt}`,
    m.trackSt != null ? `- 回轨区间：${m.trackSt}s → ${m.trackEd}s（对齐时以此为准，超出裁齐）` : null,
    `- 建议总时长：${m.totalSuggestedSec}s ｜ 实测总时长：${m.totalMeasuredSec}s`,
    `- 本项目累计生成成本：¥${m.totalCost}`,
    m.skipped.length ? `- ⚠️ 未导出（无视频）的分镜：${m.skipped.join(", ")}` : null,
    "",
    "| 镜 | 文件 | 建议 | 实测 | 差值 | 分辨率 |",
    "|---|---|---|---|---|---|",
    ...m.items.map(
      (i) =>
        `| s${i.shotIndex} | ${i.file} | ${i.suggestedSec ?? "-"}s | ${i.measuredSec?.toFixed(2) ?? "?"}s | ${i.deltaSec ?? "?"}s | ${i.width}×${i.height} |`,
    ),
    "",
    "> 下一步：540p 抽卡满意的镜，可先放大到 720p 后替换；再把片段拖回你的 NLE，按 beat 区间对齐。",
  ];
  return lines.filter((l) => l != null).join("\n");
}
