// ComfyUI 通用驱动：workflow JSON 模板（API 格式）+ 可配置节点映射。
// 范式来自 dseditor/AI-storyboard-generator：用户在 ComfyUI 里调通 workflow 后
// 「保存(API格式)」导出 JSON 放进 templates/，在设置里标注各输入节点 ID。
// GPL 边界：仅走 HTTP API，无代码派生（对齐 license-compliance-policy）。

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { ComfyDiagnostic, ComfyRuntimeInfo, DiagnosticLayer, ProviderDiagnostic } from "../../../shared/contracts/index.ts";
import { TEMPLATES_DIR } from "../config.ts";
import type { ComfyWorkflowConfig, JobPhase, StudioConfig } from "../types.ts";

interface ComfyGenOpts {
  comfyUrl: string;
  wf: ComfyWorkflowConfig;
  prompt: string;
  negative?: string;
  /** 本地参考图绝对路径（先上传到 ComfyUI 再填 LoadImage） */
  refImages?: string[];
  /** 首帧（视频 workflow） */
  startImage?: string;
  seed?: number;
  width?: number;
  height?: number;
  frames?: number;
  /** 产物落盘目录 + 文件名前缀 */
  outDir: string;
  outPrefix: string;
  timeoutMs?: number;
  /** ComfyUI 连续不可达多久判失速（默认 90s）。留窗是为了不让偶发抖动打断真在跑的长片。 */
  stallToleranceMs?: number;
  /** 轮询间隔（默认 2s）；测试用它把失速判据的验证压到毫秒级。 */
  pollIntervalMs?: number;
  /**
   * 阶段回调（纯观测）。阶段来自本函数自己的控制流，不依赖 ComfyUI 推送——
   * 主力模板都是少步蒸馏，step 级进度只有几个 tick，而吃墙钟的模型加载、
   * 非 tiled VAE 解码、视频封装三段一个 progress 事件都不发，画百分比是假精确。
   * MUST NOT 参与完成/失速/中止判据。
   */
  onPhase?: (phase: JobPhase) => void;
  /** 用户中止信号：透传给全部 fetch，并在中止时回收 ComfyUI 侧的 prompt。 */
  signal?: AbortSignal;
  /** 项目所选画风的 LoRA 绑定；存在时动态覆盖模板节点与触发词。 */
  styleLora?: { weightsPath: string; triggerWords: string[]; strength?: number };
}

/** 历史里查不到、队列里也查不到，连续几次才判 prompt 丢失——执行完到写进 history 之间有极短空窗。 */
const ORPHAN_CONFIRMATIONS = 3;

/** 把用户中止信号与单次请求超时并成一个：任一触发即断。 */
function reqSignal(ms: number, user?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return user ? AbortSignal.any([user, timeout]) : timeout;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** ComfyUI 队列项形如 [序号, prompt_id, prompt, extra, outputs] */
function queueHasPrompt(list: unknown, promptId: string): boolean {
  return Array.isArray(list) && list.some((item) => Array.isArray(item) && item.includes(promptId));
}

/**
 * 该 prompt 是否还在 ComfyUI 队列里。
 * true=在跑或在等；false=两个队列都没有；null=队列本身没问出来（不作判据，交给不可达窗）。
 */
async function promptInQueue(comfyUrl: string, promptId: string, signal: AbortSignal): Promise<boolean | null> {
  const res = await fetch(`${comfyUrl}/queue`, { signal }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { queue_running?: unknown; queue_pending?: unknown } | null;
  if (!body) return null;
  return queueHasPrompt(body.queue_running, promptId) || queueHasPrompt(body.queue_pending, promptId);
}

/**
 * 用户中止后回收 ComfyUI 侧的 prompt。
 * `/interrupt` 是**全局**的——只有确认当前跑的就是本任务的 prompt 才发，
 * 否则会顺手打断别人（另一个客户端、或 LoRA 训练之外的手工出图）的活。
 * 全程用独立超时信号：此时用户信号已经 abort，拿它发请求会立刻失败。
 */
export async function comfyCancelPrompt(comfyUrl: string, promptId: string): Promise<void> {
  const res = await fetch(`${comfyUrl}/queue`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res || !res.ok) return;
  const body = (await res.json().catch(() => null)) as { queue_running?: unknown; queue_pending?: unknown } | null;
  if (!body) return;
  if (queueHasPrompt(body.queue_pending, promptId)) {
    await fetch(`${comfyUrl}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
  }
  if (queueHasPrompt(body.queue_running, promptId)) {
    await fetch(`${comfyUrl}/interrupt`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => null);
  }
}

async function uploadImage(comfyUrl: string, filePath: string, signal?: AbortSignal): Promise<string> {
  const data = readFileSync(filePath);
  const form = new FormData();
  const name = `${Date.now().toString(36)}-${basename(filePath)}`;
  form.append("image", new Blob([data]), name);
  form.append("overwrite", "true");
  const res = await fetch(`${comfyUrl}/upload/image`, { method: "POST", body: form, signal: reqSignal(60_000, signal) });
  if (!res.ok) throw new Error(`ComfyUI 上传参考图失败: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { name: string; subfolder?: string };
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

function setNode(graph: Record<string, any>, ref: { id: string; field: string } | undefined, value: unknown) {
  if (!ref) return;
  const node = graph[ref.id];
  if (!node) throw new Error(`workflow 模板里找不到节点 ${ref.id}（检查节点映射配置）`);
  node.inputs[ref.field] = value;
}

function setImageNode(graph: Record<string, any>, ref: { id: string; field: string }, value: string) {
  const node = graph[ref.id];
  if (!node) throw new Error(`workflow 模板里找不到节点 ${ref.id}（检查图片节点映射配置）`);
  // 开源默认模板使用内置纯黑 EmptyImage，避免要求用户手工复制占位 PNG；
  // 一旦有真实参考图，再原位切换为 LoadImage，后续节点连线无需变化。
  if (node.class_type === "EmptyImage") {
    node.class_type = "LoadImage";
    node.inputs = { image: value };
    return;
  }
  setNode(graph, ref, value);
}

export function applyUploadedImageInputs(graph: Record<string, any>, wf: ComfyWorkflowConfig, uploaded: string[]): void {
  const inputs = wf.nodeMap.imageInputs ?? [];
  for (let i = 0; i < Math.min(uploaded.length, inputs.length); i++) {
    setImageNode(graph, inputs[i], uploaded[i]);
  }

  // Qwen Image Edit 会把每个非空 imageN 都编码成 Picture N。纯黑 EmptyImage
  // 并不是“无参考图”，仍会作为真实视觉条件参与生成；因此未使用槽必须从
  // TextEncodeQwenImageEditPlus 等下游节点断开，并移除对应占位节点。
  for (const unused of inputs.slice(uploaded.length)) {
    for (const node of Object.values(graph)) {
      if (!node?.inputs) continue;
      for (const [field, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value) && String(value[0]) === unused.id) delete node.inputs[field];
      }
    }
    delete graph[unused.id];
  }
}

/** workflow 级提示前缀用于自动注入 LoRA 触发词，避免 UI 调用方各自拼接。 */
export function composeWorkflowPrompt(wf: ComfyWorkflowConfig, prompt: string): string {
  const prefix = wf.promptPrefix?.trim();
  return prefix ? `${prefix}\n${prompt}` : prompt;
}

/**
 * ComfyUI 的 LoRA 下拉框使用 models/loras 下的相对名称。
 * manifest 可保存该相对名称，也可保存包含 models/loras 的绝对路径。
 */
export function comfyLoraName(weightsPath: string): string {
  const normalized = weightsPath.trim().replaceAll("\\", "/");
  const marker = "/models/loras/";
  const markerAt = normalized.toLowerCase().lastIndexOf(marker);
  if (markerAt >= 0) return normalized.slice(markerAt + marker.length).replaceAll("/", "\\");
  if (normalized.toLowerCase().startsWith("models/loras/")) return normalized.slice("models/loras/".length).replaceAll("/", "\\");
  if (!normalized || /^[a-z]:\//i.test(normalized) || normalized.startsWith("/")) {
    throw new Error("画风 LoRA weightsPath 必须是 ComfyUI models/loras 下的相对名称，或包含 models/loras 的路径");
  }
  return normalized.replaceAll("/", "\\");
}

export function applyStyleLoraBinding(
  graph: Record<string, any>,
  wf: ComfyWorkflowConfig,
  binding: { weightsPath: string; strength?: number },
): void {
  if (!wf.nodeMap.loraName) throw new Error("LoRA workflow 未配置 loraName 节点映射");
  setNode(graph, wf.nodeMap.loraName, comfyLoraName(binding.weightsPath));
  if (wf.nodeMap.loraStrength) setNode(graph, wf.nodeMap.loraStrength, binding.strength ?? 0.8);
}

/** 提交 workflow 并等待产物，返回落盘后的文件名列表 */
export async function comfyGenerate(opts: ComfyGenOpts): Promise<string[]> {
  const graph = JSON.parse(readFileSync(join(TEMPLATES_DIR, opts.wf.template), "utf-8"));
  const map = opts.wf.nodeMap;

  const promptWorkflow = opts.styleLora
    ? { ...opts.wf, promptPrefix: opts.styleLora.triggerWords.join(" ").trim() }
    : opts.wf;
  setNode(graph, map.prompt, composeWorkflowPrompt(promptWorkflow, opts.prompt));
  if (opts.styleLora) applyStyleLoraBinding(graph, opts.wf, opts.styleLora);
  if (opts.negative != null) setNode(graph, map.negative, opts.negative);
  if (opts.seed != null && map.seed) setNode(graph, map.seed, opts.seed);
  if (opts.width && map.width) setNode(graph, map.width, opts.width);
  if (opts.height && map.height) setNode(graph, map.height, opts.height);
  if (opts.frames && map.frames) setNode(graph, map.frames, opts.frames);

  const signal = opts.signal;
  opts.onPhase?.("uploading");
  if (map.imageInputs) {
    // 逐张上传一次；槽位多于参考图时断开未使用的可选输入。黑图仍会被 Qwen
    // 编码成一张 Picture，不能充当“无输入”的占位符。
    const uploaded: string[] = [];
    for (const ref of (opts.refImages ?? []).slice(0, map.imageInputs.length)) {
      uploaded.push(await uploadImage(opts.comfyUrl, ref, signal));
    }
    applyUploadedImageInputs(graph, opts.wf, uploaded);
  }
  if (opts.startImage && map.startImage) {
    const uploaded = await uploadImage(opts.comfyUrl, opts.startImage, signal);
    setNode(graph, map.startImage, uploaded);
  }

  // 刻意不传 client_id：本仓从不连 ComfyUI 的 /ws（全仓零 WebSocket），
  // 传了等于把该 prompt 的全部事件定向投递到一个不存在的 sid 后静默丢弃——
  // 连用户自己开着的 ComfyUI 网页都看不到本工作台任务的进度。
  // 不传则退回广播，细粒度采样进度让给 ComfyUI 自己的界面，我方不重造。
  const submit = await fetch(`${opts.comfyUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
    signal: reqSignal(30_000, signal),
  });
  if (!submit.ok) throw new Error(`ComfyUI 提交失败: ${submit.status} ${await submit.text()}`);
  const { prompt_id } = (await submit.json()) as { prompt_id: string };
  opts.onPhase?.("submitted");

  try {
    return await awaitOutputs(opts, prompt_id);
  } catch (e) {
    // 用户中止：顺手把 ComfyUI 那边的活也停了，否则卡还在替一个没人要的结果空转
    if (signal?.aborted) await comfyCancelPrompt(opts.comfyUrl, prompt_id);
    throw e;
  }
}

/**
 * 轮询产物，并在三种死法上各自快失败。
 * 老实现只会 `continue` 到总超时——ComfyUI 崩了/重启了，判据全在手边却一条不用，
 * 用户对着「生成中」白等 30 分钟，本地车道连同 GPU 租约一起锁死。
 */
async function awaitOutputs(opts: ComfyGenOpts, promptId: string): Promise<string[]> {
  const signal = opts.signal;
  const totalMs = opts.timeoutMs ?? 30 * 60_000;
  const stallMs = opts.stallToleranceMs ?? 90_000;
  const deadline = Date.now() + totalMs;
  let unreachableSince: number | null = null;
  let orphanStreak = 0;

  while (Date.now() < deadline) {
    await sleep(opts.pollIntervalMs ?? 2000, signal);
    // 单次轮询也要超时：ComfyUI 假死时不能让 job 永久挂在 running
    const hist = await fetch(`${opts.comfyUrl}/history/${promptId}`, { signal: reqSignal(15_000, signal) }).catch(() => null);
    if (!hist || !hist.ok) {
      unreachableSince ??= Date.now();
      const downFor = Date.now() - unreachableSince;
      if (downFor >= stallMs) {
        throw new Error(
          `ComfyUI 连续 ${Math.round(downFor / 1000)} 秒不可达（可能已崩溃或被关闭），任务中止。等服务恢复后重新出图即可，已出的产物都还在。`,
        );
      }
      continue;
    }
    unreachableSince = null;

    const entry = ((await hist.json().catch(() => ({}))) as Record<string, any>)[promptId];
    if (entry) {
      orphanStreak = 0;
      if (entry.status?.status_str === "error") {
        const msgs = JSON.stringify(entry.status?.messages ?? []).slice(0, 500);
        throw new Error(`ComfyUI 执行出错: ${msgs}`);
      }
      if (entry.outputs && Object.keys(entry.outputs).length > 0) {
        opts.onPhase?.("downloading");
        return await collectOutputs(opts, entry.outputs);
      }
      continue;
    }

    // 历史里没有本任务：服务活着，那它要么还在队列里，要么已经不存在了。
    const queued = await promptInQueue(opts.comfyUrl, promptId, reqSignal(10_000, signal));
    if (queued !== false) {
      // true=还在排队/在跑；null=队列没问出来，不作判据
      if (queued === true) orphanStreak = 0;
      continue;
    }
    if (++orphanStreak >= ORPHAN_CONFIRMATIONS) {
      throw new Error(
        "ComfyUI 已重启或队列被清空，本任务提交的 prompt 在它那边已经不存在了，任务中止。重新出图即可。",
      );
    }
  }
  throw new Error(`ComfyUI 生成超时：等了 ${Math.round(totalMs / 60_000)} 分钟仍未拿到产物，任务中止。`);
}

async function collectOutputs(opts: ComfyGenOpts, outputs: Record<string, any>): Promise<string[]> {
  const saved: string[] = [];
  let n = 0;
  for (const nodeOut of Object.values(outputs)) {
    const files = [...(nodeOut.images ?? []), ...(nodeOut.gifs ?? []), ...(nodeOut.videos ?? [])];
    for (const f of files) {
      if (f.type && f.type !== "output") continue;
      const params = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" });
      const res = await fetch(`${opts.comfyUrl}/view?${params}`, { signal: reqSignal(120_000, opts.signal) });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      const ext = (f.filename.match(/\.[a-z0-9]+$/i)?.[0] ?? ".png").toLowerCase();
      const name = `${opts.outPrefix}${n === 0 ? "" : `-${n}`}${ext}`;
      // 先写 .part 再 rename，防半截文件被当成品
      const tmp = `${name}.part${ext}`;
      writeFileSync(join(opts.outDir, tmp), buf);
      renameSync(join(opts.outDir, tmp), join(opts.outDir, name));
      saved.push(name);
      n++;
    }
  }
  if (saved.length === 0) throw new Error("ComfyUI 完成但未找到产物文件（检查模板里的输出节点）");
  return saved;
}

export async function comfyAlive(comfyUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export type ComfyModelCategory = "diffusion_models" | "text_encoders" | "vae" | "loras" | "clip_vision" | "checkpoints";

export interface WorkflowDependency {
  nodeId: string;
  classType: string;
  field: string;
  category: ComfyModelCategory;
  name: string;
}

export interface ParsedWorkflowDependencies {
  nodeTypes: string[];
  models: WorkflowDependency[];
}

const MODEL_INPUTS: Record<string, Array<[string, ComfyModelCategory]>> = {
  UNETLoader: [["unet_name", "diffusion_models"]],
  CheckpointLoaderSimple: [["ckpt_name", "checkpoints"]],
  CheckpointLoader: [["ckpt_name", "checkpoints"]],
  CLIPLoader: [["clip_name", "text_encoders"]],
  DualCLIPLoader: [["clip_name1", "text_encoders"], ["clip_name2", "text_encoders"]],
  TripleCLIPLoader: [["clip_name1", "text_encoders"], ["clip_name2", "text_encoders"], ["clip_name3", "text_encoders"]],
  VAELoader: [["vae_name", "vae"]],
  LoraLoader: [["lora_name", "loras"]],
  LoraLoaderModelOnly: [["lora_name", "loras"]],
  CLIPVisionLoader: [["clip_name", "clip_vision"]],
};

export function parseWorkflowDependencies(graph: unknown): ParsedWorkflowDependencies {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) throw new Error("workflow 必须是 ComfyUI API 格式对象");
  const nodeTypes = new Set<string>();
  const models: WorkflowDependency[] = [];
  for (const [nodeId, rawNode] of Object.entries(graph as Record<string, unknown>)) {
    if (!rawNode || typeof rawNode !== "object") throw new Error(`workflow 节点 ${nodeId} 格式非法`);
    const node = rawNode as { class_type?: unknown; inputs?: unknown };
    if (typeof node.class_type !== "string" || !node.class_type) throw new Error(`workflow 节点 ${nodeId} 缺少 class_type`);
    nodeTypes.add(node.class_type);
    const inputs = node.inputs && typeof node.inputs === "object" ? node.inputs as Record<string, unknown> : {};
    for (const [field, category] of MODEL_INPUTS[node.class_type] ?? []) {
      const value = inputs[field];
      if (typeof value === "string" && value.trim()) models.push({ nodeId, classType: node.class_type, field, category, name: value });
    }
  }
  return { nodeTypes: [...nodeTypes].sort(), models };
}

interface ProbeResult {
  ok: boolean;
  value?: Record<string, any>;
  layer: DiagnosticLayer;
}

async function probeJson(comfyUrl: string, path: string, fetcher: typeof fetch): Promise<ProbeResult> {
  try {
    const response = await fetcher(`${comfyUrl}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, layer: { state: "not-ready", message: `${path} 返回 HTTP ${response.status}` } };
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, layer: { state: "not-ready", message: `${path} 返回了畸形 JSON` } };
    return { ok: true, value: value as Record<string, any>, layer: { state: "ready" } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeout = /timeout|timed\s*out|aborted/i.test(message);
    return { ok: false, layer: { state: "offline", message: timeout ? `${path} 请求超时` : `ComfyUI 不可达：${message}` } };
  }
}

function safeComfyUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "(配置的 ComfyUI URL 非法)";
  }
}

function endpointComfyUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function runtimeInfo(systemStats: Record<string, any>): ComfyRuntimeInfo {
  const system = systemStats.system && typeof systemStats.system === "object" ? systemStats.system : {};
  const devices = Array.isArray(systemStats.devices) ? systemStats.devices : [];
  return {
    pythonVersion: typeof system.python_version === "string" ? system.python_version : undefined,
    torchVersion: typeof system.pytorch_version === "string" ? system.pytorch_version : undefined,
    cudaAvailable: devices.some((device: any) => typeof device?.type === "string" && /cuda/i.test(device.type)),
    devices: devices.map((device: any) => ({
      name: String(device?.name ?? "未知设备"),
      type: typeof device?.type === "string" ? device.type : undefined,
      vramTotal: Number.isFinite(device?.vram_total) ? Number(device.vram_total) : undefined,
      vramFree: Number.isFinite(device?.vram_free) ? Number(device.vram_free) : Number.isFinite(device?.torch_vram_free) ? Number(device.torch_vram_free) : undefined,
    })),
  };
}

function templatePath(template: string): string | null {
  const base = resolve(TEMPLATES_DIR);
  const target = resolve(base, template);
  return target.startsWith(`${base}${sep}`) ? target : null;
}

function inputOptions(objectInfo: Record<string, any>, classType: string, field: string): string[] | null {
  const input = objectInfo[classType]?.input;
  const spec = input?.required?.[field] ?? input?.optional?.[field];
  const values = Array.isArray(spec) ? spec[0] : undefined;
  return Array.isArray(values) && values.every((item) => typeof item === "string") ? values : null;
}

function providerDiagnostic(
  id: string,
  wf: ComfyWorkflowConfig | undefined,
  service: DiagnosticLayer,
  runtime: DiagnosticLayer,
  objectInfo: ProbeResult,
  checkedAt: string,
): ProviderDiagnostic {
  if (!wf) {
    return {
      id, ready: false, checkedAt, service, runtime,
      workflow: { state: "not-configured", message: "未配置工作台 workflow 模板" },
      nodes: { state: "unknown", message: "先配置 workflow" },
      models: { state: "unknown", message: "先配置 workflow" },
    };
  }
  const path = templatePath(wf.template);
  if (!path || !existsSync(path)) {
    const message = !path ? "workflow 模板路径越界" : `模板不存在：${basename(wf.template)}`;
    return { id, ready: false, checkedAt, service, runtime, workflow: { state: "not-ready", message }, nodes: { state: "unknown" }, models: { state: "unknown" } };
  }
  let deps: ParsedWorkflowDependencies;
  try {
    deps = parseWorkflowDependencies(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return { id, ready: false, checkedAt, service, runtime, workflow: { state: "not-ready", message: error instanceof Error ? error.message : String(error) }, nodes: { state: "unknown" }, models: { state: "unknown" } };
  }
  const workflow: DiagnosticLayer = { state: "ready", message: `${basename(wf.template)} · ${deps.nodeTypes.length} 种节点` };
  if (!objectInfo.ok || !objectInfo.value) {
    return { id, ready: false, checkedAt, service, runtime, workflow, nodes: { ...objectInfo.layer }, models: { ...objectInfo.layer } };
  }
  const missingNodes = deps.nodeTypes.filter((node) => !objectInfo.value?.[node]);
  // 画风 LoRA 由 manifest 运行时注入（applyStyleLoraBinding 恒覆盖 nodeMap.loraName 指向的节点），
  // 其模板占位名不是必需静态模型，从缺模核对中剔除。
  const dynamicLoraNode = wf.nodeMap.loraName;
  const isDynamicLoraSlot = (model: WorkflowDependency) =>
    dynamicLoraNode != null && model.nodeId === dynamicLoraNode.id && model.field === dynamicLoraNode.field;
  const missingModels = deps.models.filter((model) => {
    if (isDynamicLoraSlot(model)) return false;
    const options = inputOptions(objectInfo.value!, model.classType, model.field);
    return options != null && !options.includes(model.name);
  }).map((model) => `${model.category}/${model.name}`);
  const hasDynamicLoraSlot = deps.models.some(isDynamicLoraSlot);
  const nodes: DiagnosticLayer = missingNodes.length ? { state: "not-ready", message: "缺少 workflow 必需节点", missing: missingNodes } : { state: "ready" };
  const models: DiagnosticLayer = missingModels.length
    ? { state: "not-ready", message: "缺少 workflow 必需模型", missing: missingModels }
    : { state: "ready", ...(hasDynamicLoraSlot ? { message: "画风 LoRA 由 manifest 运行时注入" } : {}) };
  const ready = [service, runtime, workflow, nodes, models].every((layer) => layer.state === "ready");
  return { id, ready, checkedAt, service, runtime, workflow, nodes, models };
}

export async function diagnoseComfy(config: StudioConfig, fetcher: typeof fetch = fetch): Promise<ComfyDiagnostic> {
  const checkedAt = new Date().toISOString();
  const comfyUrl = endpointComfyUrl(config.comfyUrl);
  const [stats, objects, queueProbe] = await Promise.all([
    probeJson(comfyUrl, "/system_stats", fetcher),
    probeJson(comfyUrl, "/object_info", fetcher),
    probeJson(comfyUrl, "/queue", fetcher),
  ]);
  const service: DiagnosticLayer = stats.ok ? { state: "ready" } : stats.layer;
  const info = stats.ok && stats.value ? runtimeInfo(stats.value) : undefined;
  const runtime: DiagnosticLayer = info
    ? { state: "ready", message: info.devices.length ? undefined : "ComfyUI 未报告 GPU/CPU 设备" }
    : { state: service.state === "offline" ? "offline" : "not-ready", message: stats.layer.message };
  const queueValue = queueProbe.value;
  const queue = queueProbe.ok && queueValue && Array.isArray(queueValue.queue_running) && Array.isArray(queueValue.queue_pending)
    ? { state: "ready" as const, running: queueValue.queue_running.length, pending: queueValue.queue_pending.length }
    : { ...queueProbe.layer, ...(queueProbe.ok ? { state: "not-ready" as const, message: "/queue 返回缺少 queue_running/queue_pending" } : {}) };
  const configs: Array<[string, ComfyWorkflowConfig | undefined]> = [
    ["comfyui-image", config.comfyImage],
    ["comfyui-image2", config.comfyImage2],
    ["comfyui-video", config.comfyVideo],
    ["hunyuan-video", config.comfyVideoHunyuan],
    ["h3-video", config.comfyVideoH3],
    ["h3-video-final", config.comfyVideoH3Final],
  ];
  const providers = Object.fromEntries(configs.map(([id, wf]) => [id, providerDiagnostic(id, wf, service, runtime, objects, checkedAt)]));
  return { checkedAt, comfyUrl: safeComfyUrl(config.comfyUrl), service, runtime: info, queue, providers };
}
