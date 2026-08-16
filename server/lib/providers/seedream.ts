// 火山方舟 Seedream 图像出口（路径C：云端 keyframe）。
// 契约经官方文档核实（docs.volcengine.com/docs/82379/1541523，2026-07-15 版）：
//   - 参考图字段是 `image`（string|string[]，URL 或小写 mime 的 data URI），5.0 Pro 上限 10 张
//   - 没有 seed、没有 negative_prompt（负面只能并入 prompt 文本）
//   - size 像素下限逐模型不同：4.5/5.0-lite 拒绝 <3,686,400px（720p 直接报错）；
//     5.0 Pro 下限 921,600px（=1280x720），≤236 万像素 0.30 元/张、超出跳 0.60 元
//   - response_format 用 b64_json 规避「URL 24 小时过期」
//   - watermark 默认 true，必须显式 false

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

interface SeedreamOpts {
  arkApiKey: string;
  model: string;
  prompt: string;
  /** 无 negative 字段，并入 prompt 文本 */
  negative?: string;
  refImages: string[];
  size: string;
  outDir: string;
  outPrefix: string;
  timeoutMs?: number;
  /** 用户中止信号：与单次请求超时并成一个信号 */
  signal?: AbortSignal;
}

/** 用户中止信号 + 单次请求超时，任一触发即断 */
function reqSignal(ms: number, user?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return user ? AbortSignal.any([user, timeout]) : timeout;
}

function toDataUri(p: string): string {
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[
    extname(p).toLowerCase()
  ];
  if (!mime) throw new Error(`不支持的参考图格式: ${p}`);
  return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
}

export async function seedreamGenerate(opts: SeedreamOpts): Promise<string[]> {
  const prompt = opts.negative ? `${opts.prompt}\n画面中避免出现：${opts.negative}` : opts.prompt;
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt,
    size: opts.size,
    response_format: "b64_json",
    watermark: false,
  };
  if (opts.refImages.length > 0) body.image = opts.refImages.slice(0, 10).map(toDataUri);
  // output_format 仅 5.0 Pro/lite 支持，4.5/4.0 传了会拒
  if (/seedream-5-0/.test(opts.model)) body.output_format = "png";

  const res = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.arkApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: reqSignal(opts.timeoutMs ?? 180_000, opts.signal),
  });
  if (!res.ok) throw new Error(`Seedream 请求失败: ${res.status} ${(await res.text()).slice(0, 400)}`);
  const j = (await res.json()) as {
    data?: { b64_json?: string; url?: string; size?: string; error?: { code: string; message: string } }[];
    usage?: { generated_images?: number };
  };
  const item = j.data?.[0];
  if (!item) throw new Error(`Seedream 响应无 data: ${JSON.stringify(j).slice(0, 300)}`);
  if (item.error) throw new Error(`Seedream 出图失败: ${item.error.code} ${item.error.message}`);

  let buf: Uint8Array;
  if (item.b64_json) {
    buf = Uint8Array.from(Buffer.from(item.b64_json, "base64"));
  } else if (item.url) {
    const dl = await fetch(item.url, { signal: reqSignal(120_000, opts.signal) });
    if (!dl.ok) throw new Error(`Seedream 结果下载失败: ${dl.status}`);
    buf = new Uint8Array(await dl.arrayBuffer());
  } else {
    throw new Error("Seedream 响应既无 b64_json 也无 url");
  }

  const ext = /seedream-5-0/.test(opts.model) ? ".png" : ".jpg";
  const name = `${opts.outPrefix}${ext}`;
  const tmp = `${name}.part${ext}`;
  writeFileSync(join(opts.outDir, tmp), buf);
  renameSync(join(opts.outDir, tmp), join(opts.outDir, name));
  return [name];
}
