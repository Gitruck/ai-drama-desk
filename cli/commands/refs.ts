import { basename, resolve } from "node:path";
import type { DeskApiClient } from "../lib/api-client.ts";
import { required } from "../lib/args.ts";
import { printResult, type CliContext } from "../lib/output.ts";

/**
 * 角色源图管理。upload = 宿主生图路线的落库闭环：
 * Agent 用自带生图能力（image2 / GPT 等）出图后，一条命令经服务端校验进源图库（即刻进双参考集）。
 */
export async function runRefs(args: string[], ctx: CliContext, api: DeskApiClient): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help") {
    console.log("refs 子命令：upload <project-id> <角色名> <文件...>  把本地图片上传进该角色源图库（png/jpg/webp，≤20MB，服务端魔数校验）");
    return;
  }
  if (sub === "upload") {
    const project = required(args[1], "upload 需要 <project-id>");
    const name = required(args[2], "upload 需要 <角色名>");
    const files = args.slice(3).filter((x) => !x.startsWith("--"));
    if (files.length === 0) throw new Error("upload 需要至少一个图片文件路径");

    const form = new FormData();
    for (const f of files) {
      const path = resolve(f);
      const blob = Bun.file(path);
      if (!(await blob.exists())) throw new Error(`文件不存在：${path}`);
      form.append("files", blob, basename(path));
    }
    const result = await api.request<{ refs: string[] }>(
      `/projects/${project}/characters/${encodeURIComponent(name)}/refs`,
      { method: "POST", body: form },
    );
    return printResult(ctx, { ok: true, uploaded: files.length, refs: result.refs },
      `已上传 ${files.length} 张进「${name}」源图库（现共 ${result.refs.length} 张）；已自动进入双参考集，可在工作台挑选/裁剪。`);
  }
  throw new Error(`未知 refs 子命令：${sub}`);
}
