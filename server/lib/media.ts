import { existsSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MediaDeletePreview, MediaKind } from "../../shared/contracts/index.ts";
import { isSafeOutputId } from "../../shared/contracts/index.ts";
import { getProject, listShotOutputs, projectDir, saveProject, shotKey } from "./projects.ts";
import { listJobs } from "./queue.ts";
import type { GenJob } from "./types.ts";

export class MediaDeleteError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "BAD_REQUEST", public readonly details?: unknown) {
    super(message);
  }
}

function kindDir(kind: MediaKind): "keyframes" | "videos" {
  return kind === "keyframe" ? "keyframes" : "videos";
}

export function resolveContainedOutput(baseDir: string, outputId: string): string {
  if (!isSafeOutputId(outputId)) throw new MediaDeleteError("候选文件名非法", 403, "PATH_FORBIDDEN");
  const base = resolve(baseDir);
  const target = resolve(base, outputId);
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new MediaDeleteError("候选路径越界", 403, "PATH_FORBIDDEN");
  return target;
}

export function blockingJobIds(projectId: string, shotIndex: number, kind: MediaKind, jobs: GenJob[] = listJobs(projectId)): string[] {
  return jobs
    .filter(
      (job) =>
        job.projectId === projectId &&
        job.shotIndex === shotIndex &&
        (job.status === "queued" || job.status === "running") &&
        (kind === "video" ? job.kind === "video" : job.kind === "keyframe" || job.kind === "video"),
    )
    .map((job) => job.id);
}

export function previewMediaDelete(projectId: string, shotIndex: number, kind: MediaKind, outputId: string): MediaDeletePreview {
  const project = getProject(projectId);
  if (!project) throw new MediaDeleteError("项目不存在", 404, "NOT_FOUND");
  if (!project.doc.shots.some((shot) => shot.index === shotIndex)) throw new MediaDeleteError("分镜不存在", 404, "NOT_FOUND");
  const outputs = listShotOutputs(projectId, kindDir(kind), shotIndex);
  if (!outputs.includes(outputId)) throw new MediaDeleteError("候选不存在或类型不匹配", 404, "NOT_FOUND");
  const choices = project.choices[shotKey(shotIndex)] ?? {};
  return {
    projectId,
    shotIndex,
    kind,
    outputId,
    selected: choices[kind] === outputId,
    derivedVideos: kind === "keyframe" ? listShotOutputs(projectId, "videos", shotIndex) : [],
    blockingJobs: blockingJobIds(projectId, shotIndex, kind),
    exportedCopiesUnaffected: true,
  };
}

export function deleteMediaOutput(projectId: string, shotIndex: number, kind: MediaKind, outputId: string): MediaDeletePreview {
  const preview = previewMediaDelete(projectId, shotIndex, kind, outputId);
  if (preview.blockingJobs.length) {
    throw new MediaDeleteError("候选正被生成任务使用，不能删除", 409, "CONFLICT", { blockingJobs: preview.blockingJobs });
  }
  const dir = join(projectDir(projectId), kindDir(kind), shotKey(shotIndex));
  const target = resolveContainedOutput(dir, outputId);
  if (!existsSync(target)) throw new MediaDeleteError("候选文件不存在", 404, "NOT_FOUND");
  unlinkSync(target);

  const fresh = getProject(projectId);
  if (!fresh) throw new MediaDeleteError("项目不存在", 404, "NOT_FOUND");
  const key = shotKey(shotIndex);
  if (fresh.choices[key]?.[kind] === outputId) {
    const next = { ...fresh.choices[key] };
    delete next[kind];
    if (Object.keys(next).length) fresh.choices[key] = next;
    else delete fresh.choices[key];
    saveProject(fresh);
  }
  return preview;
}
