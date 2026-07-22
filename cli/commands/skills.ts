// gitruck-ai-drama-desk skills —— 把仓内 skills/ 正本安装到各类 Agent。
//
// 机制对齐 gtrk-cli：以 ~/.agents/skills 为统一正本存储，再为每个检测到的
// Agent 兼容目录创建 junction（Windows）/ 符号链接（POSIX）指回正本；
// 链接失败自动回退为复制。skill 集合运行时扫描 skills/ 目录（含 SKILL.md
// 的子目录即视为一个 skill），不硬编码 skill 名。幂等可重跑。

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flag, hasFlag } from "../lib/args.ts";
import { printResult, type CliContext } from "../lib/output.ts";

/** 仓根（cli/commands/ 的上两级），skills/ 正本从这里取。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface KnownAgent {
  id: string;
  displayName: string;
  /** 用户主目录下的 Agent 数据目录（存在即视为检测到该宿主）。 */
  dataDir: string;
  /** 该宿主的全局 skills 目录（相对 dataDir）。 */
  skillsSubdir: string;
  /** 默认安装总是包含（无论是否检测到）。 */
  alwaysOn?: boolean;
}

/** 已登记宿主表：至少覆盖 Claude；其余对齐 gtrk-cli 的宿主目录约定。 */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { id: "claude-code", displayName: "Claude Code", dataDir: ".claude", skillsSubdir: "skills", alwaysOn: true },
  { id: "codex", displayName: "Codex", dataDir: ".codex", skillsSubdir: "skills" },
  { id: "cursor", displayName: "Cursor", dataDir: ".cursor", skillsSubdir: "skills" },
  { id: "gemini-cli", displayName: "Gemini CLI", dataDir: ".gemini", skillsSubdir: "skills" },
  { id: "trae", displayName: "Trae", dataDir: ".trae", skillsSubdir: "skills" },
  { id: "workbuddy", displayName: "WorkBuddy", dataDir: ".workbuddy", skillsSubdir: "skills" },
  { id: "qoderwork", displayName: "QoderWork", dataDir: ".qoderwork", skillsSubdir: "skills" },
  { id: "comate", displayName: "Baidu Comate", dataDir: ".comate", skillsSubdir: "skills" },
] as const;

/** 常见品牌写法兼容。 */
const AGENT_ALIASES: Readonly<Record<string, string>> = {
  claude: "claude-code",
  gemini: "gemini-cli",
  "openai-codex": "codex",
  "tencent-workbuddy": "workbuddy",
  "qoder-work": "qoderwork",
  "baidu-comate": "comate",
};

const SAFE_AGENT_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

export function parseAgentIds(input?: string): string[] {
  const values = (input ?? "")
    .split(/[\s,]+/u)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => AGENT_ALIASES[value] ?? value);
  const invalid = values.filter((value) => !SAFE_AGENT_ID.test(value));
  if (invalid.length > 0) throw new Error(`Agent ID 格式不合法：${invalid.join(", ")}`);
  const unknown = values.filter((value) => !KNOWN_AGENTS.some((agent) => agent.id === value));
  if (unknown.length > 0) {
    throw new Error(`未登记的 Agent：${unknown.join(", ")}（支持：${KNOWN_AGENTS.map((a) => a.id).join(", ")}）`);
  }
  return [...new Set(values)];
}

export interface SkillsInstallOptions {
  /** 逗号/空格分隔的 Agent ID；缺省 = Claude + 检测到的其余宿主。 */
  agents?: string;
  /** 不建链接，每个 Agent 各复制一份。 */
  copy?: boolean;
  /** 仅供测试覆盖：skills 正本来源目录（默认仓内 skills/）。 */
  source?: string;
  /** 仅供测试覆盖：用户主目录。 */
  home?: string;
}

export type InstallMode = "junction" | "symlink" | "copy";

export interface AgentInstallResult {
  agent: string;
  displayName: string;
  dir: string;
  entries: Array<{ skill: string; mode: InstallMode; path: string }>;
}

export interface SkillsInstallReport {
  ok: true;
  source: string;
  store: string;
  skills: string[];
  targets: AgentInstallResult[];
}

/** 扫描来源目录：含 SKILL.md 的子目录即为一个 skill（不硬编码名字）。 */
export function listSkills(source: string): string[] {
  if (!existsSync(source)) throw new Error(`找不到 skills 来源目录：${source}`);
  return readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(source, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

/** 缺省安装目标 = alwaysOn 宿主 + 数据目录存在的宿主；显式 --agents 即使目录不存在也创建。 */
export function resolveTargetAgents(opts: SkillsInstallOptions, home: string): KnownAgent[] {
  const explicit = parseAgentIds(opts.agents);
  if (explicit.length > 0) {
    return KNOWN_AGENTS.filter((agent) => explicit.includes(agent.id));
  }
  return KNOWN_AGENTS.filter((agent) => agent.alwaysOn || existsSync(join(home, agent.dataDir)));
}

/** 幂等替换：无论旧状态是目录、链接还是失效链接，一律清掉重建。 */
function removeExisting(path: string): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

function linkOrCopy(storePath: string, targetPath: string, forceCopy: boolean): InstallMode {
  removeExisting(targetPath);
  if (!forceCopy) {
    try {
      // Windows 用 junction（无需管理员权限）；POSIX 忽略 type 参数走普通符号链接。
      symlinkSync(storePath, targetPath, "junction");
      return process.platform === "win32" ? "junction" : "symlink";
    } catch {
      // 落到复制兜底。
    }
  }
  cpSync(storePath, targetPath, { recursive: true });
  return "copy";
}

/**
 * 安装仓内 skills：先把 skills/ 正本同步进 ~/.agents/skills/<skill名>，
 * 再链接/复制到各目标 Agent 的全局 skills 目录。
 */
export function installSkills(opts: SkillsInstallOptions = {}): SkillsInstallReport {
  const source = resolve(opts.source ?? join(REPO_ROOT, "skills"));
  const home = resolve(opts.home ?? homedir());
  const skills = listSkills(source);
  if (skills.length === 0) throw new Error(`skills 来源目录里没有任何含 SKILL.md 的子目录：${source}`);

  // 1) 统一正本：~/.agents/skills/<skill名>
  const store = join(home, ".agents", "skills");
  mkdirSync(store, { recursive: true });
  for (const skill of skills) {
    const dest = join(store, skill);
    removeExisting(dest);
    cpSync(join(source, skill), dest, { recursive: true });
  }

  // 2) 各 Agent 兼容目录：junction/symlink 指回正本，失败或 --copy 时复制
  const targets: AgentInstallResult[] = [];
  for (const agent of resolveTargetAgents(opts, home)) {
    const dir = join(home, agent.dataDir, agent.skillsSubdir);
    mkdirSync(dir, { recursive: true });
    const entries = skills.map((skill) => {
      const targetPath = join(dir, skill);
      const mode = linkOrCopy(join(store, skill), targetPath, opts.copy === true);
      return { skill, mode, path: targetPath };
    });
    targets.push({ agent: agent.id, displayName: agent.displayName, dir, entries });
  }
  return { ok: true, source, store, skills, targets };
}

function helpText(): string {
  return [
    "skills 子命令：install [--agents <list>] [--copy]",
    "",
    "  install          把仓内 skills/ 正本安装到各 Agent（统一存储 ~/.agents/skills + junction/符号链接）",
    "  --agents <list>  只装指定 Agent，逗号分隔，如 claude,codex,cursor；缺省自动检测",
    "  --copy           不建链接，每个 Agent 各复制一份",
    "",
    `已登记宿主：${KNOWN_AGENTS.map((a) => a.id).join(", ")}`,
  ].join("\n");
}

export async function runSkills(args: string[], ctx: CliContext): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help") {
    console.log(helpText());
    return;
  }
  if (sub === "install") {
    const report = installSkills({ agents: flag(args, "--agents"), copy: hasFlag(args, "--copy") });
    const lines = [
      `已同步正本：${report.store}（${report.skills.length} 个 skill：${report.skills.join(", ")}）`,
      ...report.targets.map(
        (target) => `→ ${target.displayName}：${target.dir}（${target.entries.map((e) => `${e.skill}=${e.mode}`).join("，")}）`,
      ),
      "若当前会话没有立刻出现新 skill，请刷新窗口或新开一个会话。",
    ];
    return printResult(ctx, report, lines.join("\n"));
  }
  throw new Error(`未知 skills 子命令：${sub}`);
}
