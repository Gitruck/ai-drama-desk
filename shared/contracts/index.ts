export const API_VERSION = "v1" as const;
export const EDITION_NOTICE = "开源版 · 独立于 gtrk 命令树" as const;

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SERVICE_UNAVAILABLE"
  | "PATH_FORBIDDEN"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
  details?: unknown;
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface LoraManifest {
  schemaVersion: "gitruck.style-lora/v1";
  adapter: string;
  baseModel: string;
  weightsPath: string;
  sha256: string;
  triggerWords: string[];
  license?: string;
  trainedAt: string;
  training: Record<string, string | number | boolean | null>;
}

export interface StyleRefMeta {
  file: string;
  label?: string;
  license?: string;
  sha256?: string;
}

export interface StyleProfileContract {
  schemaVersion?: "gitruck.style-profile/v1";
  id: string;
  name: string;
  styleLock: string;
  styleLockEn?: string;
  negatives: string;
  negativesEn?: string;
  refs: string[];
  refMeta?: StyleRefMeta[];
  notes?: string;
  license?: string;
  lora?: LoraManifest;
  updatedAt?: string;
}

export interface StylePackManifest {
  schemaVersion: "gitruck.style-pack/v1";
  exportedAt: string;
  profile: StyleProfileContract;
  includes: { refs: boolean; weights: false };
  licenseConfirmed: boolean;
  referenceFiles?: Array<{ file: string; sha256: string; base64: string }>;
}

export type MediaKind = "keyframe" | "video";

export interface MediaDeletePreview {
  projectId: string;
  shotIndex: number;
  kind: MediaKind;
  outputId: string;
  selected: boolean;
  derivedVideos: string[];
  blockingJobs: string[];
  exportedCopiesUnaffected: true;
}

export type LoraJobStatus =
  | "queued"
  | "blocked"
  | "starting"
  | "running"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "succeeded"
  | "recoverable";

export interface LoraTrainRequest {
  name: string;
  adapter?: string;
  pythonPath: string;
  trainerRoot: string;
  datasetConfig: string;
  baseModel: string;
  vaePath: string;
  textEncoderPath: string;
  outputDir: string;
  outputName: string;
  maxTrainSteps: number;
  saveEveryNSteps?: number;
  learningRate?: number;
  networkDim?: number;
  networkAlpha?: number;
  blocksToSwap?: number;
  triggerWords?: string[];
  license?: string;
  extraArgs?: string[];
  resumeFrom?: string;
  completedStepsBeforeResume?: number;
  dryRun?: boolean;
}

export interface LoraCheckpoint {
  step: number;
  path: string;
  statePath?: string;
  createdAt?: string;
}

export interface LoraJob {
  schemaVersion: "gitruck.lora-job/v1";
  id: string;
  request: LoraTrainRequest;
  status: LoraJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  progress?: { localStep: number; totalLocalSteps: number; absoluteStep: number; totalAbsoluteSteps: number; loss?: number };
  checkpoints: LoraCheckpoint[];
  blockedReason?: string;
  error?: string;
  parentJobId?: string;
  manifest?: LoraManifest;
}

export type DiagnosticState = "ready" | "not-ready" | "offline" | "not-configured" | "unknown";

export interface DiagnosticLayer {
  state: DiagnosticState;
  message?: string;
  missing?: string[];
}

export interface ComfyRuntimeInfo {
  pythonVersion?: string;
  torchVersion?: string;
  cudaAvailable?: boolean;
  devices: Array<{ name: string; type?: string; vramTotal?: number; vramFree?: number }>;
}

export interface ProviderDiagnostic {
  id: string;
  ready: boolean;
  checkedAt: string;
  service: DiagnosticLayer;
  runtime: DiagnosticLayer;
  workflow: DiagnosticLayer;
  nodes: DiagnosticLayer;
  models: DiagnosticLayer;
}

export interface ComfyDiagnostic {
  checkedAt: string;
  comfyUrl: string;
  service: DiagnosticLayer;
  runtime?: ComfyRuntimeInfo;
  queue: DiagnosticLayer & { running?: number; pending?: number };
  providers: Record<string, ProviderDiagnostic>;
}

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

export function isSafeOutputId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\\/]/.test(value) && value !== "." && value !== "..";
}

export function assertStyleProfile(value: unknown): asserts value is StyleProfileContract {
  if (!value || typeof value !== "object") throw new Error("画风档案必须是对象");
  const p = value as Record<string, unknown>;
  if (!isSafeId(p.id)) throw new Error("画风 id 需为小写字母数字连字符");
  for (const key of ["name", "styleLock", "negatives"] as const) {
    if (typeof p[key] !== "string") throw new Error(`画风字段 ${key} 必须是字符串`);
  }
  if (!Array.isArray(p.refs) || !p.refs.every(isSafeOutputId)) throw new Error("画风 refs 非法");
}

export function assertLoraTrainRequest(value: unknown): asserts value is LoraTrainRequest {
  if (!value || typeof value !== "object") throw new Error("训练配置必须是对象");
  const v = value as Record<string, unknown>;
  for (const key of ["name", "pythonPath", "trainerRoot", "datasetConfig", "baseModel", "vaePath", "textEncoderPath", "outputDir", "outputName"] as const) {
    if (typeof v[key] !== "string" || !(v[key] as string).trim()) throw new Error(`训练字段 ${key} 必填`);
  }
  if (!Number.isInteger(v.maxTrainSteps) || (v.maxTrainSteps as number) <= 0) throw new Error("maxTrainSteps 必须是正整数");
  if (v.extraArgs !== undefined && (!Array.isArray(v.extraArgs) || !v.extraArgs.every((x) => typeof x === "string"))) {
    throw new Error("extraArgs 必须是字符串数组");
  }
}
