import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type StudioConfig } from "./types.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const STYLES_DIR = join(DATA_DIR, "styles");
export const PROJECTS_DIR = join(DATA_DIR, "projects");
export const LORA_DIR = join(DATA_DIR, "lora");
export const LORA_JOBS_DIR = join(LORA_DIR, "jobs");
export const TEMPLATES_DIR = join(ROOT, "templates");
const CONFIG_PATH = join(DATA_DIR, "config.json");

export type PublicStudioConfig = Omit<StudioConfig, "falKey" | "arkApiKey"> & {
  secretsConfigured: { falKey: boolean; arkApiKey: boolean };
};

export function ensureDirs() {
  for (const d of [DATA_DIR, STYLES_DIR, PROJECTS_DIR, LORA_JOBS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

export function loadConfig(): StudioConfig {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  // 浅合并保新字段有默认值；prices/refPolicies 单独合并
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    prices: { ...DEFAULT_CONFIG.prices, ...(raw.prices ?? {}) },
    refPolicies: { ...DEFAULT_CONFIG.refPolicies, ...(raw.refPolicies ?? {}) },
  };
}

export function saveConfig(cfg: StudioConfig) {
  ensureDirs();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function publicConfig(cfg: StudioConfig = loadConfig()): PublicStudioConfig {
  const { falKey, arkApiKey, ...safe } = cfg;
  return { ...safe, secretsConfigured: { falKey: !!falKey, arkApiKey: !!arkApiKey } };
}

/** 接受 UI/CLI 的脱敏 patch；未显式提交密钥时保留已有 secret。 */
export function mergeConfigPatch(current: StudioConfig, patch: Record<string, unknown>): StudioConfig {
  const { secretsConfigured: _ignored, ...rest } = patch;
  const next = { ...current, ...rest } as StudioConfig;
  if (typeof patch.falKey !== "string") next.falKey = current.falKey;
  if (typeof patch.arkApiKey !== "string") next.arkApiKey = current.arkApiKey;
  next.prices = { ...current.prices, ...((patch.prices as Record<string, number> | undefined) ?? {}) };
  next.refPolicies = { ...current.refPolicies, ...((patch.refPolicies as StudioConfig["refPolicies"] | undefined) ?? {}) };
  return next;
}
