// 轻 API 客户端（前端类型从宽，服务端为真相源）

async function req<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body as T;
}

export const api = {
  health: () => req("/api/v1/health"),
  comfyDiagnostic: () => req("/api/v1/diagnostics/comfyui"),
  config: () => req("/api/v1/config"),
  saveConfig: (cfg: any) => req("/api/v1/config", { method: "PUT", body: JSON.stringify(cfg) }),
  styles: () => req("/api/v1/styles"),
  createStyle: (body: any) => req("/api/v1/styles", { method: "POST", body: JSON.stringify(body) }),
  saveStyle: (id: string, patch: any) => req(`/api/v1/styles/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  styleUsage: (id: string) => req(`/api/v1/styles/${id}/usage`),
  deleteStyle: (id: string, opts: { replacementStyleId?: string; force?: boolean } = {}) =>
    req(`/api/v1/styles/${id}`, { method: "DELETE", body: JSON.stringify({ ...opts, confirmed: true }) }),
  deleteStyleRef: (id: string, file: string) =>
    req(`/api/v1/styles/${id}/refs/${encodeURIComponent(file)}`, { method: "DELETE", body: JSON.stringify({ confirmed: true }) }),
  exportStylePack: (id: string, includeRefs = false, licenseConfirmed = false) =>
    req(`/api/v1/styles/${id}/pack?includeRefs=${includeRefs}&licenseConfirmed=${licenseConfirmed}`),
  importStylePack: (pack: any, conflict: "error" | "overwrite" | "rename" = "error") =>
    req("/api/v1/styles/import", { method: "POST", body: JSON.stringify({ pack, conflict }) }),
  projects: () => req("/api/v1/projects"),
  project: (id: string) => req(`/api/v1/projects/${id}`),
  createProject: (body: any) => req("/api/v1/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: string, patch: any) => req(`/api/v1/projects/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  generate: (id: string, shot: number, kind: "keyframe" | "video", provider: string) =>
    req(`/api/v1/projects/${id}/shots/${shot}/${kind}`, { method: "POST", body: JSON.stringify({ provider }) }),
  choose: (id: string, shot: number, kind: "keyframe" | "video", file: string) =>
    req(`/api/v1/projects/${id}/shots/${shot}/choose`, { method: "POST", body: JSON.stringify({ kind, file }) }),
  previewDeleteOutput: (id: string, shot: number, kind: "keyframe" | "video", file: string) =>
    req(`/api/v1/projects/${id}/shots/${shot}/outputs/${kind}/${encodeURIComponent(file)}`),
  deleteOutput: (id: string, shot: number, kind: "keyframe" | "video", file: string) =>
    req(`/api/v1/projects/${id}/shots/${shot}/outputs/${kind}/${encodeURIComponent(file)}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmed: true }),
    }),
  auto: (id: string, keyframeProvider: string, videoProvider: string) =>
    req(`/api/v1/projects/${id}/auto`, { method: "POST", body: JSON.stringify({ keyframeProvider, videoProvider }) }),
  exportProject: (id: string) => req(`/api/v1/projects/${id}/export`, { method: "POST" }),
  jobs: (project?: string) => req(`/api/v1/jobs${project ? `?project=${project}` : ""}`),
  loraJobs: () => req("/api/v1/lora/jobs"),
  loraJob: (id: string) => req(`/api/v1/lora/jobs/${id}`),
  validateLora: (body: any) => req("/api/v1/lora/validate", { method: "POST", body: JSON.stringify(body) }),
  trainLora: (body: any) => req("/api/v1/lora/jobs", { method: "POST", body: JSON.stringify(body) }),
  cancelLora: (id: string) => req(`/api/v1/lora/jobs/${id}/cancel`, { method: "POST" }),
  resumeLora: (id: string) => req(`/api/v1/lora/jobs/${id}/resume`, { method: "POST" }),
  publishLora: (id: string, styleId: string) =>
    req(`/api/v1/lora/jobs/${id}/publish`, { method: "POST", body: JSON.stringify({ styleId }) }),
  loraLog: (id: string, tail = 20_000) => req(`/api/v1/lora/jobs/${id}/log?tail=${tail}`),
  uploadCharRefs: async (id: string, name: string, files: FileList) => {
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f);
    const res = await fetch(`/api/v1/projects/${id}/characters/${encodeURIComponent(name)}/refs`, {
      method: "POST",
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    // 透传服务端校验信息（魔数/大小/扩展名不一致），不要吞成笼统的「上传失败」
    if (!res.ok) throw new Error(body.error ?? "上传失败");
    return body;
  },
  deleteCharRef: (id: string, name: string, file: string) =>
    req(`/api/v1/projects/${id}/characters/${encodeURIComponent(name)}/refs/${encodeURIComponent(file)}`, { method: "DELETE" }),
  setMultiRefExclusions: (id: string, name: string, excluded: string[]) =>
    req(`/api/v1/projects/${id}/characters/${encodeURIComponent(name)}/multi-refs`, {
      method: "POST",
      body: JSON.stringify({ excluded }),
    }),
  clearMultiRefConfig: (id: string, name: string) =>
    req(`/api/v1/projects/${id}/characters/${encodeURIComponent(name)}/multi-refs`, { method: "DELETE" }),
  setCharacterGenerationReference: (id: string, name: string, body: { source: string; crop?: { x: number; y: number; width: number; height: number } }) =>
    req(`/api/v1/projects/${id}/characters/${encodeURIComponent(name)}/generation-reference`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  clearCharacterGenerationReference: (id: string, name: string) =>
    req(`/api/v1/projects/${id}/characters/${encodeURIComponent(name)}/generation-reference`, { method: "DELETE" }),
  uploadStyleRefs: async (id: string, files: FileList) => {
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f);
    const res = await fetch(`/api/v1/styles/${id}/refs`, { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "上传失败");
    return body;
  },
};

export const fileUrl = (rel: string) => `/files/${rel}`;
export const projFile = (pid: string, rel: string) => `/files/projects/${pid}/${rel}`;
export const styleRef = (sid: string, f: string) => `/files/styles/${sid}/refs/${f}`;
