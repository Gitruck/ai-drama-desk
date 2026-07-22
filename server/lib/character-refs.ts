import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { characterDir, getProject, listCharacterRefs, saveProject } from "./projects.ts";
import type {
  CharacterGenerationReference,
  CharacterGenerationReferenceView,
  CharacterMultiRefView,
  CharacterRefSets,
  ImageCropRect,
  Project,
} from "./types.ts";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const DERIVED_FILE = /^generation\/[a-z0-9][a-z0-9._-]*\.png$/i;

/** 上传源图单文件大小上限（20MB） */
export const MAX_CHARACTER_REF_BYTES = 20 * 1024 * 1024;

export class CharacterReferenceError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "BAD_REQUEST",
    public details?: unknown,
  ) {
    super(message);
  }
}

function assertCharacter(p: Project, name: string) {
  const character = p.doc.characters.find((item) => item.name === name);
  if (!character) throw new CharacterReferenceError("角色不存在", 404);
  return character;
}

function assertSourceFileName(source: string) {
  if (basename(source) !== source || !IMAGE_EXT.test(source)) {
    throw new CharacterReferenceError("角色参考图文件名非法", 400, "PATH_FORBIDDEN");
  }
}

function originalPath(p: Project, name: string, source: string): string {
  assertSourceFileName(source);
  if (!listCharacterRefs(p.id, name).includes(source)) {
    throw new CharacterReferenceError("角色参考图不存在", 404);
  }
  return join(characterDir(p.id, name), source);
}

function derivedDir(projectId: string, name: string): string {
  return join(characterDir(projectId, name), "generation");
}

function storedReferencePath(p: Project, name: string, file: string): string | null {
  if (basename(file) === file && IMAGE_EXT.test(file)) {
    const path = join(characterDir(p.id, name), file);
    return existsSync(path) ? path : null;
  }
  const normalized = file.replace(/\\/g, "/");
  if (!DERIVED_FILE.test(normalized)) return null;
  const path = join(derivedDir(p.id, name), basename(normalized));
  return existsSync(path) ? path : null;
}

function removeDerived(p: Project, name: string, ref?: CharacterGenerationReference, keep?: string) {
  if (!ref) return;
  const normalized = ref.file.replace(/\\/g, "/");
  if (!DERIVED_FILE.test(normalized) || normalized === keep) return;
  rmSync(join(derivedDir(p.id, name), basename(normalized)), { force: true });
}

/**
 * 双参考集读取（懒迁移）：project.json 尚无 characterRefSets 时，
 * 旧 characterGenerationRefs 视为 single 集内容；multi 无记录 = 默认全选。
 * 只在写路径落盘新结构，旧字段保留原样（可回滚）。
 */
export function refSetsOf(p: Project): CharacterRefSets {
  if (p.characterRefSets) {
    return {
      single: { ...(p.characterRefSets.single ?? {}) },
      multi: { ...(p.characterRefSets.multi ?? {}) },
    };
  }
  return { single: { ...(p.characterGenerationRefs ?? {}) }, multi: {} };
}

export function characterGenerationReferenceView(
  p: Project,
  name: string,
): CharacterGenerationReferenceView | { status: "missing" } {
  assertCharacter(p, name);
  const explicit = refSetsOf(p).single[name];
  if (explicit && storedReferencePath(p, name, explicit.file)) {
    return { ...explicit, file: explicit.file.replace(/\\/g, "/"), status: "ready" };
  }

  const fallback = listCharacterRefs(p.id, name)[0];
  if (fallback) {
    return { source: fallback, file: fallback, updatedAt: 0, status: "fallback" };
  }
  return { status: "missing" };
}

export function resolveCharacterGenerationReference(p: Project, name: string): string | null {
  const view = characterGenerationReferenceView(p, name);
  if (view.status === "missing") return null;
  return storedReferencePath(p, name, view.file);
}

/** 多图直喂集入选源图（目录字典序，默认全选 − excluded；返回文件名列表）。 */
export function multiRefIncludedFiles(p: Project, name: string): string[] {
  const excluded = new Set(refSetsOf(p).multi[name]?.excluded ?? []);
  return listCharacterRefs(p.id, name).filter((file) => !excluded.has(file));
}

/** 多图直喂集视图：ready=有显式记录；fallback=无记录默认全选；missing=源图目录为空。 */
export function characterMultiReferenceView(p: Project, name: string): CharacterMultiRefView {
  assertCharacter(p, name);
  const record = refSetsOf(p).multi[name];
  const sources = listCharacterRefs(p.id, name);
  const excluded = (record?.excluded ?? []).filter((file) => sources.includes(file));
  if (sources.length === 0) {
    return { status: "missing", included: [], excluded: [], ...(record ? { updatedAt: record.updatedAt } : {}) };
  }
  return {
    status: record ? "ready" : "fallback",
    included: sources.filter((file) => !excluded.includes(file)),
    excluded,
    ...(record ? { updatedAt: record.updatedAt } : {}),
  };
}

function writeRefSets(p: Project, sets: CharacterRefSets) {
  // 写回新结构；旧 characterGenerationRefs 字段保留原样（迁移可回滚）。
  p.characterRefSets = sets;
  saveProject(p);
}

export async function setCharacterGenerationReference(
  projectId: string,
  name: string,
  input: { source: string; crop?: ImageCropRect },
): Promise<Project> {
  const initial = getProject(projectId);
  if (!initial) throw new CharacterReferenceError("项目不存在", 404);
  assertCharacter(initial, name);
  const sourcePath = originalPath(initial, name, input.source);

  let file = input.source;
  let crop: ImageCropRect | undefined;
  if (input.crop) {
    const metadata = await sharp(sourcePath).metadata();
    if (!metadata.width || !metadata.height) throw new CharacterReferenceError("无法读取图片尺寸");
    crop = validateCrop(input.crop, metadata.width, metadata.height);
    const digest = createHash("sha256")
      .update(`${input.source}:${crop.x}:${crop.y}:${crop.width}:${crop.height}`)
      .digest("hex")
      .slice(0, 16);
    file = `generation/crop-${digest}.png`;
    mkdirSync(derivedDir(projectId, name), { recursive: true });
    await sharp(sourcePath).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png().toFile(join(derivedDir(projectId, name), basename(file)));
  }

  // 图片处理存在 await，写回前重新读取项目，避免覆盖同期生成任务更新的 choices/costLedger。
  const current = getProject(projectId);
  if (!current) throw new CharacterReferenceError("项目不存在", 404);
  assertCharacter(current, name);
  originalPath(current, name, input.source);
  const sets = refSetsOf(current);
  const previous = sets.single[name];
  sets.single[name] = { source: input.source, file, ...(crop ? { crop } : {}), updatedAt: Date.now() };
  writeRefSets(current, sets);
  removeDerived(current, name, previous, file);
  return current;
}

export function clearCharacterGenerationReference(projectId: string, name: string): Project {
  const p = getProject(projectId);
  if (!p) throw new CharacterReferenceError("项目不存在", 404);
  assertCharacter(p, name);
  const sets = refSetsOf(p);
  const previous = sets.single[name];
  delete sets.single[name];
  writeRefSets(p, sets);
  removeDerived(p, name, previous);
  return p;
}

/** 多图直喂集排除/恢复：整表提交 excluded（空数组 = 显式全选）。 */
export function setCharacterMultiRefExclusions(projectId: string, name: string, excluded: string[]): Project {
  const p = getProject(projectId);
  if (!p) throw new CharacterReferenceError("项目不存在", 404);
  assertCharacter(p, name);
  const sources = listCharacterRefs(p.id, name);
  const normalized: string[] = [];
  for (const file of excluded) {
    if (typeof file !== "string") throw new CharacterReferenceError("excluded 必须是文件名数组");
    assertSourceFileName(file);
    if (!sources.includes(file)) throw new CharacterReferenceError(`角色参考图不存在: ${file}`, 404);
    if (!normalized.includes(file)) normalized.push(file);
  }
  const sets = refSetsOf(p);
  sets.multi[name] = { excluded: normalized, updatedAt: Date.now() };
  writeRefSets(p, sets);
  return p;
}

/** 清除多图集显式记录，回到「无记录 = 默认全选」。 */
export function clearCharacterMultiRefConfig(projectId: string, name: string): Project {
  const p = getProject(projectId);
  if (!p) throw new CharacterReferenceError("项目不存在", 404);
  assertCharacter(p, name);
  const sets = refSetsOf(p);
  delete sets.multi[name];
  writeRefSets(p, sets);
  return p;
}

/**
 * 删除单张源图：被 single 集引用为 source 时拒绝（先更换/清除主参考）；
 * 成功删除时同步清理 multi excluded 残留与派生目录孤儿文件。
 */
export function deleteCharacterSourceImage(projectId: string, name: string, file: string): Project {
  const p = getProject(projectId);
  if (!p) throw new CharacterReferenceError("项目不存在", 404);
  assertCharacter(p, name);
  const path = originalPath(p, name, file);
  const sets = refSetsOf(p);
  if (sets.single[name]?.source === file) {
    throw new CharacterReferenceError("该源图正被单人主参考引用为 source，先更换或清除主参考再删除", 409, "CONFLICT", { source: file });
  }
  rmSync(path, { force: true });

  const record = sets.multi[name];
  if (record?.excluded.includes(file)) {
    sets.multi[name] = { excluded: record.excluded.filter((item) => item !== file), updatedAt: Date.now() };
  }
  writeRefSets(p, sets);

  // 孤儿派生清理：generation/ 下只保留当前 single 集仍引用的派生件。
  const keep = sets.single[name]?.file.replace(/\\/g, "/");
  const dir = derivedDir(p.id, name);
  if (existsSync(dir)) {
    for (const derived of readdirSync(dir)) {
      if (`generation/${derived}` !== keep) rmSync(join(dir, derived), { force: true });
    }
  }
  return p;
}

/** 上传校验：magic bytes 限 png/jpg/webp、扩展名与内容一致、20MB 上限；非法结构化 4xx。 */
export function validateCharacterRefUpload(fileName: string, data: Uint8Array): void {
  if (data.byteLength > MAX_CHARACTER_REF_BYTES) {
    throw new CharacterReferenceError(`参考图超过大小上限 20MB: ${fileName}`, 400, "BAD_REQUEST", { maxBytes: MAX_CHARACTER_REF_BYTES });
  }
  const kind = sniffImageType(data);
  if (!kind) {
    throw new CharacterReferenceError(`文件不是可识别的 png/jpg/webp 图片: ${fileName}`, 400, "BAD_REQUEST");
  }
  const ext = extname(fileName).toLowerCase();
  const allowed: Record<string, string[]> = { png: [".png"], jpeg: [".jpg", ".jpeg"], webp: [".webp"] };
  if (!allowed[kind].includes(ext)) {
    throw new CharacterReferenceError(`文件扩展名与图片内容不一致（内容为 ${kind}）: ${fileName}`, 400, "BAD_REQUEST", { detected: kind });
  }
}

function sniffImageType(data: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return "png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "webp";
  return null;
}

function validateCrop(crop: ImageCropRect, imageWidth: number, imageHeight: number): ImageCropRect {
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (!values.every(Number.isInteger) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) {
    throw new CharacterReferenceError("裁剪区域必须是非负整数坐标和正整数宽高");
  }
  if (crop.x + crop.width > imageWidth || crop.y + crop.height > imageHeight) {
    throw new CharacterReferenceError("裁剪区域超出图片边界", 400, "CROP_OUT_OF_BOUNDS", { imageWidth, imageHeight });
  }
  return crop;
}
