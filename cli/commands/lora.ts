import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LoraJob, LoraTrainRequest } from "../../shared/contracts/index.ts";
import { DeskApiClient } from "../lib/api-client.ts";
import { confirmOrThrow, flag, required } from "../lib/args.ts";
import { printResult, type CliContext } from "../lib/output.ts";

function jobLine(job: LoraJob): string {
  const progress = job.progress ? ` ${job.progress.absoluteStep}/${job.progress.totalAbsoluteSteps}` : "";
  const reason = job.blockedReason ?? job.error;
  return `${job.id}\t${job.status}${progress}${reason ? `\t${reason}` : ""}`;
}

export async function runLora(args: string[], ctx: CliContext, api: DeskApiClient): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help") {
    console.log("lora 子命令：train --file training.json | status [job-id] | resume <job-id> | cancel <job-id> --yes | publish <job-id> --style <style-id>");
    return;
  }
  if (sub === "train") {
    const file = resolve(required(flag(args, "--file"), "train 需要 --file <training.json>"));
    const request = JSON.parse(readFileSync(file, "utf8")) as LoraTrainRequest;
    const validation = await api.request<{ ok: boolean; missing: string[] }>("/lora/validate", { method: "POST", body: JSON.stringify(request) });
    if (!validation.ok) throw new Error(`训练配置不完整：${validation.missing.join("、")}`);
    const job = await api.request<LoraJob>("/lora/jobs", { method: "POST", body: JSON.stringify(request) });
    return printResult(ctx, job, `已提交 LoRA 任务：${job.id}\n${jobLine(job)}`);
  }
  if (sub === "status") {
    const id = args[1];
    if (id) {
      const job = await api.request<LoraJob>(`/lora/jobs/${id}`);
      return printResult(ctx, job, jobLine(job));
    }
    const jobs = await api.request<LoraJob[]>("/lora/jobs");
    return printResult(ctx, jobs, jobs.map(jobLine).join("\n") || "LoRA 任务列表为空");
  }
  const id = required(args[1], `${sub} 需要 <job-id>`);
  if (sub === "cancel") {
    await confirmOrThrow(args, `取消 LoRA 任务 ${id}？`);
    const job = await api.request<LoraJob>(`/lora/jobs/${id}/cancel`, { method: "POST" });
    return printResult(ctx, job, jobLine(job));
  }
  if (sub === "resume") {
    const job = await api.request<LoraJob>(`/lora/jobs/${id}/resume`, { method: "POST" });
    return printResult(ctx, job, `已从 checkpoint 创建恢复任务：${job.id}\n${jobLine(job)}`);
  }
  if (sub === "publish") {
    const styleId = required(flag(args, "--style"), "publish 需要 --style <style-id>");
    const job = await api.request<LoraJob>(`/lora/jobs/${id}/publish`, { method: "POST", body: JSON.stringify({ styleId }) });
    return printResult(ctx, job, `已将 ${id} 的 LoRA 发布到画风 ${styleId}`);
  }
  throw new Error(`未知 lora 子命令：${sub}`);
}
