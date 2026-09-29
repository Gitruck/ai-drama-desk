import { basename, resolve } from "node:path";
import type { DeskApiClient } from "../lib/api-client.ts";
import { printResult, type CliContext } from "../lib/output.ts";

export async function runKeyframe(args: string[], ctx: CliContext, api: DeskApiClient): Promise<void> {
  const [action, project, index, file] = args;
  if (!action || action === "--help") {
    console.log("keyframe <import|choose|review|status> <project-id> <shot-index> <image-path|filename|review-json>\nimport 上传外部关键帧；choose 选择候选；review 提交逐镜审阅 JSON；status 查询候选审阅状态。"); return;
  }
  if (!project || !/^[a-z0-9-]+$/.test(project) || !index || !/^[1-9]\d*$/.test(index) || !file || args.length !== 4) throw new Error("需要合法项目id、正整数镜号、文件参数");
  const base = `/projects/${project}/shots/${index}`;
  let result: unknown;
  if (action === "import") {
    const path = resolve(file); const blob = Bun.file(path);
    if (!(await blob.exists())) throw new Error(`文件不存在：${path}`);
    const form = new FormData(); form.append("file", blob, basename(path));
    result = await api.request(`${base}/keyframe/import`, { method: "POST", body: form });
  } else if (action === "review") {
    result = await api.request(`${base}/keyframe/review`, { method: "POST", body: JSON.stringify(await Bun.file(resolve(file)).json()) });
  } else if (action === "status") {
    result = await api.request(`${base}/keyframe/review?file=${encodeURIComponent(file)}`);
  } else if (action === "choose") {
    result = await api.request(`${base}/choose`, { method: "POST", body: JSON.stringify({ kind: "keyframe", file }) });
  } else throw new Error(`未知 keyframe 子命令：${action}`);
  printResult(ctx, result);
}
