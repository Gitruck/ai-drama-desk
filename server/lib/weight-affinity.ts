/**
 * 权重亲和：判断两个出口吃的是不是同一组模型权重，用于 local 车道排序。
 *
 * 为什么需要它——本机实测（见 openspec 的 add-local-lane-weight-affinity/evidence）：
 * local 车道每切换一次 provider，要从磁盘重读整组权重 30–34 GiB、多花 13–20 秒，
 * 40 次换 provider 提交里命中缓存 0 次。而三重物理天花板锁死了「让两组常驻」这条路
 * （显存装不下单组的 DiT+TE、RAM 装不下两组、pinned 预算装不下任一单组），
 * 所以唯一杠杆是减少切换次数。
 *
 * 亲和度用【交集大小】而不是「同组/不同组」二元判据，好处是零配置自然分桶：
 *   h3-video ↔ h3-video-final  共用 DiT+TE+双 VAE、只差 LoRA ⇒ 交集 4，同桶
 *   h3-video ↔ comfyui-video   毫无重合                    ⇒ 交集 0，拉开
 *   comfyui-image ↔ image2     同底模、只差画风 LoRA        ⇒ 同桶
 * 用户自带模板不必登记任何新键就能参与排序——对齐 minimax-h3-video-outlet 那条
 * 「配方差异 MUST NOT 通过扩充 ComfyNodeMap 实现」的既有纪律。
 *
 * **本模块一律同步 IO**：调用点在 queue.ts 的派发循环里，那个循环必须整体同步，
 * 中途 await 会让两条循环交错、把同一个 job 派发两次。
 */
import { readFileSync, statSync } from "node:fs";
import { TEMPLATES_DIR } from "./config.ts";
import { resolve, sep } from "node:path";
import type { ComfyWorkflowConfig } from "./types.ts";

/** 权重文件后缀。命不中的字符串（提示词、采样器名、文件名前缀等）一律不算权重。 */
const WEIGHT_EXT = /\.(safetensors|sft|ckpt|pt|pth|gguf|bin)$/i;

type CacheEntry = { mtimeMs: number; weights: Set<string> };
const cache = new Map<string, CacheEntry>();

/** 认不出权重的模板只警告一次，别把日志刷爆。 */
const warned = new Set<string>();

function scan(graph: unknown, out: Set<string>): void {
  if (!graph || typeof graph !== "object") return;
  for (const node of Object.values(graph as Record<string, any>)) {
    const inputs = node?.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const v of Object.values(inputs)) {
      if (typeof v === "string" && WEIGHT_EXT.test(v)) out.add(v);
    }
  }
}

/**
 * 某出口的模板引用了哪些权重文件。
 * 模板读不到、或图里认不出任何权重时返回空集——交集恒 0、退化成入队顺序，
 * 并打一条可读日志点名该出口，MUST NOT 静默（否则排序悄悄失效没人知道）。
 */
export function weightsOf(wf: ComfyWorkflowConfig | undefined, label = "?"): Set<string> {
  if (!wf?.template) return new Set();
  // 与 providers/comfyui.ts 的 templatePath 同款越界校验：模板名来自用户配置，
  // 裸 join 会让 `../` 读到 templates/ 之外的文件
  const base = resolve(TEMPLATES_DIR);
  const path = resolve(base, wf.template);
  if (!path.startsWith(`${base}${sep}`)) {
    if (!warned.has(label)) {
      warned.add(label);
      console.info(`[亲和排序] 出口 ${label} 的模板路径越界（${wf.template}），该出口不参与权重亲和排序`);
    }
    return new Set();
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    if (!warned.has(label)) {
      warned.add(label);
      console.info(`[亲和排序] 出口 ${label} 的模板读不到（${wf.template}），该出口不参与权重亲和排序`);
    }
    return new Set();
  }
  const hit = cache.get(path);
  // 按 mtime 失效：用户改了自带模板不必重启服务
  if (hit && hit.mtimeMs === mtimeMs) return hit.weights;

  const weights = new Set<string>();
  try {
    scan(JSON.parse(readFileSync(path, "utf8")), weights);
  } catch {
    // 解析失败留空集，下面统一走「认不出」分支
  }
  if (weights.size === 0 && !warned.has(label)) {
    warned.add(label);
    console.info(`[亲和排序] 出口 ${label} 的模板 ${wf.template} 里认不出任何权重文件，该出口不参与权重亲和排序`);
  }
  cache.set(path, { mtimeMs, weights });
  return weights;
}

/** 亲和度 = 两个权重集合的交集大小。任一为空则 0。 */
export function affinity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const w of small) if (large.has(w)) n++;
  return n;
}

/** 测试用：清掉模板缓存与告警去重。 */
export function resetWeightAffinityForTests(): void {
  cache.clear();
  warned.clear();
}
