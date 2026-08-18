import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type StudioConfig } from "./types.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
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
export const PROJECTS_DIR = join(DATA_DIR, "projects");
export const LORA_DIR = join(DATA_DIR, "lora");
export const LORA_JOBS_DIR = join(LORA_DIR, "jobs");
export const TEMPLATES_DIR = join(ROOT, "templates");
const CONFIG_PATH = join(DATA_DIR, "config.json");

export type PublicStudioConfig = Omit<StudioConfig, "falKey" | "arkApiKey" | "pixmindKey"> & {
  secretsConfigured: { falKey: boolean; arkApiKey: boolean; pixmindKey: boolean };
};

export function ensureDirs() {
  for (const d of [DATA_DIR, STYLES_DIR, PROJECTS_DIR, LORA_JOBS_DIR]) {
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
