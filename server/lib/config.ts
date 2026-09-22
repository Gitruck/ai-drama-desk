import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type StudioConfig } from "./types.ts";

/**
 * 程序资源根目录。源码运行时由模块位置推导；便携包由启动器显式指到 `app/`。
 * 用户数据不放这里，仍由 GITRUCK_DESK_DATA_DIR 独立控制。
 */
export const ROOT = process.env.GITRUCK_DESK_ROOT
  ? resolve(process.env.GITRUCK_DESK_ROOT)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/**
 * 数据根目录。默认 `<仓库>/data`，可用 `GITRUCK_DESK_DATA_DIR` 覆盖。
 *
 * 存在的理由是安全而非灵活：这里面有 config.json（装着 falKey / arkApiKey /
 * pixmindKey 三把明文密钥）与全部项目产物，而测试要验配置相关行为就得改 config.json。
 * 没有这个覆盖时，测试只能去动用户真实的那一份、靠 try/finally 还原——
 * 而 finally 在进程被中断时不保证执行。2026-08-18 就是这样把主理人的三把 Key
 * 弄丢的：一个探针把 config.json 改坏以触发异常，异常恰好把还原的 finally 吃掉了。
 * 现在测试统一跑在隔离目录上（见 test/setup.ts），真实数据碰都碰不到。
 */
export const DATA_DIR = process.env.GITRUCK_DESK_DATA_DIR
  ? resolve(process.env.GITRUCK_DESK_DATA_DIR)
  : join(ROOT, "data");
export const STYLES_DIR = join(DATA_DIR, "styles");
/**
 * 产物根的**默认**位置。真正该用的是 `projectsRoot()`——用户可以把它改到别的盘。
 *
 * ⚠️ 这个常量**只是默认值**，MUST NOT 拿它拼项目路径。
 * 实测一条片子 351 MB、其中 97% 是 projects/，而默认位置在系统盘的用户目录。
 * 任何 `join(DEFAULT_PROJECTS_DIR, …)` 都会绕过用户的设置、把产物写回 C 盘。
 * 仓里有一道用例（`projects-root-no-bypass.test.ts`）专门盯着这件事。
 */
export const DEFAULT_PROJECTS_DIR = join(DATA_DIR, "projects");
export const LORA_DIR = join(DATA_DIR, "lora");
export const LORA_JOBS_DIR = join(LORA_DIR, "jobs");
export const TEMPLATES_DIR = join(ROOT, "templates");
const CONFIG_PATH = join(DATA_DIR, "config.json");

/**
 * 产物根的当刻真值（add-configurable-workspace-root）。
 *
 * **直接读 config.json，不走 `loadConfig()`**，理由两条：
 *  ① `loadConfig()` 在文件缺失时会**写**一份默认配置——「问一下项目根在哪」不该有写副作用；
 *  ② `ensureDirs()` 要用它，而 `loadConfig()` 的写入又要求 DATA_DIR 已存在，绕成环。
 *
 * 配置坏了 ⇒ 回落默认而不是抛：一份读不动的 config.json 不该让程序连自己的项目都找不到。
 *
 * 缓存按 config.json 的 mtime 失效——`projectDir()` 是热路径，每次读盘解析 JSON 不值当；
 * 但用 mtime 而不是「保存时手动失效」，是因为测试与外部工具会直接改文件，
 * 手动失效在那些路径上一定会漏。
 */
let projectsRootCache: { mtimeMs: number; value: string } | null = null;

export function projectsRoot(): string {
  try {
    if (!existsSync(CONFIG_PATH)) return DEFAULT_PROJECTS_DIR;
    const { mtimeMs } = statSync(CONFIG_PATH);
    if (projectsRootCache && projectsRootCache.mtimeMs === mtimeMs) return projectsRootCache.value;
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { projectsRoot?: unknown };
    const v = typeof raw.projectsRoot === "string" && raw.projectsRoot.trim() ? resolve(raw.projectsRoot.trim()) : DEFAULT_PROJECTS_DIR;
    projectsRootCache = { mtimeMs, value: v };
    return v;
  } catch {
    return DEFAULT_PROJECTS_DIR;
  }
}

/** 当刻产物根是不是默认位置（`/api/paths` 要告诉界面「这是默认还是你改过的」）。 */
export function projectsRootIsDefault(): boolean {
  return projectsRoot() === DEFAULT_PROJECTS_DIR;
}

export type PublicStudioConfig = Omit<StudioConfig, "falKey" | "arkApiKey" | "pixmindKey"> & {
  secretsConfigured: { falKey: boolean; arkApiKey: boolean; pixmindKey: boolean };
};

export function ensureDirs() {
  // ⚠️ DATA_DIR MUST 先建：`projectsRoot()` 要读 DATA_DIR 下的 config.json。
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  for (const d of [STYLES_DIR, projectsRoot(), LORA_JOBS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/**
 * comfy workflow 配置在读取时补全结构性 nodeMap 字段。
 * 仅当持久化配置用的是 DEFAULT 的同名 stock 模板时，才把默认 nodeMap 里
 * 后加的键（如 loraName / loraStrength）补进陈旧配置——键级浅合并，用户已有的
 * 键（含自定义 node id 与 imageInputs 数组）原样胜出。自定义模板（template 名不同）
 * 尊重用户配置、不注入默认节点映射，避免把默认 node id 塞进结构不同的自定义图。
 */
export function mergeComfyConfig(
  key: "comfyImage" | "comfyImage2" | "comfyVideo" | "comfyVideoHunyuan" | "comfyVideoH3" | "comfyVideoH3Final",
  raw: Record<string, any>,
): StudioConfig[typeof key] {
  const rawCfg = raw[key];
  const defaultCfg = DEFAULT_CONFIG[key];
  if (!rawCfg) return defaultCfg;
  if (!defaultCfg || rawCfg.template !== defaultCfg.template) return rawCfg;
  return { ...defaultCfg, ...rawCfg, nodeMap: { ...defaultCfg.nodeMap, ...rawCfg.nodeMap } };
}

export function loadConfig(): StudioConfig {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  // 浅合并保新字段有默认值；prices/refPolicies 单独合并；comfy 配置补全结构性 nodeMap 字段
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    prices: { ...DEFAULT_CONFIG.prices, ...(raw.prices ?? {}) },
    refPolicies: { ...DEFAULT_CONFIG.refPolicies, ...(raw.refPolicies ?? {}) },
    comfyImage: mergeComfyConfig("comfyImage", raw),
    comfyImage2: mergeComfyConfig("comfyImage2", raw),
    comfyVideo: mergeComfyConfig("comfyVideo", raw),
    comfyVideoHunyuan: mergeComfyConfig("comfyVideoHunyuan", raw),
    comfyVideoH3: mergeComfyConfig("comfyVideoH3", raw),
    comfyVideoH3Final: mergeComfyConfig("comfyVideoH3Final", raw),
  };
}

export function saveConfig(cfg: StudioConfig) {
  ensureDirs();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function publicConfig(cfg: StudioConfig = loadConfig()): PublicStudioConfig {
  const { falKey, arkApiKey, pixmindKey, ...safe } = cfg;
  return { ...safe, secretsConfigured: { falKey: !!falKey, arkApiKey: !!arkApiKey, pixmindKey: !!pixmindKey } };
}

/** 接受 UI/CLI 的脱敏 patch；未显式提交密钥时保留已有 secret。 */
export function mergeConfigPatch(current: StudioConfig, patch: Record<string, unknown>): StudioConfig {
  const { secretsConfigured: _ignored, ...rest } = patch;
  const next = { ...current, ...rest } as StudioConfig;
  if (typeof patch.falKey !== "string") next.falKey = current.falKey;
  if (typeof patch.arkApiKey !== "string") next.arkApiKey = current.arkApiKey;
  if (typeof patch.pixmindKey !== "string") next.pixmindKey = current.pixmindKey;
  next.prices = { ...current.prices, ...((patch.prices as Record<string, number> | undefined) ?? {}) };
  next.refPolicies = { ...current.refPolicies, ...((patch.refPolicies as StudioConfig["refPolicies"] | undefined) ?? {}) };
  return next;
}
