import { appendFileSync } from "node:fs";
import type { LoraJob, LoraTrainRequest } from "../../../shared/contracts/index.ts";
import { assertLoraTrainRequest } from "../../../shared/contracts/index.ts";
import { getGpuLease, releaseGpu, tryAcquireGpu } from "../gpu-lease.ts";
import { loadConfig } from "../config.ts";
import { resumeGenerationPump } from "../queue.ts";
import { getStyle, saveStyle } from "../styles.ts";
import type { TrainerAdapter, TrainerProgress } from "./adapter.ts";
import { FakeTrainerAdapter } from "./fake.ts";
import {
  appendLoraEvent,
  createLoraJob,
  getLoraJob,
  listLoraJobs,
  loraJobLog,
  recoverInterruptedLoraJobs,
  saveLoraJob,
  transitionLoraJob,
} from "./jobs.ts";
import { MusubiQwenImageAdapter } from "./musubi.ts";

export class LoraManagerError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "BAD_REQUEST", public readonly details?: unknown) {
    super(message);
  }
}

const adapters = new Map<string, TrainerAdapter>([
  ["musubi-qwen-image-edit", new MusubiQwenImageAdapter()],
  ["fake", new FakeTrainerAdapter()],
]);
const processes = new Map<string, any>();
let initialized = false;
let pumping = false;

function adapterFor(request: LoraTrainRequest): TrainerAdapter {
  const id = request.dryRun ? "fake" : request.adapter ?? "musubi-qwen-image-edit";
  const adapter = adapters.get(id);
  if (!adapter) throw new LoraManagerError(`未知 Trainer Adapter: ${id}`);
  return adapter;
}

export function initializeLoraManager(): void {
  if (initialized) return;
  initialized = true;
  recoverInterruptedLoraJobs();
  pumpLora();
}

export function getLoraJobs(): LoraJob[] {
  initializeLoraManager();
  return listLoraJobs();
}

export function getLoraJobOrThrow(id: string): LoraJob {
  initializeLoraManager();
  const job = getLoraJob(id);
  if (!job) throw new LoraManagerError("LoRA 任务不存在", 404, "NOT_FOUND");
  return job;
}

export async function validateLoraTraining(value: unknown): Promise<{ ok: boolean; adapter: string; missing: string[] }> {
  try {
    assertLoraTrainRequest(value);
  } catch (error) {
    throw new LoraManagerError(error instanceof Error ? error.message : String(error));
  }
  const request = { ...(value as LoraTrainRequest) };
  const adapter = adapterFor(request);
  const missing = await adapter.validate(request);
  return { ok: missing.length === 0, adapter: adapter.id, missing };
}

export async function submitLoraTraining(value: unknown, parentJobId?: string): Promise<LoraJob> {
  initializeLoraManager();
  const validation = await validateLoraTraining(value);
  const request = { ...(value as LoraTrainRequest) };
  if (!validation.ok) throw new LoraManagerError("训练环境或输入不完整", 400, "BAD_REQUEST", { missing: validation.missing });
  const job = createLoraJob(request, parentJobId);
  pumpLora();
  return job;
}

async function comfyHasActiveQueue(): Promise<boolean> {
  try {
    const response = await fetch(`${loadConfig().comfyUrl}/queue`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
    return (body.queue_running?.length ?? 0) > 0 || (body.queue_pending?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function globalGpuFreeMb(): Promise<number | null> {
  try {
    const proc = Bun.spawn({ cmd: ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], stdout: "pipe", stderr: "ignore", windowsHide: true });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const value = Number(text.trim().split(/\s+/)[0]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function retryLater(): void {
  const timer = setTimeout(pumpLora, 5000);
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function pumpLora(): void {
  if (pumping) return;
  pumping = true;
  queueMicrotask(async () => {
    try {
      const job = listLoraJobs().reverse().find((x) => x.status === "queued" || x.status === "blocked");
      if (!job) return;
      if (!job.request.dryRun) {
        const lease = getGpuLease();
        const queueBusy = await comfyHasActiveQueue();
        const freeMb = await globalGpuFreeMb();
        const reason = lease
          ? `GPU 已由 ${lease.kind}:${lease.ownerId} 占用`
          : queueBusy
            ? "ComfyUI 存在运行中或排队任务"
            : freeMb != null && freeMb < 2048
              ? `GPU 空闲显存仅 ${freeMb} MiB，疑似有外部任务占用`
              : undefined;
        if (reason) {
          if (job.status !== "blocked" || job.blockedReason !== reason) transitionLoraJob(job.id, "blocked", { blockedReason: reason });
          retryLater();
          return;
        }
      }
      if (!tryAcquireGpu("lora", job.id)) {
        if (job.status !== "blocked") transitionLoraJob(job.id, "blocked", { blockedReason: "等待本地 GPU 租约" });
        retryLater();
        return;
      }
      if (job.status === "blocked") transitionLoraJob(job.id, "queued", { blockedReason: undefined });
      await runJob(getLoraJobOrThrow(job.id));
    } finally {
      pumping = false;
      if (listLoraJobs().some((x) => x.status === "queued" || x.status === "blocked")) retryLater();
    }
  });
}

async function consumeStream(jobId: string, stream: ReadableStream<Uint8Array> | null, adapter: TrainerAdapter): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    appendFileSync(loraJobLog(jobId), text);
    tail = `${tail}${text}`.slice(-8192);
    const progress = adapter.parseProgress(tail);
    if (progress) updateProgress(jobId, progress);
  }
}

function updateProgress(jobId: string, progress: TrainerProgress): void {
  const job = getLoraJob(jobId);
  if (!job || job.status !== "running") return;
  const before = job.request.completedStepsBeforeResume ?? 0;
  job.progress = {
    localStep: progress.localStep,
    totalLocalSteps: progress.totalLocalSteps,
    absoluteStep: before + progress.localStep,
    totalAbsoluteSteps: job.request.maxTrainSteps,
    loss: progress.loss,
  };
  saveLoraJob(job);
}

async function runJob(job: LoraJob): Promise<void> {
  const adapter = adapterFor(job.request);
  try {
    transitionLoraJob(job.id, "starting", { startedAt: new Date().toISOString(), blockedReason: undefined });
    const command = adapter.buildCommand(job.request);
    const proc = Bun.spawn({
      cmd: command.cmd,
      cwd: command.cwd,
      env: { ...process.env, ...(command.env ?? {}) },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    processes.set(job.id, proc);
    transitionLoraJob(job.id, "running", { pid: proc.pid });
    appendLoraEvent(job.id, { type: "process-start", pid: proc.pid, adapter: adapter.id });
    const streams = [consumeStream(job.id, proc.stdout, adapter), consumeStream(job.id, proc.stderr, adapter)];
    const exitCode = await proc.exited;
    await Promise.all(streams);
    processes.delete(job.id);
    const fresh = getLoraJobOrThrow(job.id);
    fresh.checkpoints = adapter.discoverCheckpoints(fresh);
    if (fresh.status === "cancelling") {
      transitionLoraJob(job.id, "cancelled", { checkpoints: fresh.checkpoints, finishedAt: new Date().toISOString(), pid: undefined });
    } else if (exitCode === 0) {
      const manifest = await adapter.createManifest(fresh);
      transitionLoraJob(job.id, "succeeded", { checkpoints: fresh.checkpoints, manifest: manifest ?? undefined, finishedAt: new Date().toISOString(), pid: undefined });
    } else {
      transitionLoraJob(job.id, fresh.checkpoints.length ? "recoverable" : "failed", {
        checkpoints: fresh.checkpoints,
        error: `训练进程退出码 ${exitCode}`,
        finishedAt: new Date().toISOString(),
        pid: undefined,
      });
    }
  } catch (error) {
    processes.delete(job.id);
    const current = getLoraJob(job.id);
    if (current && !["cancelled", "succeeded"].includes(current.status)) {
      transitionLoraJob(job.id, "failed", { error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString(), pid: undefined });
    }
  } finally {
    releaseGpu(job.id);
    resumeGenerationPump();
  }
}

export async function cancelLoraJob(id: string): Promise<LoraJob> {
  const job = getLoraJobOrThrow(id);
  if (job.status === "queued" || job.status === "blocked" || job.status === "recoverable") return transitionLoraJob(id, "cancelled", { finishedAt: new Date().toISOString() });
  if (job.status !== "running" && job.status !== "starting") throw new LoraManagerError(`当前状态不能取消：${job.status}`, 409, "CONFLICT");
  transitionLoraJob(id, "cancelling");
  const proc = processes.get(id);
  if (proc) {
    try { proc.kill("SIGINT"); } catch { /* already exited */ }
    const timer = setTimeout(() => { try { if (!proc.killed) proc.kill(); } catch { /* already exited */ } }, 5000);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  return getLoraJobOrThrow(id);
}

export async function resumeLoraJob(id: string): Promise<LoraJob> {
  const job = getLoraJobOrThrow(id);
  if (!["failed", "cancelled", "recoverable"].includes(job.status)) throw new LoraManagerError(`当前状态不能恢复：${job.status}`, 409, "CONFLICT");
  const adapter = adapterFor(job.request);
  const checkpoints = adapter.discoverCheckpoints(job);
  const latest = checkpoints.at(-1);
  if (!latest) throw new LoraManagerError("没有可恢复 checkpoint", 409, "CONFLICT");
  return submitLoraTraining(
    { ...job.request, resumeFrom: latest.statePath ?? latest.path, completedStepsBeforeResume: latest.step, dryRun: job.request.dryRun },
    job.id,
  );
}

export async function publishLoraJob(id: string, styleId: string): Promise<LoraJob> {
  const job = getLoraJobOrThrow(id);
  if (!job.manifest) throw new LoraManagerError("任务没有可发布 LoRA manifest", 409, "CONFLICT");
  const style = getStyle(styleId);
  if (!style) throw new LoraManagerError("目标画风不存在", 404, "NOT_FOUND");
  style.lora = job.manifest;
  saveStyle(style);
  appendLoraEvent(id, { type: "published", styleId });
  return job;
}

export function unpublishStyleLora(styleId: string): void {
  const style = getStyle(styleId);
  if (!style) throw new LoraManagerError("目标画风不存在", 404, "NOT_FOUND");
  delete style.lora;
  saveStyle(style);
}
