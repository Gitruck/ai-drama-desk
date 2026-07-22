import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR } from "./config.ts";
import type { Project, ShotChoices, StoryboardDoc } from "./types.ts";

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
