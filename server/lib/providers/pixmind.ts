// PixMind 云出口（合作方统一网关，一次接入可切全目录模型）：出片 + 出图两条链路共享同一 submit→poll→下载核心。
//
// 契约经真机取证（2026-08-17，见 openspec/changes/add-pixmind-cloud-outlet/evidence/）：
//   - 端点 POST {base}/generations 建单，GET {base}/tasks/{taskId} 轮询；base 默认 aihub-admin.aimix.pro/api-platform/v1
//   - 受理响应是 {code:1000, data:{taskId, status}} 信封；code≠1000 时 HTTP 仍是 200，故 MUST 判 code 不判 res.ok
//   - status 实测三档：processing（受理）→ pending（执行中）→ ready | failed。
//     `pending` 官方文档未列，早期实现漏它会把在跑的任务当未知状态；这里按「非终态即继续」处理。
//   - 产物：视频在 data.videoUrl（另有 coverUrl 封面，本工作台不消费）、图片在 data.images[]
//   - 产物域名是 chatmix.top、推定有时效 ⇒ 立即下载落盘，绝不存 URL 复用
//   - 参考图收 base64 data URI（视频 imageUrl / 图片 reference_images[]）。注意网关 /v1/models 把视频线路的
//     acceptType 声明为 "url"，属保守声明——实测 data URI 被受理且 description 回显 hasImage:true、出片首帧确为参考图
//   - 任务响应里没有任何价格字段（官方文档称「已受理响应是最终价格快照」不成立）⇒ 成本走本地估算，见 queue 记账
//   - 字段拼写：视频侧用驼峰（imageUrl/aspectRatio，对齐官方 reference），图片侧蛇形（size/aspect_ratio/
//     reference_images）被网关接受并内部归一为 image_size/aspectRatio

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { ProviderError } from "../failure.ts";
import { extname, join } from "node:path";

export const PIXMIND_BASE = "https://aihub-admin.aimix.pro/api-platform/v1";

/** eco 线路支持的时长档：4–15 秒整数（durationConfig.supportedDurations 实核） */
const DURATION_MIN = 4;
const DURATION_MAX = 15;

/** 官方支持的画幅枚举（supportedAspectRatios 实核） */
const ASPECT_RATIOS: [string, number][] = [
  ["21:9", 21 / 9],
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["1:1", 1],
  ["3:4", 3 / 4],
  ["9:16", 9 / 16],
];

interface PixmindCommon {
  pixmindKey: string;
  model: string;
  prompt: string;
  outDir: string;
  outPrefix: string;
  timeoutMs?: number;
  /** 轮询间隔；留缝是为了让测试把等待压到毫秒级（对齐 comfyui.ts 的 pollIntervalMs） */
  pollIntervalMs?: number;
  /** 用户中止信号：透传全部 fetch，中止后不再等结果 */
  signal?: AbortSignal;
  baseUrl?: string;
}

interface PixmindVideoOpts extends PixmindCommon {
  /** 首帧图（本地路径）；缺省即纯文生视频 */
  imagePath?: string;
  durationSec: number;
  resolution: string;
  /** 项目画布，用于映射 aspectRatio */
  width: number;
  height: number;
  /** 是否生成原生音轨（eco 的核心能力，默认 true） */
  generateAudio?: boolean;
}

interface PixmindImageOpts extends PixmindCommon {
  /**
   * 负面描述。网关 supports.negativePrompt 为 true，但请求侧字段名未取证
   * （Playground 不暴露该输入），故沿用 seedream 的做法并入 prompt 文本，
   * 不赌一个没验证过的字段名。取证到字段名后可改为独立字段。
   */
  negative?: string;
  refImages: string[];
  /** 分辨率档位，如 1K / 2K / 4K */
  size: string;
  width: number;
  height: number;
  /** 单次请求携带的参考图上限（由 refPolicies.refBudget 传入） */
  refBudget?: number;
}

/** 时长归一：四舍五入后夹进 [4,15]；非法输入回落 API 缺省档 4 */
export function pixmindDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return DURATION_MIN;
  return Math.max(DURATION_MIN, Math.min(DURATION_MAX, Math.round(durationSec)));
}

/** 画幅归一：取与实际宽高比最接近的官方枚举（960×544 → 16:9） */
export function pixmindAspect(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "16:9";
  const target = width / height;
  let best = ASPECT_RATIOS[0]!;
  for (const cand of ASPECT_RATIOS) {
    if (Math.abs(cand[1] - target) < Math.abs(best[1] - target)) best = cand;
  }
  return best[0];
}

function toDataUri(p: string): string {
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[
    extname(p).toLowerCase()
  ];
  if (!mime) throw new ProviderError("content", `不支持的参考图格式: ${p}`);
  return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
}

/** 用户中止信号 + 单次请求超时，任一触发即断（对齐 seedream.ts；fal.ts 缺这层） */
function reqSignal(ms: number, user?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return user ? AbortSignal.any([user, timeout]) : timeout;
}

interface Envelope<T> {
  code?: number;
  message?: string;
  data?: T | null;
}

interface TaskData {
  taskId?: number | string;
  status?: string;
  progress?: number;
  videoUrl?: string | null;
  coverUrl?: string | null;
  images?: string[] | null;
  description?: string;
}

/** 网关的错误信封：HTTP 200 但 code≠1000。文案原样带出，便于识别「不支持的模型」这类路由级拒绝。 */
function unwrap<T>(js: Envelope<T>, what: string): T {
  if (js.code !== undefined && js.code !== 1000) {
    throw new Error(`PixMind ${what}失败: code=${js.code} ${js.message ?? ""}`.trim());
  }
  if (!js.data) throw new Error(`PixMind ${what}响应无 data: ${JSON.stringify(js).slice(0, 300)}`);
  return js.data;
}

/**
 * 轮询期的瞬时网关错误码：限流（1001，实测「每 minute 最多 60 次请求」，该配额按 Key 计、
 * 与本工作台之外的调用共享）。这类错误 MUST NOT 判任务死——上游任务还在跑、钱已经花了，
 * 本地把它判失败等于白烧一次生成。判据只认两件事：任务自己报 failed，或总 deadline 到点。
 */
const TRANSIENT_CODES = new Set([1001, 429, 500, 502, 503, 504]);

async function submit(opts: PixmindCommon, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${opts.baseUrl ?? PIXMIND_BASE}/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.pixmindKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: reqSignal(opts.timeoutMs ?? 120_000, opts.signal),
  });
  if (!res.ok) throw new ProviderError("transient", `PixMind 提交失败: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = unwrap<TaskData>((await res.json()) as Envelope<TaskData>, "提交");
  const taskId = data.taskId;
  if (taskId === undefined || taskId === null || taskId === "") {
    throw new ProviderError("cloud-billed", `PixMind 受理响应里没有 taskId（网关可能已建单，费用可能已产生）: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return String(taskId);
}

/** 终态判定：ready 为成功态；succeeded/success 是防御性别名（网关未来若改口径不至于死等） */
function isReady(status: string): boolean {
  return ["ready", "succeeded", "success", "completed"].includes(status);
}
function isFailed(status: string): boolean {
  return ["failed", "cancelled", "canceled", "error"].includes(status);
}

async function poll(opts: PixmindCommon, taskId: string): Promise<TaskData> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  const base = opts.pollIntervalMs ?? 10_000;
  let wait = base;
  /** 连续「非瞬时」信封错误的次数：容忍偶发，但不无限期忍受真错（如任务不存在） */
  let hardErrors = 0;
  let lastNote = "";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    opts.signal?.throwIfAborted();
    const res = await fetch(`${opts.baseUrl ?? PIXMIND_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${opts.pixmindKey}` },
      signal: reqSignal(60_000, opts.signal),
    });
    // 轮询期的偶发非 200 不当失败：下一轮再问（长任务不该被一次抖动打断）
    if (!res.ok) {
      lastNote = `HTTP ${res.status}`;
      wait = Math.min(wait * 2, 60_000);
      continue;
    }

    const js = (await res.json()) as Envelope<TaskData>;
    if (js.code !== undefined && js.code !== 1000) {
      lastNote = `code=${js.code} ${js.message ?? ""}`.trim();
      if (TRANSIENT_CODES.has(js.code)) {
        // 限流/网关抖动：退避后继续问。绝不在这里判死——上游任务还在跑、费用已产生。
        wait = Math.min(wait * 2, 60_000);
        continue;
      }
      if (++hardErrors >= 3) {
        throw new ProviderError("cloud-billed", `PixMind 查询任务 ${taskId} 失败（单已建、费用已产生，勿重试）: ${lastNote}`);
      }
      wait = Math.min(wait * 2, 60_000);
      continue;
    }

    hardErrors = 0;
    wait = base; // 恢复正常后回到基础间隔
    const data = js.data;
    if (!data) {
      lastNote = "响应无 data";
      continue;
    }
    const status = String(data.status ?? "");
    if (isReady(status)) return data;
    if (isFailed(status)) {
      throw new ProviderError("cloud-billed", `PixMind 任务 ${taskId} ${status}${data.description ? `：${data.description.slice(0, 200)}` : ""}（费用已产生）`);
    }
    // 其余（processing / pending / 未知新状态）继续等
  }
  // 超时也要把 taskId 带出来：任务可能已在上游出好，凭 id 可人工找回，别让付费产物失联
  throw new ProviderError("cloud-billed", `PixMind 生成超时（任务 ${taskId}${lastNote ? `，最后一次响应：${lastNote}` : ""}，费用已产生）`);
}

async function download(url: string, outDir: string, name: string, ext: string, signal?: AbortSignal): Promise<string> {
  const dl = await fetch(url, { signal: reqSignal(300_000, signal) });
  if (!dl.ok) throw new Error(`PixMind 结果下载失败: ${dl.status}（结果链接可能已过期）`);
  const buf = new Uint8Array(await dl.arrayBuffer());
  // 先写 .part 再 rename，防半截文件被当成品
  const tmp = `${name}.part${ext}`;
  writeFileSync(join(outDir, tmp), buf);
  renameSync(join(outDir, tmp), join(outDir, name));
  return name;
}

export async function pixmindVideoGenerate(opts: PixmindVideoOpts): Promise<string[]> {
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    duration: pixmindDuration(opts.durationSec),
    resolution: opts.resolution,
    aspectRatio: pixmindAspect(opts.width, opts.height),
    generateAudio: opts.generateAudio ?? true,
  };
  if (opts.imagePath) body.imageUrl = toDataUri(opts.imagePath);

  const taskId = await submit(opts, body);
  const data = await poll(opts, taskId);
  const url = data.videoUrl ?? undefined;
  if (!url) throw new Error(`PixMind 任务 ${taskId} 无视频 URL: ${JSON.stringify(data).slice(0, 300)}`);
  const name = await download(url, opts.outDir, `${opts.outPrefix}.mp4`, ".mp4", opts.signal);
  return [name];
}

export async function pixmindImageGenerate(opts: PixmindImageOpts): Promise<string[]> {
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.negative ? `${opts.prompt}\n画面中避免出现：${opts.negative}` : opts.prompt,
    size: opts.size,
    aspect_ratio: pixmindAspect(opts.width, opts.height),
  };
  const budget = opts.refBudget ?? 14;
  if (opts.refImages.length > 0) body.reference_images = opts.refImages.slice(0, budget).map(toDataUri);

  const taskId = await submit(opts, body);
  const data = await poll(opts, taskId);
  const url = data.images?.[0];
  if (!url) throw new Error(`PixMind 任务 ${taskId} 无图片 URL: ${JSON.stringify(data).slice(0, 300)}`);
  const ext = /\.jpe?g(\?|$)/i.test(url) ? ".jpg" : ".png";
  const name = await download(url, opts.outDir, `${opts.outPrefix}${ext}`, ext, opts.signal);
  return [name];
}
