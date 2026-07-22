import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoraJob, LoraJobStatus, LoraTrainRequest } from "../../../shared/contracts/index.ts";
import { LORA_JOBS_DIR } from "../config.ts";

const TRANSITIONS: Record<LoraJobStatus, LoraJobStatus[]> = {
  queued: ["blocked", "starting", "cancelled", "failed"],
  blocked: ["queued", "starting", "cancelled", "failed"],
  starting: ["running", "cancelled", "failed", "recoverable"],
  running: ["cancelling", "cancelled", "failed", "succeeded", "recoverable"],
  cancelling: ["cancelled", "failed", "recoverable"],
  cancelled: ["recoverable"],
  failed: ["recoverable"],
  succeeded: [],
  recoverable: ["queued", "starting", "cancelled", "failed"],
};

export function loraJobDir(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("LoRA job id 非法");
  return join(LORA_JOBS_DIR, id);
}

export function loraJobLog(id: string): string {
  return join(loraJobDir(id), "trainer.log");
}

function jobPath(id: string): string {
  return join(loraJobDir(id), "job.json");
}

export function saveLoraJob(job: LoraJob): LoraJob {
  job.updatedAt = new Date().toISOString();
  const dir = loraJobDir(job.id);
  mkdirSync(dir, { recursive: true });
  const target = jobPath(job.id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, target);
  return job;
}

export function appendLoraEvent(id: string, event: Record<string, unknown>): void {
  mkdirSync(loraJobDir(id), { recursive: true });
  appendFileSync(join(loraJobDir(id), "events.ndjson"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export function createLoraJob(request: LoraTrainRequest, parentJobId?: string): LoraJob {
  const now = new Date().toISOString();
  const job: LoraJob = {
    schemaVersion: "gitruck.lora-job/v1",
    id: `lora-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
    request,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    checkpoints: [],
    parentJobId,
  };
  saveLoraJob(job);
  appendLoraEvent(job.id, { type: "created", status: job.status });
  return job;
}

export function getLoraJob(id: string): LoraJob | null {
  if (!existsSync(jobPath(id))) return null;
  return JSON.parse(readFileSync(jobPath(id), "utf8")) as LoraJob;
}

export function listLoraJobs(): LoraJob[] {
  if (!existsSync(LORA_JOBS_DIR)) return [];
  const jobs: LoraJob[] = [];
  for (const item of readdirSync(LORA_JOBS_DIR, { withFileTypes: true })) {
    if (!item.isDirectory() || !/^[a-z0-9-]+$/.test(item.name)) continue;
    try {
      const job = getLoraJob(item.name);
      if (job) jobs.push(job);
    } catch {
      console.error(`跳过损坏的 LoRA job: ${item.name}`);
    }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function transitionLoraJob(id: string, status: LoraJobStatus, patch: Partial<LoraJob> = {}): LoraJob {
  const job = getLoraJob(id);
  if (!job) throw new Error("LoRA 任务不存在");
  if (job.status !== status && !TRANSITIONS[job.status].includes(status)) throw new Error(`非法 LoRA 状态转换：${job.status} -> ${status}`);
  Object.assign(job, patch, { status });
  saveLoraJob(job);
  appendLoraEvent(id, { type: "status", status, ...(patch.blockedReason ? { reason: patch.blockedReason } : {}) });
  return job;
}

export function recoverInterruptedLoraJobs(): LoraJob[] {
  const changed: LoraJob[] = [];
  for (const job of listLoraJobs()) {
    if (["starting", "running", "cancelling"].includes(job.status)) {
      job.status = "recoverable";
      job.blockedReason = "服务重启后无法安全重连原训练进程，请从最近 checkpoint 恢复";
      delete job.pid;
      saveLoraJob(job);
      appendLoraEvent(job.id, { type: "recovered-after-restart", status: job.status });
      changed.push(job);
    } else if (job.status === "queued" || job.status === "blocked") {
      job.status = "queued";
      delete job.blockedReason;
      saveLoraJob(job);
      changed.push(job);
    }
  }
  return changed;
}

