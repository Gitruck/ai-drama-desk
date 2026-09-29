import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { getProject, listShotOutputs, ProjectError, shotDir } from "./projects.ts";

const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
function shot(projectId: string, index: number) {
  if (!/^[a-z0-9-]+$/.test(projectId) || !Number.isSafeInteger(index) || index < 1) throw new ProjectError("项目或镜号非法");
  const p = getProject(projectId);
  const s = p?.doc.shots.find(s => s.index === index);
  if (!p || !s) throw new ProjectError("项目或分镜不存在", 404, "NOT_FOUND");
  return { p, s };
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProjectError(`${field}必须是非空文字`);
  return value.trim();
}
function atomicJson(path: string, data: unknown) {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2)); renameSync(tmp, path);
}
function fingerprint(projectId: string, index: number) {
  const { p, s } = shot(projectId, index);
  return digest(JSON.stringify({ shot: s, characters: p.doc.characters.filter(c => s.cast.includes(c.name)), styleId: p.styleId }));
}
function output(projectId: string, index: number, file: unknown) {
  shot(projectId, index);
  if (typeof file !== "string" || !listShotOutputs(projectId, "keyframes", index).includes(file)) throw new ProjectError("关键帧不存在或文件名非法", 404, "NOT_FOUND");
  return join(shotDir(projectId, "keyframes", index), file);
}

/** 外部宿主生图的正式落库入口；不隐式选择、不隐式验收、不调用模型。 */
export async function importKeyframe(projectId: string, index: number, data: Uint8Array, sourceName: string) {
  shot(projectId, index);
  if (!data.length || data.length > 20 * 1024 * 1024) throw new ProjectError("关键帧须为非空图片且不超过20MB");
  let format: string | undefined;
  try {
    const decoder = sharp(data, { limitInputPixels: 40_000_000 });
    const meta = await decoder.metadata(); format = meta.format;
    if (!["png", "jpeg", "webp"].includes(format ?? "") || (meta.pages ?? 1) > 1) throw new Error("format");
    await decoder.stats(); // 完整解码，不能只信扩展名或头部。
  } catch { throw new ProjectError("关键帧必须是可完整解码的单帧 PNG/JPEG/WebP"); }
  shot(projectId, index); // 解码 await 后重新校验项目未被删除。
  const sha256 = digest(data);
  const file = `imported-${sha256}.${format === "jpeg" ? "jpg" : format}`;
  const path = join(shotDir(projectId, "keyframes", index), file);
  if (existsSync(path) && digest(readFileSync(path)) !== sha256) throw new ProjectError("同哈希文件名的内容已被外部修改，拒绝覆盖", 409, "CONFLICT");
  if (!existsSync(path)) writeFileSync(path, data, { flag: "wx" });
  if (!existsSync(`${path}.source.json`)) atomicJson(`${path}.source.json`, { sourceName, sha256, importedAt: new Date().toISOString(), origin: "external" });
  return { file, sha256, selected: false, review: keyframeReview(projectId, index, file) };
}

export function keyframeReview(projectId: string, index: number, file: string) {
  const path = output(projectId, index, file);
  if (!existsSync(`${path}.review.json`)) return { status: "unreviewed" };
  const receipt = JSON.parse(readFileSync(`${path}.review.json`, "utf8"));
  const current = receipt.sha256 === digest(readFileSync(path)) && receipt.shotFingerprint === fingerprint(projectId, index);
  return { ...receipt, status: current ? receipt.status : "stale" };
}

/** 记录 Agent/用户的具体审阅证据，软件只核验结构和文件身份，不冒充视觉判断。 */
export function recordKeyframeReview(projectId: string, index: number, body: Record<string, unknown>) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProjectError("审阅记录须为JSON对象");
  const path = output(projectId, index, body.file);
  if (body.status !== "accepted" && body.status !== "rejected") throw new ProjectError("status须为accepted或rejected");
  const references = body.references;
  if (!Array.isArray(references) || !references.length) throw new ProjectError("references须登记实际参考路径；纯空镜可用明确的无角色参考说明");
  const findings = body.findings as Record<string, unknown> | undefined;
  const checked = Object.fromEntries(["identity", "scene", "objects", "motionReadiness"].map(k => [k, text(findings?.[k], `findings.${k}`)]));
  const receipt = { file: body.file, status: body.status, sourceText: text(body.sourceText, "sourceText"), references: references.map(v => text(v, "reference")), findings: checked, reviewer: text(body.reviewer, "reviewer"), sha256: digest(readFileSync(path)), shotFingerprint: fingerprint(projectId, index), reviewedAt: new Date().toISOString() };
  atomicJson(`${path}.review.json`, receipt);
  return receipt;
}

/** 导入图的 I2V 入口，以及执行时再次检查，避免排队期间换图/改稿沿用旧结论。 */
export function assertImportedKeyframeReviewed(projectId: string, index: number, file?: string) {
  if (!file?.startsWith("imported-")) return;
  if (keyframeReview(projectId, index, file).status !== "accepted") throw new ProjectError("外部关键帧尚未逐镜审阅通过，或图片/分镜已变更；请重新记录审阅", 409, "KEYFRAME_REVIEW_REQUIRED");
}
