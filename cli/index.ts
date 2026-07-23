#!/usr/bin/env bun
import { EDITION_NOTICE } from "../shared/contracts/index.ts";
import { DeskApiClient } from "./lib/api-client.ts";
import { fail, printEditionNotice, printResult, type CliContext } from "./lib/output.ts";
import { runStyle } from "./commands/style.ts";
import { runLora } from "./commands/lora.ts";
import { runSkills } from "./commands/skills.ts";
import { runCharRef } from "./commands/charref.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const ctx: CliContext = { json };
const args = argv.filter((x) => x !== "--json");
const api = new DeskApiClient();

function help(): void {
  console.log(`gitruck-ai-drama-desk 0.2.0-beta.1\n${EDITION_NOTICE}\n\n用法：\n  gitruck-ai-drama-desk charref <project> <角色名> --mode single|turnaround [--provider P]\n  gitruck-ai-drama-desk style <list|create|edit|delete|import|export>\n  gitruck-ai-drama-desk lora <train|status|resume|cancel|publish>\n  gitruck-ai-drama-desk skills install [--agents <list>] [--copy]\n\n全局选项：\n  --json    stdout 仅输出机器可读 JSON\n\n详细用法见仓内 README 与 docs/ 使用手册`);
}

async function main(): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") return help();
  if (args[0] === "--version" || args[0] === "-V") return console.log(`gitruck-ai-drama-desk 0.2.0-beta.1 · ${EDITION_NOTICE}`);
  printEditionNotice(ctx);
  if (args[0] === "skills") return runSkills(args.slice(1), ctx);
  if (args[0] === "health") {
    const result = await api.request("/health");
    return printResult(ctx, result);
  }
  if (args[0] === "charref") return runCharRef(args.slice(1), ctx, api);
  if (args[0] === "style") return runStyle(args.slice(1), ctx, api);
  if (args[0] === "lora") return runLora(args.slice(1), ctx, api);
  throw new Error(`未知命令：${args.join(" ")}`);
}

main().catch((error) => fail(error, ctx));
