import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROJECTS_DIR } from "./config.ts";
import { parseStoryboard, validateDoc } from "./parse.ts";
import type { Project, Shot, ShotChoices, StoryboardDoc } from "./types.ts";

export class ProjectError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "BAD_REQUEST", readonly details?: unknown) {
    super(message);
    this.name = "ProjectError";
  }
}

export function projectDir(id: string) {
  return join(PROJECTS_DIR, id);
}

function projectJson(id: string) {
  return join(projectDir(id), "project.json");
}

export function listProjects(): Project[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out: Project[] = [];
  for (const d of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || !existsSync(projectJson(d.name))) continue;
    // 单个坏文件（写入中断/手改失误）不拖垮整个项目列表
    try {
      out.push(JSON.parse(readFileSync(projectJson(d.name), "utf-8")) as Project);
    } catch {
      console.error(`跳过损坏的 project.json: ${d.name}`);
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProject(id: string): Project | null {
  if (!existsSync(projectJson(id))) return null;
  return JSON.parse(readFileSync(projectJson(id), "utf-8"));
}

export function saveProject(p: Project) {
  p.updatedAt = Date.now();
  mkdirSync(projectDir(p.id), { recursive: true });
  // 原子写：tmp + rename，进程中途被杀不留半截 JSON
  const target = projectJson(p.id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, target);
}

function slugify(s: string): string {
  const ascii = s
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // 中文名转拼音不做，直接留中文会进文件名——导出命名要求安全字符，兜底用时间戳
  return /^[a-z0-9-]+$/.test(ascii) && ascii ? ascii : `proj-${Date.now().toString(36)}`;
}

export function createProject(opts: {
  name: string;
  doc: StoryboardDoc;
  storyboardMd?: string;
  styleId?: string;
  slug?: string;
}): Project {
  const slug = slugify(opts.slug ?? opts.name);
  let id = slug;
  let n = 2;
  while (existsSync(projectDir(id))) id = `${slug}-${n++}`;

  const p: Project = {
    id,
    name: opts.name,
    slug: id,
    styleId: opts.styleId,
    styleRefPicks: [],
    doc: opts.doc,
    choices: {},
    costLedger: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  mkdirSync(join(projectDir(id), "keyframes"), { recursive: true });
  mkdirSync(join(projectDir(id), "videos"), { recursive: true });
  mkdirSync(join(projectDir(id), "characters"), { recursive: true });
  if (opts.storyboardMd) writeFileSync(join(projectDir(id), "storyboard.md"), opts.storyboardMd);
  saveProject(p);
  return p;
}

export function shotKey(index: number) {
  return `s${String(index).padStart(2, "0")}`;
}

export function shotDir(projectId: string, kind: "keyframes" | "videos", index: number) {
  const d = join(projectDir(projectId), kind, shotKey(index));
  mkdirSync(d, { recursive: true });
  return d;
}

/** 扫描某镜的候选产物（文件名列表，按 mtime 升序） */
export function listShotOutputs(projectId: string, kind: "keyframes" | "videos", index: number): string[] {
  const d = join(projectDir(projectId), kind, shotKey(index));
  if (!existsSync(d)) return [];
  const exts = kind === "keyframes" ? /\.(png|jpe?g|webp)$/i : /\.(mp4|webm|mov)$/i;
  return readdirSync(d)
    .filter((f) => exts.test(f) && !f.includes(".part"))
    .sort();
}

export function getChoices(p: Project, index: number): ShotChoices {
  return p.choices[shotKey(index)] ?? {};
}

export function setChoice(p: Project, index: number, kind: "keyframe" | "video", file: string) {
  const key = shotKey(index);
  p.choices[key] = { ...(p.choices[key] ?? {}), [kind]: file };
  saveProject(p);
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new ProjectError(`${label}必须是文字`);
  const text = value.trim();
  if (!text) throw new ProjectError(`${label}不能为空`);
  if (text.length > maxLength) throw new ProjectError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new ProjectError(`${label}必须是文字`);
  const text = value.trim();
  if (text.length > maxLength) throw new ProjectError(`${label}不能超过 ${maxLength} 个字符`);
  return text || undefined;
}

/** 只改角色文字，不触碰角色名、参考图目录和双参考集指针。 */
export function updateCharacterDescription(projectId: string, name: string, value: unknown): Project {
  const p = getProject(projectId);
  if (!p) throw new ProjectError("项目不存在", 404, "NOT_FOUND");
  const character = p.doc.characters.find((item) => item.name === name);
  if (!character) throw new ProjectError("角色不存在", 404, "NOT_FOUND");
  character.description = requiredText(value, "角色描述", 20_000);
  saveProject(p);
  return p;
}

export type ShotTextPatch = Pick<Shot, "title" | "durationSec" | "cast" | "description"> &
  Partial<Pick<Shot, "segment" | "scene" | "sourceLines" | "stylePrefix">>;

/**
 * 只改镜头的文字 IR；镜号、候选产物与 choices 都保持原样。
 * API 要求提交完整编辑表单，避免空 patch 看似成功却什么也没改。
 */
export function updateShotText(projectId: string, shotIndex: number, patch: unknown): Project {
  const p = getProject(projectId);
  if (!p) throw new ProjectError("项目不存在", 404, "NOT_FOUND");
  const shot = p.doc.shots.find((item) => item.index === shotIndex);
  if (!shot) throw new ProjectError("分镜不存在", 404, "NOT_FOUND");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ProjectError("需要镜头文字内容");
  const body = patch as Record<string, unknown>;

  const rawDuration = body.durationSec;
  if (rawDuration !== null && (typeof rawDuration !== "number" || !Number.isFinite(rawDuration) || rawDuration <= 0 || rawDuration > 3600)) {
    throw new ProjectError("建议时长必须留空，或填写 0–3600 秒之间的数字");
  }
  if (!Array.isArray(body.cast) || body.cast.some((item) => typeof item !== "string")) {
    throw new ProjectError("出场角色必须是文字列表");
  }
  const cast = [...new Set(body.cast.map((item) => (item as string).trim()).filter(Boolean))];
  if (cast.length > 100 || cast.some((item) => item.length > 200)) throw new ProjectError("出场角色列表过长");

  shot.title = requiredText(body.title, "镜头标题", 500);
  shot.durationSec = rawDuration as number | null;
  shot.segment = optionalText(body.segment, "蒙太奇段名", 500);
  shot.scene = optionalText(body.scene, "场景", 2_000);
  shot.cast = cast;
  shot.stylePrefix = optionalText(body.stylePrefix, "视觉基调", 10_000);
  shot.description = requiredText(body.description, "镜头描述", 50_000);
  shot.sourceLines = optionalText(body.sourceLines, "对应原文", 20_000);
  saveProject(p);
  return p;
}

/** 文件/目录名净化：只留字母数字下划线点连字符与 CJK（%# 等会打断 /files/ URL 链路） */
export function sanitizeName(name: string): string {
  const safe = name.replace(/[^\w.\-一-鿿（）()]/g, "_");
  return safe || `unnamed-${Date.now().toString(36)}`;
}

/** 角色参考图目录 */
export function characterDir(projectId: string, name: string) {
  const d = join(projectDir(projectId), "characters", sanitizeName(name));
  mkdirSync(d, { recursive: true });
  return d;
}

export function listCharacterRefs(projectId: string, name: string): string[] {
  const d = characterDir(projectId, name);
  return readdirSync(d).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
}

/** 项目目录必须真的落在 PROJECTS_DIR 里；id 是路由段，删除前这道闸不能省。 */
function containedProjectDir(id: string): string {
  if (!id || id.includes("\0") || isAbsolute(id)) throw new ProjectError("项目 id 非法", 400);
  const base = resolve(PROJECTS_DIR);
  const target = resolve(base, id);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ProjectError("项目 id 非法", 400);
  return target;
}

function countRefs(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countRefs(join(dir, entry.name));
    else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) n++;
  }
  return n;
}

export interface ProjectDeletionPreview {
  id: string;
  name: string;
  dir: string;
  keyframes: number;
  videos: number;
  characterRefs: number;
}

/** 删除预览：先把代价摆出来。删项目会带走已经出的图和片，是本仓破坏力最大的操作。 */
export function projectDeletionPreview(id: string): ProjectDeletionPreview {
  const p = getProject(id);
  if (!p) throw new ProjectError("项目不存在", 404, "NOT_FOUND");
  const dir = containedProjectDir(id);
  const count = (kind: "keyframes" | "videos") =>
    p.doc.shots.reduce((sum, s) => sum + listShotOutputs(id, kind, s.index).length, 0);
  return {
    id,
    name: p.name,
    dir,
    keyframes: count("keyframes"),
    videos: count("videos"),
    characterRefs: countRefs(join(dir, "characters")),
  };
}

/** 删除整个项目目录（不可逆）。调用方负责确认与在途任务守卫。 */
export function deleteProject(id: string): ProjectDeletionPreview {
  const preview = projectDeletionPreview(id);
  rmSync(preview.dir, { recursive: true, force: true });
  return preview;
}

export interface ReparseResult {
  project: Project;
  warnings: string[];
  addedCharacters: string[];
  removedCharacters: string[];
  addedShots: number[];
  removedShots: number[];
  /** 指向已不存在镜号的选择（重解析后失效，但不自动清） */
  staleChoices: string[];
  /** 已无对应角色的角色目录（可能是角色改名，磁盘上仍留着源图，不自动删） */
  orphanCharacterDirs: string[];
}

/**
 * 按项目目录里保存的原始分镜稿重跑解析器，只覆盖 `doc`。
 * `choices` / `costLedger` / `styleId` / `styleRefPicks` 与角色源图一律保留——
 * 解析器修好之后，已经出过图的老项目不该被逼着删了重建。
 * 孤儿（改名后的角色目录、指空的 choices）只报告不清理：那是用户的产物，不替他扔。
 */
export function reparseProject(id: string): ReparseResult {
  const p = getProject(id);
  if (!p) throw new ProjectError("项目不存在", 404, "NOT_FOUND");
  const mdPath = join(containedProjectDir(id), "storyboard.md");
  if (!existsSync(mdPath)) {
    throw new ProjectError("本项目没有保存原始分镜稿（当初是直接投喂 doc 建的），无法重解析", 409, "CONFLICT");
  }

  const before = p.doc;
  const next = parseStoryboard(readFileSync(mdPath, "utf-8"));
  const names = (doc: StoryboardDoc) => doc.characters.map((c) => c.name);
  const indexes = (doc: StoryboardDoc) => doc.shots.map((s) => s.index);
  const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

  p.doc = next;
  saveProject(p);

  const nextIndexes = indexes(next);
  const staleChoices = Object.keys(p.choices).filter((key) => !nextIndexes.some((i) => shotKey(i) === key));
  const charactersDir = join(containedProjectDir(id), "characters");
  const liveDirs = new Set(names(next).map(sanitizeName));
  const orphanCharacterDirs = existsSync(charactersDir)
    ? readdirSync(charactersDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !liveDirs.has(e.name))
        .map((e) => e.name)
    : [];

  return {
    project: p,
    warnings: validateDoc(next),
    addedCharacters: diff(names(next), names(before)),
    removedCharacters: diff(names(before), names(next)),
    addedShots: diff(nextIndexes.map(String), indexes(before).map(String)).map(Number),
    removedShots: diff(indexes(before).map(String), nextIndexes.map(String)).map(Number),
    staleChoices,
    orphanCharacterDirs,
  };
}
