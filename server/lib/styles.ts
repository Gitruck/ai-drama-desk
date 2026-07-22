import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { assertStyleProfile, isSafeId, isSafeOutputId, type StylePackManifest } from "../../shared/contracts/index.ts";
import { STYLES_DIR } from "./config.ts";
import { listProjects, saveProject } from "./projects.ts";
import type { StyleProfile } from "./types.ts";

export class StyleError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "BAD_REQUEST", public readonly details?: unknown) {
    super(message);
  }
}

function assertStyleId(id: string): void {
  if (!isSafeId(id)) throw new StyleError("画风 id 需为小写字母数字连字符");
}

function styleDir(id: string): string {
  assertStyleId(id);
  return join(STYLES_DIR, id);
}

function profilePath(id: string) {
  return join(styleDir(id), "profile.json");
}

function normalizeProfile(raw: StyleProfile): StyleProfile {
  return {
    schemaVersion: "gitruck.style-profile/v1",
    ...raw,
    refs: Array.isArray(raw.refs) ? raw.refs.filter(isSafeOutputId) : [],
    refMeta: Array.isArray(raw.refMeta) ? raw.refMeta.filter((x) => isSafeOutputId(x.file)) : [],
  };
}

export function listStyles(): StyleProfile[] {
  if (!existsSync(STYLES_DIR)) return [];
  const out: StyleProfile[] = [];
  for (const d of readdirSync(STYLES_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || !isSafeId(d.name) || !existsSync(profilePath(d.name))) continue;
    try {
      out.push(normalizeProfile(JSON.parse(readFileSync(profilePath(d.name), "utf-8")) as StyleProfile));
    } catch {
      console.error(`跳过损坏的画风档案: ${d.name}`);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function getStyle(id: string): StyleProfile | null {
  assertStyleId(id);
  if (!existsSync(profilePath(id))) return null;
  return normalizeProfile(JSON.parse(readFileSync(profilePath(id), "utf-8")) as StyleProfile);
}

export function saveStyle(profile: StyleProfile): StyleProfile {
  const next = normalizeProfile({ ...profile, updatedAt: new Date().toISOString() });
  assertStyleProfile(next);
  const dir = styleDir(next.id);
  mkdirSync(join(dir, "refs"), { recursive: true });
  const target = profilePath(next.id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, target);
  return next;
}

export function styleRefPath(id: string, file: string) {
  if (!isSafeOutputId(file)) throw new StyleError("参考图文件名非法", 403, "PATH_FORBIDDEN");
  return join(styleDir(id), "refs", file);
}

/** 把外部图片文件收进画风档案的 refs/。 */
export function addStyleRefs(id: string, files: { name: string; data: Uint8Array }[]): StyleProfile {
  const profile = getStyle(id);
  if (!profile) throw new StyleError(`画风档案不存在: ${id}`, 404, "NOT_FOUND");
  for (const file of files) {
    if (!isSafeOutputId(file.name) || !/\.(png|jpe?g|webp)$/i.test(file.name)) throw new StyleError(`参考图文件名或类型非法: ${file.name}`);
    writeFileSync(styleRefPath(id, file.name), file.data);
    if (!profile.refs.includes(file.name)) profile.refs.push(file.name);
    const sha256 = createHash("sha256").update(file.data).digest("hex");
    profile.refMeta = [...(profile.refMeta ?? []).filter((x) => x.file !== file.name), { file: file.name, sha256 }];
  }
  profile.refs.sort();
  return saveStyle(profile);
}

export function removeStyleRef(id: string, file: string): StyleProfile {
  const profile = getStyle(id);
  if (!profile) throw new StyleError("画风档案不存在", 404, "NOT_FOUND");
  if (!profile.refs.includes(file)) throw new StyleError("参考图不存在或不属于该画风", 404, "NOT_FOUND");
  const target = styleRefPath(id, file);
  if (!existsSync(target)) throw new StyleError("参考图文件不存在", 404, "NOT_FOUND");
  unlinkSync(target);
  profile.refs = profile.refs.filter((x) => x !== file);
  profile.refMeta = (profile.refMeta ?? []).filter((x) => x.file !== file);
  return saveStyle(profile);
}

export function styleUsage(id: string): Array<{ id: string; name: string }> {
  assertStyleId(id);
  return listProjects().filter((p) => p.styleId === id).map((p) => ({ id: p.id, name: p.name }));
}

function removeStyleDirectory(id: string): void {
  const base = resolve(STYLES_DIR);
  const target = resolve(styleDir(id));
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new StyleError("画风目录越界", 403, "PATH_FORBIDDEN");
  rmSync(target, { recursive: true, force: false });
}

export function deleteStyle(id: string, opts: { replacementStyleId?: string; force?: boolean } = {}): { deleted: string; affectedProjects: string[] } {
  const profile = getStyle(id);
  if (!profile) throw new StyleError("画风档案不存在", 404, "NOT_FOUND");
  const affected = styleUsage(id);
  let replacement: StyleProfile | null = null;
  if (opts.replacementStyleId) {
    if (opts.replacementStyleId === id) throw new StyleError("替代画风不能是自身");
    replacement = getStyle(opts.replacementStyleId);
    if (!replacement) throw new StyleError("替代画风不存在", 404, "NOT_FOUND");
  }
  if (affected.length && !replacement && !opts.force) {
    throw new StyleError("画风仍被项目引用", 409, "CONFLICT", { projects: affected });
  }
  for (const ref of affected) {
    const project = listProjects().find((p) => p.id === ref.id);
    if (!project) continue;
    project.styleId = replacement?.id;
    project.styleRefPicks = replacement?.refs.slice(0, 2) ?? [];
    saveProject(project);
  }
  removeStyleDirectory(id);
  return { deleted: id, affectedProjects: affected.map((x) => x.id) };
}

export function exportStylePack(id: string, includeRefs = false, licenseConfirmed = false): StylePackManifest {
  const profile = getStyle(id);
  if (!profile) throw new StyleError("画风档案不存在", 404, "NOT_FOUND");
  if (includeRefs && !licenseConfirmed) throw new StyleError("包含参考图导出前必须确认许可");
  const portableProfile = profile.lora
    ? { ...profile, lora: { ...profile.lora, baseModel: typeof profile.lora.baseModel === "string" ? basename(profile.lora.baseModel) : profile.lora.baseModel, weightsPath: typeof profile.lora.weightsPath === "string" ? basename(profile.lora.weightsPath) : profile.lora.weightsPath } }
    : profile;
  const pack: StylePackManifest = {
    schemaVersion: "gitruck.style-pack/v1",
    exportedAt: new Date().toISOString(),
    profile: includeRefs ? portableProfile : { ...portableProfile, refs: [] },
    includes: { refs: includeRefs, weights: false },
    licenseConfirmed,
  };
  if (includeRefs) {
    pack.referenceFiles = profile.refs.map((file) => {
      const data = readFileSync(styleRefPath(id, file));
      return { file, sha256: createHash("sha256").update(data).digest("hex"), base64: data.toString("base64") };
    });
  }
  return pack;
}

export function importStylePack(
  value: unknown,
  opts: { conflict?: "error" | "overwrite" | "rename"; id?: string } = {},
): StyleProfile {
  if (!value || typeof value !== "object") throw new StyleError("Style Pack 必须是对象");
  const pack = value as StylePackManifest;
  if (pack.schemaVersion !== "gitruck.style-pack/v1") throw new StyleError("不支持的 Style Pack 版本");
  let profile = normalizeProfile({ ...pack.profile });
  if (opts.id) profile.id = opts.id;
  assertStyleProfile(profile);
  const existing = getStyle(profile.id);
  const conflict = opts.conflict ?? "error";
  if (existing && conflict === "error") throw new StyleError("画风 ID 冲突，请选择 overwrite 或 rename", 409, "CONFLICT");
  if (existing && conflict === "rename") {
    const stem = profile.id;
    let n = 2;
    while (getStyle(`${stem}-${n}`)) n++;
    profile.id = `${stem}-${n}`;
  }
  if (existing && conflict === "overwrite") {
    const refsDir = join(styleDir(profile.id), "refs");
    if (existsSync(refsDir)) rmSync(refsDir, { recursive: true, force: true });
  }
  profile.refs = [];
  saveStyle(profile);
  for (const file of pack.referenceFiles ?? []) {
    if (!isSafeOutputId(file.file)) throw new StyleError("Style Pack 参考图文件名非法");
    const data = Buffer.from(file.base64, "base64");
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== file.sha256) throw new StyleError(`参考图哈希不匹配: ${file.file}`);
    profile = addStyleRefs(profile.id, [{ name: file.file, data }]);
  }
  return profile;
}
