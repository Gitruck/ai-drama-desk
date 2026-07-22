// gitruck-ai-drama-desk 服务端：API + 静态托管（web/dist 构建产物 + data/ 媒体文件）
// 启动：bun run server/index.ts（先 bun run build 出前端）

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { DATA_DIR, ROOT, ensureDirs, loadConfig, mergeConfigPatch, publicConfig, saveConfig } from "./lib/config.ts";
import { parseStoryboard, validateDoc } from "./lib/parse.ts";
import {
  characterDir,
  createProject,
  getProject,
  listCharacterRefs,
  listProjects,
  listShotOutputs,
  sanitizeName,
  saveProject,
  setChoice,
  shotKey,
} from "./lib/projects.ts";
import {
  addStyleRefs,
  deleteStyle,
  exportStylePack,
  getStyle,
  importStylePack,
  listStyles,
  removeStyleRef,
  saveStyle,
  StyleError,
  styleUsage,
} from "./lib/styles.ts";
import { enqueue, enqueueAuto, listJobs } from "./lib/queue.ts";
import { exportProject } from "./lib/export.ts";
import { diagnoseComfy } from "./lib/providers/comfyui.ts";
import { deleteMediaOutput, MediaDeleteError, previewMediaDelete } from "./lib/media.ts";
import {
  CharacterReferenceError,
  characterGenerationReferenceView,
  characterMultiReferenceView,
  clearCharacterGenerationReference,
  clearCharacterMultiRefConfig,
  deleteCharacterSourceImage,
  setCharacterGenerationReference,
  setCharacterMultiRefExclusions,
  validateCharacterRefUpload,
} from "./lib/character-refs.ts";
import {
  cancelLoraJob,
  getLoraJobOrThrow,
  getLoraJobs,
  LoraManagerError,
  publishLoraJob,
  resumeLoraJob,
  submitLoraTraining,
  unpublishStyleLora,
  validateLoraTraining,
} from "./lib/lora/manager.ts";
import { loraJobLog } from "./lib/lora/jobs.ts";

ensureDirs();
const cfg = loadConfig();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".svg": "image/svg+xml",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function containedPath(baseDir: string, requested: string): string | null {
  if (!requested || requested.includes("\0") || isAbsolute(requested)) return null;
  const base = resolve(baseDir);
  const target = resolve(base, requested);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
}

function allowedMediaPath(requested: string): boolean {
  const rel = requested.replace(/\\/g, "/");
  return /^projects\/[a-z0-9-]+\/(?:keyframes\/[^/]+\/[^/]+\.(?:png|jpe?g|webp)|videos\/[^/]+\/[^/]+\.(?:mp4|webm|mov)|characters\/[^/]+\/(?:generation\/)?[^/]+\.(?:png|jpe?g|webp))$/i.test(rel)
    || /^styles\/[a-z0-9-]+\/refs\/[^/]+\.(?:png|jpe?g|webp)$/i.test(rel);
}

function redactOperationalText(value: string): string {
  let safe = value.replace(/[A-Za-z]:[\\/][^\s"'`]+/g, "<local-path>");
  const config = loadConfig();
  for (const secret of [config.falKey, config.arkApiKey]) if (secret) safe = safe.split(secret).join("<redacted-secret>");
  return safe;
}

function publicLoraJob(job: any): any {
  const file = (value: unknown) => typeof value === "string" && value ? basename(value) : value;
  return {
    ...job,
    request: {
      ...job.request,
      pythonPath: file(job.request.pythonPath),
      trainerRoot: file(job.request.trainerRoot),
      datasetConfig: file(job.request.datasetConfig),
      baseModel: file(job.request.baseModel),
      vaePath: file(job.request.vaePath),
      textEncoderPath: file(job.request.textEncoderPath),
      outputDir: file(job.request.outputDir),
      resumeFrom: file(job.request.resumeFrom),
      extraArgs: job.request.extraArgs?.map((arg: string) => redactOperationalText(arg)),
    },
    checkpoints: job.checkpoints.map((checkpoint: any) => ({ ...checkpoint, path: file(checkpoint.path), statePath: file(checkpoint.statePath) })),
    manifest: job.manifest ? { ...job.manifest, baseModel: file(job.manifest.baseModel), weightsPath: file(job.manifest.weightsPath) } : undefined,
  };
}

function publicStyle(profile: any): any {
  const file = (value: unknown) => typeof value === "string" && value ? basename(value) : value;
  return profile?.lora ? { ...profile, lora: { ...profile.lora, baseModel: file(profile.lora.baseModel), weightsPath: file(profile.lora.weightsPath) } } : profile;
}

function err(message: string, status = 400, code = status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "BAD_REQUEST", details?: unknown): Response {
  return json({ error: message, code, ...(details === undefined ? {} : { details }) }, status);
}

function serveFile(absPath: string): Response {
  const p = normalize(absPath);
  if (!existsSync(p)) return new Response("Not Found", { status: 404 });
  const file = Bun.file(p);
  return new Response(file, { headers: { "Content-Type": MIME[extname(p).toLowerCase()] ?? "application/octet-stream" } });
}

/** 项目完整视图：project.json + 各镜磁盘产物扫描 */
function projectView(id: string) {
  const p = getProject(id);
  if (!p) return null;
  const shots = p.doc.shots.map((shot) => ({
    ...shot,
    key: shotKey(shot.index),
    keyframes: listShotOutputs(id, "keyframes", shot.index),
    videos: listShotOutputs(id, "videos", shot.index),
    choices: p.choices[shotKey(shot.index)] ?? {},
  }));
  const characters = p.doc.characters.map((c) => ({
    ...c,
    dirName: sanitizeName(c.name),
    refs: listCharacterRefs(id, c.name),
    generationRef: characterGenerationReferenceView(p, c.name),
    // 多图直喂集视图（Seedream 等 multi-image 策略消费）：默认全选 − excluded
    multiRef: characterMultiReferenceView(p, c.name),
  }));
  const totalCost = Math.round(p.costLedger.reduce((a, c) => a + c.cost, 0) * 100) / 100;
  return { ...p, doc: { ...p.doc, characters }, shotsView: shots, totalCost };
}

/** 路径段解码：畸形百分号编码按 400 拒绝，不让 URIError 兜成 500。 */
function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CharacterReferenceError("路径编码非法", 400, "BAD_REQUEST");
  }
}

async function readMultipartFiles(req: Request): Promise<{ name: string; data: Uint8Array }[]> {
  const form = await req.formData();
  const out: { name: string; data: Uint8Array }[] = [];
  for (const [, v] of form.entries()) {
    if (typeof v === "object" && v !== null) {
      const f = v as File;
      out.push({ name: sanitizeName(f.name ?? `upload-${Date.now().toString(36)}.png`), data: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  return out;
}

export function createRequestHandler() {
  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rawPath = url.pathname;
    // v1 是新代码的权威入口；旧 /api/* 在迁移期转发到同一 handler。
    const path = rawPath === "/api/v1" ? "/api" : rawPath.startsWith("/api/v1/") ? `/api/${rawPath.slice("/api/v1/".length)}` : rawPath;

    try {
      // ---------- API ----------
      if (path === "/api/health") {
        const c = loadConfig();
        const diagnostic = await diagnoseComfy(c);
        const comfy = diagnostic.service.state === "ready";
        // 各出图/出片档位是否就绪，前端据此禁用没配好的选项
        return json({
          ok: true,
          comfy,
          providers: {
            "comfyui-image": diagnostic.providers["comfyui-image"].ready,
            "comfyui-image2": diagnostic.providers["comfyui-image2"].ready,
            "comfyui-video": diagnostic.providers["comfyui-video"].ready,
            "hunyuan-video": diagnostic.providers["hunyuan-video"].ready,
            "seedream-image": !!c.arkApiKey,
            "fal-video": !!c.falKey,
            "mock-image": true,
            "mock-video": true,
          },
          // 各 keyframe provider 的参考策略与预算，前端据此切资产区视图与徽章
          refPolicies: c.refPolicies,
        });
      }

      if (path === "/api/diagnostics/comfyui" && req.method === "GET") return json(await diagnoseComfy(loadConfig()));

      if (path === "/api/config") {
        if (req.method === "GET") return json(publicConfig());
        if (req.method === "PUT") {
          const body = (await req.json()) as Record<string, unknown>;
          saveConfig(mergeConfigPatch(loadConfig(), body));
          return json(publicConfig());
        }
      }

      if (path === "/api/styles" && req.method === "GET") return json(listStyles().map(publicStyle));
      if (path === "/api/styles" && req.method === "POST") {
        const body = await req.json();
        if (!body.id || !/^[a-z0-9-]+$/.test(body.id)) return err("id 需为小写字母数字连字符");
        if (getStyle(body.id)) return err("画风 ID 已存在", 409);
        return json(publicStyle(saveStyle({ refs: [], negatives: "", styleLock: "", name: body.id, ...body })), 201);
      }
      if (path === "/api/styles/import" && req.method === "POST") {
        const body = (await req.json()) as { pack: unknown; conflict?: "error" | "overwrite" | "rename"; id?: string };
        return json(publicStyle(importStylePack(body.pack, { conflict: body.conflict, id: body.id })), 201);
      }
      let m = path.match(/^\/api\/styles\/([a-z0-9-]+)$/);
      if (m && req.method === "PUT") {
        const existing = getStyle(m[1]);
        if (!existing) return err("画风档案不存在", 404);
        const body = await req.json();
        return json(publicStyle(saveStyle({ ...existing, ...body, id: m[1], refs: existing.refs })));
      }
      if (m && req.method === "DELETE") {
        const body = (await req.json().catch(() => ({}))) as { confirmed?: boolean; replacementStyleId?: string; force?: boolean };
        if (body.confirmed !== true) return err("永久删除需要 confirmed=true", 400);
        return json(deleteStyle(m[1], { replacementStyleId: body.replacementStyleId, force: body.force }));
      }
      m = path.match(/^\/api\/styles\/([a-z0-9-]+)\/refs$/);
      if (m && req.method === "POST") {
        const files = await readMultipartFiles(req);
        return json(publicStyle(addStyleRefs(m[1], files)));
      }
      m = path.match(/^\/api\/styles\/([a-z0-9-]+)\/refs\/([^/]+)$/);
      if (m && req.method === "DELETE") {
        const body = (await req.json().catch(() => ({}))) as { confirmed?: boolean };
        if (body.confirmed !== true) return err("永久删除需要 confirmed=true", 400);
        return json(publicStyle(removeStyleRef(m[1], decodeURIComponent(m[2]))));
      }
      m = path.match(/^\/api\/styles\/([a-z0-9-]+)\/usage$/);
      if (m && req.method === "GET") return json({ projects: styleUsage(m[1]) });
      m = path.match(/^\/api\/styles\/([a-z0-9-]+)\/pack$/);
      if (m && req.method === "GET") {
        return json(exportStylePack(m[1], url.searchParams.get("includeRefs") === "true", url.searchParams.get("licenseConfirmed") === "true"));
      }
      m = path.match(/^\/api\/styles\/([a-z0-9-]+)\/lora$/);
      if (m && req.method === "DELETE") {
        const body = (await req.json().catch(() => ({}))) as { confirmed?: boolean };
        if (body.confirmed !== true) return err("解绑 LoRA 需要 confirmed=true");
        unpublishStyleLora(m[1]);
        return json(publicStyle(getStyle(m[1])));
      }

      if (path === "/api/lora/jobs" && req.method === "GET") return json(getLoraJobs().map(publicLoraJob));
      if (path === "/api/lora/jobs" && req.method === "POST") return json(publicLoraJob(await submitLoraTraining(await req.json())), 202);
      if (path === "/api/lora/validate" && req.method === "POST") return json(await validateLoraTraining(await req.json()));
      m = path.match(/^\/api\/lora\/jobs\/([a-z0-9-]+)$/);
      if (m && req.method === "GET") return json(publicLoraJob(getLoraJobOrThrow(m[1])));
      m = path.match(/^\/api\/lora\/jobs\/([a-z0-9-]+)\/cancel$/);
      if (m && req.method === "POST") return json(publicLoraJob(await cancelLoraJob(m[1])));
      m = path.match(/^\/api\/lora\/jobs\/([a-z0-9-]+)\/resume$/);
      if (m && req.method === "POST") return json(publicLoraJob(await resumeLoraJob(m[1])), 202);
      m = path.match(/^\/api\/lora\/jobs\/([a-z0-9-]+)\/publish$/);
      if (m && req.method === "POST") {
        const body = (await req.json()) as { styleId?: string };
        if (!body.styleId) return err("需要 styleId");
        return json(publicLoraJob(await publishLoraJob(m[1], body.styleId)));
      }
      m = path.match(/^\/api\/lora\/jobs\/([a-z0-9-]+)\/log$/);
      if (m && req.method === "GET") {
        getLoraJobOrThrow(m[1]);
        const file = loraJobLog(m[1]);
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        const tail = Math.min(200_000, Math.max(1000, Number(url.searchParams.get("tail") ?? 20_000)));
        return json({ text: redactOperationalText(text.slice(-tail)) });
      }

      if (path === "/api/projects" && req.method === "GET") return json(listProjects());
      if (path === "/api/projects" && req.method === "POST") {
        const body = await req.json();
        let doc = body.doc;
        let warnings: string[] = [];
        if (!doc && body.storyboardMd) {
          doc = parseStoryboard(body.storyboardMd);
          warnings = validateDoc(doc);
        }
        if (!doc) return err("需要 storyboardMd（分镜稿 Markdown）或 doc（预解析 shots.json）");
        if (body.styleId && !getStyle(body.styleId)) return err("画风不存在", 404);
        const p = createProject({
          name: body.name || doc.title || doc.beatId || "未命名",
          doc,
          storyboardMd: body.storyboardMd,
          styleId: body.styleId,
          slug: body.slug,
        });
        // 默认画风锚图挑选：前 2 张
        const style = p.styleId ? getStyle(p.styleId) : null;
        if (style) {
          p.styleRefPicks = style.refs.slice(0, 2);
          saveProject(p);
        }
        return json({ project: projectView(p.id), warnings });
      }

      m = path.match(/^\/api\/projects\/([a-z0-9-]+)$/);
      if (m && req.method === "GET") {
        const v = projectView(m[1]);
        return v ? json(v) : err("项目不存在", 404);
      }
      if (m && req.method === "PUT") {
        // body 先读完再取项目快照：getProject→saveProject 之间不能有 await，
        // 否则会用旧快照覆盖后台 job 同期写入的 choices/costLedger（审查实测复现过）
        const body = await req.json();
        const p = getProject(m[1]);
        if (!p) return err("项目不存在", 404);
        if (body.doc) p.doc = body.doc;
        if (Object.prototype.hasOwnProperty.call(body, "styleId")) {
          const activeJobs = listJobs(p.id).filter((job) => job.status === "queued" || job.status === "running");
          if (activeJobs.length > 0) return err("项目仍有生成任务在途，任务结束后再切换画风", 409, "CONFLICT", { jobs: activeJobs.map((job) => job.id) });
          const nextStyleId = typeof body.styleId === "string" && body.styleId.trim() ? body.styleId.trim() : undefined;
          const nextStyle = nextStyleId ? getStyle(nextStyleId) : null;
          if (nextStyleId && !nextStyle) return err("画风不存在", 404);
          p.styleId = nextStyle?.id;
          p.styleRefPicks = nextStyle?.refs.slice(0, 2) ?? [];
        } else if (body.styleRefPicks) {
          p.styleRefPicks = body.styleRefPicks;
        }
        if (body.name) p.name = body.name;
        saveProject(p);
        return json(projectView(p.id));
      }

      m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/characters\/(.+)\/refs$/);
      if (m && req.method === "POST") {
        const p = getProject(m[1]);
        if (!p) return err("项目不存在", 404);
        const name = decodePathSegment(m[2]);
        // 与同族路由对齐：角色必须在 doc 里，否则会给幽灵目录落盘、UI 永远看不到
        if (!p.doc.characters.some((c) => c.name === name)) return err("角色不存在", 404);
        const files = await readMultipartFiles(req);
        // 先整批校验（魔数 + 扩展名一致 + 大小上限），全过再落盘，避免半批脏文件
        for (const f of files) validateCharacterRefUpload(f.name, f.data);
        const dir = characterDir(p.id, name);
        for (const f of files) writeFileSync(join(dir, f.name), f.data);
        return json({ refs: listCharacterRefs(p.id, name) });
      }

      // 删除单张源图（被单人主参考引用为 source 时 409 拒删；成功时清理 excluded 残留与孤儿派生）
      m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/characters\/([^/]+)\/refs\/([^/]+)$/);
      if (m && req.method === "DELETE") {
        const p = deleteCharacterSourceImage(m[1], decodePathSegment(m[2]), decodePathSegment(m[3]));
        return json(projectView(p.id));
      }

      // 多图直喂集配置：整表提交 excluded（空数组 = 显式全选）；DELETE 回到「无记录 = 默认全选」
      m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/characters\/([^/]+)\/multi-refs$/);
      if (m && req.method === "POST") {
        const body = (await req.json()) as { excluded?: unknown };
        if (!Array.isArray(body.excluded)) return err("需要 excluded 文件名数组");
        const p = setCharacterMultiRefExclusions(m[1], decodePathSegment(m[2]), body.excluded as string[]);
        return json(projectView(p.id));
      }
      if (m && req.method === "DELETE") {
        const p = clearCharacterMultiRefConfig(m[1], decodePathSegment(m[2]));
        return json(projectView(p.id));
      }

      m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/characters\/([^/]+)\/generation-reference$/);
      if (m && req.method === "POST") {
        const name = decodePathSegment(m[2]);
        const body = (await req.json()) as { source?: string; crop?: { x: number; y: number; width: number; height: number } };
        if (typeof body.source !== "string" || !body.source) return err("需要 source");
        const p = await setCharacterGenerationReference(m[1], name, { source: body.source, ...(body.crop ? { crop: body.crop } : {}) });
        return json(projectView(p.id));
      }
      if (m && req.method === "DELETE") {
        const name = decodePathSegment(m[2]);
        const p = clearCharacterGenerationReference(m[1], name);
        return json(projectView(p.id));
      }

      m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/shots\/(\d+)\/(keyframe|video)$/);
      if (m && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { provider?: string };
        const kind = m[3] as "keyframe" | "video";
        const provider = body.provider ?? (kind === "keyframe" ? "comfyui-image" : "comfyui-video");
        const job = enqueue(m[1], parseInt(m[2], 10), kind, provider);
        return json(job);
      }

      m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/shots\/(\d+)\/choose$/);
      if (m && req.method === "POST") {
        // 同 PUT：body 先读完再取快照，快照→写回零 await
        const body = (await req.json()) as { kind: "keyframe" | "video"; file: string };
        const p = getProject(m[1]);
        if (!p) return err("项目不存在", 404);
        setChoice(p, parseInt(m[2], 10), body.kind, body.file);
        return json(projectView(p.id));
      }

      m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/shots\/(\d+)\/outputs\/(keyframe|video)\/([^/]+)$/);
      if (m && req.method === "GET") {
        const outputId = decodeURIComponent(m[4]);
        return json(previewMediaDelete(m[1], parseInt(m[2], 10), m[3] as "keyframe" | "video", outputId));
      }
      if (m && req.method === "DELETE") {
        const body = (await req.json().catch(() => ({}))) as { confirmed?: boolean };
        if (body.confirmed !== true) return err("永久删除需要 confirmed=true", 400);
        const outputId = decodeURIComponent(m[4]);
        const preview = deleteMediaOutput(m[1], parseInt(m[2], 10), m[3] as "keyframe" | "video", outputId);
        return json({ deleted: preview, project: projectView(m[1]) });
      }

      m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/auto$/);
      if (m && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { keyframeProvider?: string; videoProvider?: string };
        const jobsOut = enqueueAuto(m[1], body.keyframeProvider ?? "comfyui-image", body.videoProvider ?? "comfyui-video");
        return json({ enqueued: jobsOut.length, jobs: jobsOut });
      }

      m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/export$/);
      if (m && req.method === "POST") {
        const p = getProject(m[1]);
        if (!p) return err("项目不存在", 404);
        return json(exportProject(p));
      }

      if (path === "/api/jobs") {
        return json(listJobs(url.searchParams.get("project") ?? undefined));
      }

      if (path.startsWith("/api/")) return err("API endpoint not found", 404);

      // ---------- 媒体文件 ----------
      if (path.startsWith("/files/")) {
        let rel: string;
        try {
          rel = decodeURIComponent(path.slice("/files/".length));
        } catch {
          return err("路径编码非法", 400);
        }
        if (!allowedMediaPath(rel)) return err("只允许读取项目媒体和画风参考图", 403, "PATH_FORBIDDEN");
        const target = containedPath(DATA_DIR, rel);
        if (!target) return err("路径非法", 403, "PATH_FORBIDDEN");
        return serveFile(target);
      }

      // ---------- 前端静态 ----------
      const dist = join(ROOT, "web", "dist");
      let staticRel = "";
      try { staticRel = decodeURIComponent(path.slice(1)); } catch { return err("路径编码非法", 400); }
      const staticTarget = staticRel ? containedPath(dist, staticRel) : null;
      if (staticRel && !staticTarget) return err("路径非法", 403, "PATH_FORBIDDEN");
      if (path === "/" || !staticTarget || !existsSync(staticTarget)) {
        const index = join(dist, "index.html");
        if (existsSync(index)) return serveFile(index);
        return new Response("前端未构建：先运行 bun run build", { status: 503 });
      }
      return serveFile(staticTarget);
    } catch (e) {
      if (e instanceof MediaDeleteError) return err(e.message, e.status, e.code, e.details);
      if (e instanceof StyleError) return err(e.message, e.status, e.code, e.details);
      if (e instanceof LoraManagerError) return err(e.message, e.status, e.code, e.details);
      if (e instanceof CharacterReferenceError) return err(e.message, e.status, e.code, e.details);
      console.error(e);
      return err(e instanceof Error ? e.message : String(e), 500);
    }
  };
}

if (import.meta.main) {
  const server = Bun.serve({ port: cfg.port, hostname: "127.0.0.1", idleTimeout: 120, fetch: createRequestHandler() });
  console.log(`gitruck-ai-drama-desk 已启动: http://127.0.0.1:${server.port}`);
}
