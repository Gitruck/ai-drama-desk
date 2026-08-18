import type { DeskApiClient } from "../lib/api-client.ts";
import { flag, required } from "../lib/args.ts";
import { printResult, type CliContext } from "../lib/output.ts";

interface Job {
  id: string;
  status: "queued" | "running" | "done" | "error" | "canceled";
  provider: string;
  output?: string;
  error?: string;
}

/** 角色参考图（人设锚点）生成：入队 → 轮询至全部终态 → 报产物路径。 */
export async function runCharRef(args: string[], ctx: CliContext, api: DeskApiClient): Promise<void> {
  if (!args[0] || args[0] === "help" || args[0] === "--help") {
    console.log(
      "charref <project-id> <角色名> --mode single|turnaround [--count N] [--provider comfyui-image|comfyui-image2|seedream-image|mock-image] [--desc 补充描述]\n" +
        "  single    = 素色底单人全身立绘\n" +
        "  turnaround= 同一角色正/侧/背三视图设定表（单人裁剪集的最佳裁剪源）\n" +
        "  provider 缺省 comfyui-image（现成开源模型，零前置兜底：无画风/无锚图/无 LoRA 也能出）",
    );
    return;
  }
  const project = required(args[0], "charref 需要 <project-id>");
  const name = required(args[1], "charref 需要 <角色名>");
  const mode = flag(args, "--mode") ?? "single";
  if (mode !== "single" && mode !== "turnaround") throw new Error("--mode 只支持 single|turnaround");
  const provider = flag(args, "--provider") ?? "comfyui-image";
  const countRaw = flag(args, "--count");
  const count = countRaw ? Math.max(1, Math.min(4, parseInt(countRaw, 10) || 1)) : 1;
  const desc = flag(args, "--desc");

  const submitted = await api.request<{ enqueued: number; jobs: Job[] }>(
    `/projects/${project}/characters/${encodeURIComponent(name)}/generate-ref`,
    { method: "POST", body: JSON.stringify({ mode, provider, count, ...(desc ? { desc } : {}) }) },
  );
  const ids = new Set(submitted.jobs.map((j) => j.id));
  if (!ctx.json) console.error(`已入队 ${submitted.enqueued} 个「${name}」${mode} 参考图任务（${provider}），等待生成…`);

  // 轮询 jobs 至提交的任务全部终态
  const deadline = Date.now() + 15 * 60_000;
  let done: Job[] = [];
  while (Date.now() < deadline) {
    const all = await api.request<Job[]>(`/jobs?project=${project}`);
    done = all.filter((j) => ids.has(j.id));
    if (done.length === ids.size && done.every((j) => j.status === "done" || j.status === "error")) break;
    await new Promise((r) => setTimeout(r, 2500));
  }

  const ok = done.filter((j) => j.status === "done");
  const failed = done.filter((j) => j.status === "error");
  const result = {
    ok: failed.length === 0,
    character: name,
    mode,
    generated: ok.map((j) => j.output).filter(Boolean),
    failed: failed.map((j) => ({ id: j.id, error: j.error })),
  };
  const human = [
    `「${name}」${mode}：成功 ${ok.length} / 失败 ${failed.length}`,
    ...result.generated.map((f) => `  ✓ ${f}`),
    ...result.failed.map((f) => `  ✗ ${f.id}: ${f.error}`),
    ok.length ? "产物已进该角色源图库，可在工作台角色卡挑选/裁剪。" : "",
  ].filter(Boolean).join("\n");
  return printResult(ctx, result, human);
}
