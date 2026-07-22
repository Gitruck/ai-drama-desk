import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StylePackManifest, StyleProfileContract } from "../../shared/contracts/index.ts";
import { DeskApiClient } from "../lib/api-client.ts";
import { confirmOrThrow, flag, hasFlag, required } from "../lib/args.ts";
import { printResult, type CliContext } from "../lib/output.ts";

export async function runStyle(args: string[], ctx: CliContext, api: DeskApiClient): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help") {
    console.log("style 子命令：list | create --file profile.json | edit <id> --file patch.json | delete <id> --yes [--replace-with id|--force] | import <pack.json> [--conflict rename] | export <id> --out pack.json [--include-refs --license-confirmed]");
    return;
  }
  if (sub === "list") {
    const styles = await api.request<StyleProfileContract[]>("/styles");
    return printResult(ctx, styles, styles.map((x) => `${x.id}\t${x.name}${x.lora ? "\tLoRA" : ""}`).join("\n") || "画风库为空");
  }
  if (sub === "create") {
    const file = required(flag(args, "--file"), "create 需要 --file <profile.json>");
    const profile = JSON.parse(readFileSync(resolve(file), "utf8"));
    const result = await api.request<StyleProfileContract>("/styles", { method: "POST", body: JSON.stringify(profile) });
    return printResult(ctx, result, `已创建画风：${result.id}`);
  }
  if (sub === "edit") {
    const id = required(args[1], "edit 需要 <style-id>");
    const file = required(flag(args, "--file"), "edit 需要 --file <patch.json>");
    const patch = JSON.parse(readFileSync(resolve(file), "utf8"));
    const result = await api.request<StyleProfileContract>(`/styles/${id}`, { method: "PUT", body: JSON.stringify(patch) });
    return printResult(ctx, result, `已修改画风：${result.id}`);
  }
  if (sub === "delete") {
    const id = required(args[1], "delete 需要 <style-id>");
    await confirmOrThrow(args, `永久删除画风 ${id}？`);
    const result = await api.request(`/styles/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmed: true, replacementStyleId: flag(args, "--replace-with"), force: hasFlag(args, "--force") }),
    });
    return printResult(ctx, result, `已删除画风：${id}`);
  }
  if (sub === "import") {
    const file = required(args[1], "import 需要 <style-pack.json>");
    const pack = JSON.parse(readFileSync(resolve(file), "utf8"));
    const conflict = flag(args, "--conflict") ?? "error";
    if (!["error", "overwrite", "rename"].includes(conflict)) throw new Error("--conflict 只支持 error|overwrite|rename");
    const result = await api.request<StyleProfileContract>("/styles/import", { method: "POST", body: JSON.stringify({ pack, conflict }) });
    return printResult(ctx, result, `已导入画风：${result.id}`);
  }
  if (sub === "export") {
    const id = required(args[1], "export 需要 <style-id>");
    const out = resolve(required(flag(args, "--out"), "export 需要 --out <style-pack.json>"));
    const includeRefs = hasFlag(args, "--include-refs");
    const licenseConfirmed = hasFlag(args, "--license-confirmed");
    const pack = await api.request<StylePackManifest>(`/styles/${id}/pack?includeRefs=${includeRefs}&licenseConfirmed=${licenseConfirmed}`);
    writeFileSync(out, JSON.stringify(pack, null, 2));
    return printResult(ctx, { ok: true, file: out, includes: pack.includes }, `已导出：${out}`);
  }
  throw new Error(`未知 style 子命令：${sub}`);
}

