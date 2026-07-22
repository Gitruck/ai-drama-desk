// mock provider：离线验证全管线（无 GPU / 无 API key 时端到端跑通用）。
// keyframe = ffmpeg 纯色底+文字占位图；video = 以选中 keyframe 为底的缓推占位片段。
// 异步 spawn（不能 spawnSync：会把整批任务串死在一个微任务里冻结事件循环）；
// 先写 .part 临时名再 rename，防半截产物被当成品。

import { spawn } from "node:child_process";
import { renameSync } from "node:fs";
import { join } from "node:path";

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => reject(new Error(`ffmpeg 启动失败: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 失败: ${stderr.slice(0, 400)}`));
    });
  });
}

/** 写 <name>.part.<ext> 再 rename 成 <name>（listShotOutputs 会排除 .part） */
async function withPart(outDir: string, name: string, run: (tmpPath: string) => Promise<void>): Promise<string> {
  const tmp = `${name}.part${name.match(/\.[a-z0-9]+$/i)?.[0] ?? ""}`;
  await run(join(outDir, tmp));
  renameSync(join(outDir, tmp), join(outDir, name));
  return name;
}

export async function mockKeyframe(opts: {
  outDir: string;
  outPrefix: string;
  label: string;
  width: number;
  height: number;
}): Promise<string[]> {
  const name = `${opts.outPrefix}.png`;
  // 暖灰米底 + 标签文字（纯色占位示意图）；% 一并剥掉（drawtext 文本展开元字符）
  const text = opts.label.replace(/['"\\:%]/g, " ").slice(0, 40);
  await withPart(opts.outDir, name, (tmp) =>
    runFfmpeg([
      "-f", "lavfi",
      "-i", `color=c=0xE8E2D5:s=${opts.width}x${opts.height}`,
      "-vf", `drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':text='${text}':fontcolor=0x6B675F:fontsize=42:x=(w-text_w)/2:y=(h-text_h)/2`,
      "-frames:v", "1",
      "-f", "image2",
      tmp,
    ]),
  );
  return [name];
}

export async function mockVideo(opts: {
  outDir: string;
  outPrefix: string;
  imagePath?: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}): Promise<string[]> {
  const name = `${opts.outPrefix}.mp4`;
  const d = Math.max(1, Math.min(15, opts.durationSec));
  await withPart(opts.outDir, name, (tmp) => {
    if (opts.imagePath) {
      // 以 keyframe 为底做极缓推近（zoompan），模拟 I2V「首帧锁内容只赋运动」
      const frames = Math.round(d * opts.fps);
      return runFfmpeg([
        "-loop", "1",
        "-i", opts.imagePath,
        "-vf",
        `scale=${opts.width * 2}:${opts.height * 2},zoompan=z='1+0.04*on/${frames}':d=${frames}:s=${opts.width}x${opts.height}:fps=${opts.fps}`,
        "-t", String(d),
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264",
        "-f", "mp4",
        tmp,
      ]);
    }
    return runFfmpeg([
      "-f", "lavfi",
      "-i", `color=c=0xE8E2D5:s=${opts.width}x${opts.height}:r=${opts.fps}`,
      "-t", String(d),
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-f", "mp4",
      tmp,
    ]);
  });
  return [name];
}
