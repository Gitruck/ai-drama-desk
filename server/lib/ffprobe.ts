import { spawnSync } from "node:child_process";

export interface ProbeResult {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** 是否含音轨。H3 出片自带原生立体声，回轨时会与口播轨叠声，manifest 必须标出来 */
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
}

const EMPTY: ProbeResult = {
  durationSec: null,
  width: null,
  height: null,
  fps: null,
  hasAudio: false,
  audioCodec: null,
  audioSampleRate: null,
  audioChannels: null,
};

/** ffprobe 实测（回轨契约要求：时长以实测为准，不信平台口径） */
export function ffprobe(file: string): ProbeResult {
  const r = spawnSync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) return { ...EMPTY };
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams ?? []).find((s: any) => s.codec_type === "video");
    const a = (j.streams ?? []).find((s: any) => s.codec_type === "audio");
    let fps: number | null = null;
    if (v?.avg_frame_rate && v.avg_frame_rate !== "0/0") {
      const [x, y] = v.avg_frame_rate.split("/").map(Number);
      if (y) fps = x / y;
    }
    return {
      durationSec: j.format?.duration ? parseFloat(j.format.duration) : null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps,
      hasAudio: !!a,
      audioCodec: a?.codec_name ?? null,
      audioSampleRate: a?.sample_rate ? parseInt(a.sample_rate, 10) : null,
      audioChannels: a?.channels ?? null,
    };
  } catch {
    return { ...EMPTY };
  }
}
