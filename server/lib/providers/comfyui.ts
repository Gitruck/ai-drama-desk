// ComfyUI 通用驱动：workflow JSON 模板（API 格式）+ 可配置节点映射。
// 范式来自 dseditor/AI-storyboard-generator：用户在 ComfyUI 里调通 workflow 后
// 「保存(API格式)」导出 JSON 放进 templates/，在设置里标注各输入节点 ID。
// GPL 边界：仅走 HTTP API，无代码派生（对齐 license-compliance-policy）。

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { ComfyDiagnostic, ComfyRuntimeInfo, DiagnosticLayer, ProviderDiagnostic } from "../../../shared/contracts/index.ts";
import { TEMPLATES_DIR } from "../config.ts";
import type { ComfyWorkflowConfig, StudioConfig } from "../types.ts";

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
  /** 项目所选画风的 LoRA 绑定；存在时动态覆盖模板节点与触发词。 */
  styleLora?: { weightsPath: string; triggerWords: string[]; strength?: number };
}

async function uploadImage(comfyUrl: string, filePath: string): Promise<string> {
  const data = readFileSync(filePath);
  const form = new FormData();
  const name = `${Date.now().toString(36)}-${basename(filePath)}`;
  form.append("image", new Blob([data]), name);
  form.append("overwrite", "true");
  const res = await fetch(`${comfyUrl}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
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

  if (map.imageInputs) {
    // 逐张上传一次；槽位多于参考图时断开未使用的可选输入。黑图仍会被 Qwen
    // 编码成一张 Picture，不能充当“无输入”的占位符。
    const uploaded: string[] = [];
    for (const ref of (opts.refImages ?? []).slice(0, map.imageInputs.length)) {
      uploaded.push(await uploadImage(opts.comfyUrl, ref));
    }
    applyUploadedImageInputs(graph, opts.wf, uploaded);
  }
  if (opts.startImage && map.startImage) {
    const uploaded = await uploadImage(opts.comfyUrl, opts.startImage);
    setNode(graph, map.startImage, uploaded);
  }

  const clientId = crypto.randomUUID();
  const submit = await fetch(`${opts.comfyUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!submit.ok) throw new Error(`ComfyUI 提交失败: ${submit.status} ${await submit.text()}`);
  const { prompt_id } = (await submit.json()) as { prompt_id: string };

  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    // 单次轮询也要超时：ComfyUI 假死时不能让 job 永久挂在 running（local 车道串行会全线堵死）
    const hist = await fetch(`${opts.comfyUrl}/history/${prompt_id}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!hist || !hist.ok) continue;
    const j = (await hist.json()) as Record<string, any>;
    const entry = j[prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      const msgs = JSON.stringify(entry.status?.messages ?? []).slice(0, 500);
      throw new Error(`ComfyUI 执行出错: ${msgs}`);
    }
    if (entry.outputs && Object.keys(entry.outputs).length > 0) {
      return await collectOutputs(opts, entry.outputs);
    }
  }
  throw new Error("ComfyUI 生成超时");
}

async function collectOutputs(opts: ComfyGenOpts, outputs: Record<string, any>): Promise<string[]> {
  const saved: string[] = [];
  let n = 0;
  for (const nodeOut of Object.values(outputs)) {
    const files = [...(nodeOut.images ?? []), ...(nodeOut.gifs ?? []), ...(nodeOut.videos ?? [])];
    for (const f of files) {
      if (f.type && f.type !== "output") continue;
      const params = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" });
      const res = await fetch(`${opts.comfyUrl}/view?${params}`, { signal: AbortSignal.timeout(120_000) });
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
  ];
  const providers = Object.fromEntries(configs.map(([id, wf]) => [id, providerDiagnostic(id, wf, service, runtime, objects, checkedAt)]));
  return { checkedAt, comfyUrl: safeComfyUrl(config.comfyUrl), service, runtime: info, queue, providers };
}
