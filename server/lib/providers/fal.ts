// fal.ai 云出口（正片档溢出/高动作镜头）：queue API 提交 Wan I2V。
// 定价参考（2026-07）：Wan2.2 A14B 720p 约 $0.08/秒；成本记账走 config.prices。

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

interface FalVideoOpts {
  falKey: string;
  model: string; // 如 fal-ai/wan/v2.2-a14b/image-to-video
  prompt: string;
  negative?: string;
  imagePath: string;
  durationSec: number;
  fps: number;
  resolution: "480p" | "580p" | "720p";
  outDir: string;
  outPrefix: string;
  timeoutMs?: number;
  /** 用户中止信号：透传给全部 fetch，中止后不再等结果 */
  signal?: AbortSignal;
}

function toDataUri(p: string): string {
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[
    extname(p).toLowerCase()
  ];
  if (!mime) throw new Error(`不支持的首帧格式: ${p}`);
  return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
}

export async function falVideoGenerate(opts: FalVideoOpts): Promise<string[]> {
  const headers = { Authorization: `Key ${opts.falKey}`, "Content-Type": "application/json" };
  // wan v2.2 I2V 端点契约（官方 OpenAPI 实核）：num_frames(17–161, 默认81) + frames_per_second，无 duration 字段
  const numFrames = Math.max(17, Math.min(161, Math.round(opts.durationSec * opts.fps)));
  const submit = await fetch(`https://queue.fal.run/${opts.model}`, {
    method: "POST",
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      prompt: opts.prompt,
      negative_prompt: opts.negative,
      image_url: toDataUri(opts.imagePath),
      resolution: opts.resolution,
      num_frames: numFrames,
      frames_per_second: opts.fps,
    }),
  });
  if (!submit.ok) throw new Error(`fal 提交失败: ${submit.status} ${await submit.text()}`);
  const sub = (await submit.json()) as { request_id: string; status_url?: string; response_url?: string };

  // 兜底 URL 只能用 app 基址（model 路径前两段），不能带子路径
  const appBase = opts.model.split("/").slice(0, 2).join("/");
  const statusUrl = sub.status_url ?? `https://queue.fal.run/${appBase}/requests/${sub.request_id}/status`;
  const responseUrl = sub.response_url ?? `https://queue.fal.run/${appBase}/requests/${sub.request_id}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    opts.signal?.throwIfAborted();
    const st = await fetch(statusUrl, { headers: { Authorization: headers.Authorization }, signal: opts.signal });
    if (!st.ok) continue;
    const js = (await st.json()) as { status: string };
    if (js.status === "COMPLETED") {
      const res = await fetch(responseUrl, { headers: { Authorization: headers.Authorization }, signal: opts.signal });
      if (!res.ok) throw new Error(`fal 取结果失败: ${res.status} ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as any;
      const url: string | undefined = body?.video?.url ?? body?.videos?.[0]?.url;
      if (!url) throw new Error(`fal 响应里没有视频 URL: ${JSON.stringify(body).slice(0, 300)}`);
      const dl = await fetch(url, { signal: opts.signal });
      if (!dl.ok) throw new Error(`fal 结果下载失败: ${dl.status}（结果链接可能已过期）`);
      const buf = new Uint8Array(await dl.arrayBuffer());
      const name = `${opts.outPrefix}.mp4`;
      // 先写 .part 再 rename，防半截文件被当成品
      const tmp = `${name}.part.mp4`;
      writeFileSync(join(opts.outDir, tmp), buf);
      renameSync(join(opts.outDir, tmp), join(opts.outDir, name));
      return [name];
    }
  }
  throw new Error("fal 生成超时");
}
