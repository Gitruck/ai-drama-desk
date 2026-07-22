import { spawnSync } from "node:child_process";

export interface ProbeResult {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

/** ffprobe 实测（回轨契约要求：时长以实测为准，不信平台口径） */
export function ffprobe(file: string): ProbeResult {
  const r = spawnSync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) return { durationSec: null, width: null, height: null, fps: null };
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams ?? []).find((s: any) => s.codec_type === "video");
    let fps: number | null = null;
    if (v?.avg_frame_rate && v.avg_frame_rate !== "0/0") {
      const [a, b] = v.avg_frame_rate.split("/").map(Number);
      if (b) fps = a / b;
    }
    return {
      durationSec: j.format?.duration ? parseFloat(j.format.duration) : null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps,
    };
  } catch {
    return { durationSec: null, width: null, height: null, fps: null };
  }
}
