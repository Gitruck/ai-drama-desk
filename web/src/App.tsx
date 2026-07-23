import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EDITION_NOTICE, type LoraJob, type LoraTrainRequest } from "../../shared/contracts/index.ts";
import { api, projFile, styleRef } from "./api.ts";
import { CharacterPanel, refPolicyFor, strategyBadgeText } from "./components/CharacterPanel.tsx";
import { keyframeProviderState } from "./provider-state.ts";

type View = { kind: "home" } | { kind: "project"; id: string } | { kind: "styles" } | { kind: "lora" } | { kind: "settings" };

const KF_PROVIDERS = [
  { id: "comfyui-image", label: "本地 ComfyUI · A（参考图）" },
  { id: "comfyui-image2", label: "本地 ComfyUI · B（LoRA）" },
  { id: "seedream-image", label: "Seedream 5.0 Pro（¥0.3/张）" },
  { id: "mock-image", label: "mock（离线占位）" },
];
const VID_PROVIDERS = [
  { id: "comfyui-video", label: "本地 Wan2.2（540p 抽卡档）" },
  { id: "hunyuan-video", label: "本地 混元1.5（480p 蒸馏）" },
  { id: "fal-video", label: "fal 云出口（Wan2.2）" },
  { id: "mock-video", label: "mock（离线占位）" },
];

export function App() {
  const [view, setView] = useState<View>({ kind: "home" });
  const [projects, setProjects] = useState<any[]>([]);
  const [styles, setStyles] = useState<any[]>([]);
  const [health, setHealth] = useState<any>({});

  const refresh = useCallback(async () => {
    setProjects(await api.projects());
    setStyles(await api.styles());
    setHealth(await api.health().catch(() => ({})));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="shell">
      <aside className="side">
        <button className="brand" onClick={() => setView({ kind: "home" })}>
          <span className="brand-mark">G</span>
          <span className="brand-copy"><b>AI 再现制片工作台</b><small>Gitruck Drama Desk</small></span>
        </button>
        <nav className="side-nav" aria-label="工作台导航">
          <div className="side-group side-project-group">
            <div className="side-sec"><span>项目</span><span>{projects.length}</span></div>
            <div className="side-projects">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={`side-item ${view.kind === "project" && view.id === p.id ? "on" : ""}`}
                  aria-current={view.kind === "project" && view.id === p.id ? "page" : undefined}
                  onClick={() => setView({ kind: "project", id: p.id })}
                >
                  <span>{p.name}</span>
                  <small>{p.doc?.beatId}</small>
                </button>
              ))}
            </div>
            <button className={`side-item new ${view.kind === "home" ? "on" : ""}`} onClick={() => setView({ kind: "home" })}>
              <span>＋ 导入分镜稿</span>
            </button>
          </div>
          <div className="side-group side-assets-group">
            <div className="side-sec"><span>资产与系统</span></div>
            <button className={`side-item ${view.kind === "styles" ? "on" : ""}`} onClick={() => setView({ kind: "styles" })}>
              <span>画风资产库</span><small>{styles.length}</small>
            </button>
            <button className={`side-item ${view.kind === "lora" ? "on" : ""}`} onClick={() => setView({ kind: "lora" })}>
              <span>LoRA 训练</span><span className="beta-tag">实验</span>
            </button>
            <button className={`side-item ${view.kind === "settings" ? "on" : ""}`} onClick={() => setView({ kind: "settings" })}>
              <span>设置与诊断</span>
            </button>
          </div>
        </nav>
        <div className="side-foot">
          <span className={`status-dot ${health.comfy ? "ready" : "offline"}`} />
          <span>ComfyUI {health.comfy ? "在线" : "离线"}</span>
        </div>
      </aside>
      <main className="main">
        {view.kind === "home" && (
          <ImportPanel
            styles={styles}
            onCreated={(id) => {
              refresh();
              setView({ kind: "project", id });
            }}
          />
        )}
        {view.kind === "project" && <ProjectBoard id={view.id} styles={styles} providers={health.providers ?? {}} refPolicies={health.refPolicies} />}
        {view.kind === "styles" && <StylesPage styles={styles} onChanged={refresh} />}
        {view.kind === "lora" && <LoraPage styles={styles} onStylesChanged={refresh} />}
        {view.kind === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-heading">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

function ImportPanel({ styles, onCreated }: { styles: any[]; onCreated: (id: string) => void }) {
  const [md, setMd] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [styleId, setStyleId] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (styles.length && !styleId) setStyleId(styles[0].id);
  }, [styles, styleId]);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.createProject({ storyboardMd: md, name: name || undefined, slug: slug || undefined, styleId: styleId || undefined });
      const ws = res.warnings ?? [];
      if (ws.length === 0) {
        onCreated(res.project.id);
      } else {
        // 有解析警告时留在本页展示，用户确认后再进项目（直接跳转会把警告闪没）
        setWarnings(ws);
        setCreatedId(res.project.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel import-page">
      <PageHeader
        eyebrow="新建项目"
        title="导入分镜稿"
        description="把结构化分镜稿转成可以逐镜出图、出片、审片和导出的制片项目。"
      />
      <div className="import-layout">
        <section className="surface-card import-card">
          <div className="section-heading">
            <div><h2>项目与素材</h2><p>粘贴完整 Markdown；工程名和导出 slug 都可以稍后沿用默认值。</p></div>
            <span className="step-badge">01</span>
          </div>
          <div className="form-grid import-fields">
            <label>工程名 <span>可空，取分镜稿标题</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：过拟合" /></label>
            <label>导出 slug <span>小写字母、数字和短横线</span><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="如：overfit-ep12" /></label>
            <label>画风档案 <span>项目创建后仍可切换</span><select value={styleId} onChange={(e) => setStyleId(e.target.value)}><option value="">（暂不选择）</option>{styles.map((s) => <option key={s.id} value={s.id}>{s.name}{s.lora ? " · LoRA" : ""}</option>)}</select></label>
          </div>
          <label className="storyboard-field">
            分镜稿 Markdown
            <textarea className="md-input" value={md} onChange={(e) => setMd(e.target.value)} placeholder="# AI 再现分镜稿 · ……（beat B17）&#10;……" />
          </label>
          <div className="form-actions">
            <button className="primary" disabled={busy || !md.trim() || createdId != null} onClick={submit}>{busy ? "解析中…" : "解析并建立项目"}</button>
            <span className="dim small">解析只建立本地项目，不会立即调用模型。</span>
            {createdId && <button className="primary" onClick={() => onCreated(createdId)}>确认警告并进入项目 →</button>}
          </div>
          {error && <div className="warn bad">{error}</div>}
          {warnings.map((w, i) => <div key={i} className="warn">⚠ {w}</div>)}
        </section>
        <aside className="workflow-card">
          <div className="section-heading"><div><h2>接下来会发生什么</h2><p>先把流程跑通，再逐步提升每一镜的质量。</p></div><span className="step-badge muted">指南</span></div>
          <ol className="workflow-steps">
            <li><b>解析镜头</b><span>识别 beat、时码、角色与镜头描述</span></li>
            <li><b>准备资产</b><span>选择画风，给主要角色上传参考图</span></li>
            <li><b>生成候选</b><span>先出 Keyframe，再从选中帧生成视频</span></li>
            <li><b>审片回轨</b><span>逐镜选择、重 roll、删除并导出回轨包</span></li>
          </ol>
          <div className="tip-box"><b>第一次使用？</b><span>建议先选择 mock 图和 mock 视频，确认整条业务链路正常。</span></div>
        </aside>
      </div>
    </div>
  );
}

function ProjectBoard({ id, styles, providers, refPolicies }: { id: string; styles: any[]; providers: Record<string, boolean>; refPolicies?: Record<string, any> }) {
  const [p, setP] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [kfProvider, setKfProvider] = useState("comfyui-image");
  const [vidProvider, setVidProvider] = useState("comfyui-video");
  const [manifest, setManifest] = useState<any>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  const ready = (pid: string) => providers[pid] !== false; // 未知(健康接口还没回)时不拦

  const refresh = useCallback(async () => {
    setP(await api.project(id));
    setJobs(await api.jobs(id));
  }, [id]);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, 2500);
    return () => clearInterval(timer.current);
  }, [refresh]);

  const active = useMemo(() => jobs.filter((j) => j.status === "queued" || j.status === "running"), [jobs]);
  const failed = useMemo(() => jobs.filter((j) => j.status === "error"), [jobs]);
  // 参考预算裁减等非致命告警（如角色超预算被裁）：成功任务也要浮出来，不静默
  const warned = useMemo(() => jobs.filter((j) => (j.warnings?.length ?? 0) > 0 && j.status !== "error"), [jobs]);
  const style = p ? styles.find((s) => s.id === p.styleId) : undefined;
  const selectedProviderState = keyframeProviderState(kfProvider, providers, style);

  useEffect(() => {
    if (p && kfProvider === "comfyui-image2" && !style?.lora) setKfProvider("comfyui-image");
  }, [kfProvider, p, style]);

  if (!p) return <div className="panel">载入中…</div>;

  return (
    <div className="panel project-page">
      <PageHeader
        eyebrow={`项目 · beat ${p.doc.beatId}`}
        title={p.name}
        description={`时间区间 ${p.doc.trackSt}s → ${p.doc.trackEd}s，约 ${p.doc.totalSec}s，共 ${p.doc.shots.length} 镜。`}
        meta={<>
          <span className="meta-pill">{p.doc.shots.length} 个镜头</span>
          <span className={`meta-pill ${style?.lora ? "success" : ""}`}>LoRA {style?.lora ? "已绑定" : "未绑定"}</span>
          <span className="meta-pill">累计成本 ¥{p.totalCost}</span>
        </>}
        actions={<button onClick={async () => { setManifest(await api.exportProject(id)); refresh(); }}>导出回轨包</button>}
      />

      <section className="project-toolbar surface-card">
        <label className="toolbar-field style-picker">
          <span>项目画风</span>
          <select
            value={p.styleId ?? ""}
            disabled={active.length > 0}
            title={active.length > 0 ? "有生成任务在途，完成后再切换画风" : "切换后续生成使用的画风资产"}
            onChange={async (event) => {
              await api.updateProject(id, { styleId: event.target.value || null });
              await refresh();
            }}
          >
            <option value="">（未选择画风）</option>
            {styles.map((item) => <option key={item.id} value={item.id}>{item.name}{item.lora ? " · LoRA" : ""}</option>)}
          </select>
        </label>
        <span className="toolbar-divider" />
        <label className="toolbar-field">
          <span>Keyframe 引擎</span>
          <select value={kfProvider} onChange={(e) => setKfProvider(e.target.value)}>
            {KF_PROVIDERS.map((x) => {
              const state = keyframeProviderState(x.id, providers, style);
              return <option key={x.id} value={x.id} disabled={!state.enabled}>{x.label}{state.suffix}</option>;
            })}
          </select>
        </label>
        <label className="toolbar-field">
          <span>视频引擎</span>
          <select value={vidProvider} onChange={(e) => setVidProvider(e.target.value)}>
            {VID_PROVIDERS.map((x) => <option key={x.id} value={x.id} disabled={!ready(x.id)}>{x.label}{ready(x.id) ? "" : "（未配置）"}</option>)}
          </select>
        </label>
        <button
          className="primary toolbar-cta"
          disabled={active.length > 0 || !selectedProviderState.enabled}
          title={active.length > 0 ? "有任务在途，跑完再补" : selectedProviderState.reason}
          onClick={async () => { await api.auto(id, kfProvider, vidProvider); refresh(); }}
        >
          {active.length > 0 ? "任务进行中…" : "▶ 全自动补齐"}
        </button>
      </section>

      {active.length > 0 && (
        <div className="jobs-bar">
          {active.length} 个任务进行中：
          {active.map((j) => (
            <span key={j.id} className="job-chip">
              s{j.shotIndex} {j.kind === "keyframe" ? "图" : "片"} · {j.status === "running" ? "生成中" : "排队"}
            </span>
          ))}
        </div>
      )}
      {failed.length > 0 && (
        <div className="warn bad">
          {failed.slice(-3).map((j) => (
            <div key={j.id}>
              s{j.shotIndex} {j.kind} 失败：{j.error}
            </div>
          ))}
        </div>
      )}
      {warned.length > 0 && (
        <div className="warn">
          {warned.slice(-3).map((j) => (
            <div key={j.id}>
              s{j.shotIndex} {j.kind === "keyframe" ? "图" : "片"} 告警：{(j.warnings ?? []).join("；")}
            </div>
          ))}
        </div>
      )}

      <section className="page-section character-section">
        <div className="section-heading">
          <div><h2>角色资产</h2><p>源图两个参考集共享；喂法随当前 Keyframe 引擎自动切换。</p></div>
          <span className="section-count" title={strategyBadgeText(refPolicyFor(kfProvider, refPolicies as any))}>{p.doc.characters.length} 个角色</span>
        </div>
        <CharacterPanel p={p} kfProvider={kfProvider} refPolicies={refPolicies as any} onChanged={refresh} />
      </section>

      <section className="page-section shots-section">
        <div className="section-heading sticky-section-heading">
          <div><h2>镜头工作区</h2><p>按镜审阅文本、Keyframe 和视频；橙色描边表示当前选用候选。</p></div>
          <span className="section-count">{p.shotsView.length} 镜</span>
        </div>
        {p.shotsView.map((shot: any) => <ShotCard key={shot.index} p={p} shot={shot} kfProvider={kfProvider} vidProvider={vidProvider} onChanged={refresh} />)}
      </section>

      {manifest && <ManifestView manifest={manifest} pid={id} onClose={() => setManifest(null)} />}
    </div>
  );
}

/** 点缩略图放大预览：大图 / 带控件的视频，可左右切候选、就地选用/删除。 */
function MediaPreview({
  kind, file, url, idx, total, chosen,
  onPrev, onNext, onChoose, onDelete, onClose,
}: {
  kind: "keyframe" | "video";
  file: string; url: string; idx: number; total: number; chosen: boolean;
  onPrev: () => void; onNext: () => void; onChoose: () => void; onDelete: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && total > 1) onPrev();
      else if (e.key === "ArrowRight" && total > 1) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, total]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal media-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="media-preview-head">
          <div><b>{kind === "keyframe" ? "Keyframe" : "视频"}</b> <span className="dim small">{file} · {idx + 1}/{total}</span></div>
          <button className="mini" onClick={onClose}>关闭</button>
        </div>
        <div className="media-preview-stage">
          {total > 1 && <button className="preview-nav prev" title="上一张（←）" onClick={onPrev}>‹</button>}
          {kind === "keyframe"
            ? <img key={url} src={url} alt={file} />
            : <video key={url} src={url} controls loop autoPlay muted />}
          {total > 1 && <button className="preview-nav next" title="下一张（→）" onClick={onNext}>›</button>}
        </div>
        <div className="media-preview-actions">
          <button className="primary" disabled={chosen} onClick={onChoose}>{chosen ? "✓ 当前选用" : "选用此候选"}</button>
          <button className="danger" onClick={onDelete}>删除此候选</button>
          <span className="dim small">← → 切换候选 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}

function ShotCard({
  p,
  shot,
  kfProvider,
  vidProvider,
  onChanged,
}: {
  p: any;
  shot: any;
  kfProvider: string;
  vidProvider: string;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<{ kind: "keyframe" | "video"; idx: number } | null>(null);
  const gen = async (kind: "keyframe" | "video", provider: string) => {
    await api.generate(p.id, shot.index, kind, provider);
    onChanged();
  };
  const remove = async (kind: "keyframe" | "video", file: string) => {
    try {
      const preview = await api.previewDeleteOutput(p.id, shot.index, kind, file);
      const impacts = [
        "文件将被永久删除，不能撤销。",
        preview.selected ? "这是当前选中项，删除后会清除选择。" : "",
        preview.derivedVideos?.length ? `该 keyframe 所在镜已有 ${preview.derivedVideos.length} 个视频；视频会保留。` : "",
        "已导出的副本不受影响。",
      ].filter(Boolean);
      if (!window.confirm(`确认删除 ${kind === "keyframe" ? "keyframe" : "视频"}「${file}」？\n\n${impacts.join("\n")}`)) return;
      await api.deleteOutput(p.id, shot.index, kind, file);
      onChanged();
    } catch (error) {
      window.alert(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (
    <div className="shot-card">
      <div className="shot-text">
        <div className="shot-title">
          <span className="shot-index">{shot.key}</span>
          <div><b>{shot.title}</b><span>≈{shot.durationSec ?? "?"}s · {shot.scene ?? ""}</span></div>
        </div>
        {Array.isArray(shot.cast) && shot.cast.length > 0 && <div className="shot-cast">{shot.cast.map((name: string) => <span key={name}>{name}</span>)}</div>}
        {shot.stylePrefix && <div className="shot-prefix">〔{shot.stylePrefix}〕</div>}
        <div className="shot-desc">{shot.description}</div>
        {shot.sourceLines && <div className="dim small">对应原文：{shot.sourceLines}</div>}
      </div>

      <div className="shot-media">
        <div className="media-col">
          <div className="media-head">
            <span><b>Keyframe</b><small>{shot.keyframes.length} 个候选</small></span>
            <button className="mini" onClick={() => gen("keyframe", kfProvider)}>
              {shot.keyframes.length ? "重 roll" : "出图"}
            </button>
          </div>
          <div className="thumbs">
            {shot.keyframes.map((f: string, i: number) => (
              <div className="media-item" key={f}>
                <img
                  className={shot.choices.keyframe === f ? "chosen" : ""}
                  src={projFile(p.id, `keyframes/${shot.key}/${f}`)}
                  title={`${f}（点击放大预览）`}
                  onClick={() => setPreview({ kind: "keyframe", idx: i })}
                />
                <button className="media-delete" title="永久删除" aria-label={`删除 ${f}`} onClick={() => remove("keyframe", f)}>
                  ×
                </button>
              </div>
            ))}
            {shot.keyframes.length === 0 && <div className="dim small empty">待出图</div>}
          </div>
        </div>
        <div className="media-col">
          <div className="media-head">
            <span><b>视频</b><small>{shot.videos.length} 个候选</small></span>
            <button className="mini" disabled={shot.keyframes.length === 0} onClick={() => gen("video", vidProvider)}>
              {shot.videos.length ? "重 roll" : "出片"}
            </button>
          </div>
          <div className="thumbs">
            {shot.videos.map((f: string, i: number) => (
              <div className="media-item" key={f}>
                <video
                  className={shot.choices.video === f ? "chosen" : ""}
                  src={projFile(p.id, `videos/${shot.key}/${f}`)}
                  title={`${f}（点击放大预览）`}
                  muted
                  loop
                  onMouseEnter={(e) => e.currentTarget.play()}
                  onMouseLeave={(e) => e.currentTarget.pause()}
                  onClick={() => setPreview({ kind: "video", idx: i })}
                />
                <button className="media-delete" title="永久删除" aria-label={`删除 ${f}`} onClick={() => remove("video", f)}>
                  ×
                </button>
              </div>
            ))}
            {shot.videos.length === 0 && <div className="dim small empty">待出片</div>}
          </div>
        </div>
      </div>

      {preview && (() => {
        const list: string[] = preview.kind === "keyframe" ? shot.keyframes : shot.videos;
        const file = list[preview.idx];
        if (!file) { setPreview(null); return null; } // 候选被删/清空，关闭
        const dir = preview.kind === "keyframe" ? "keyframes" : "videos";
        return (
          <MediaPreview
            kind={preview.kind}
            file={file}
            url={projFile(p.id, `${dir}/${shot.key}/${file}`)}
            idx={preview.idx}
            total={list.length}
            chosen={shot.choices[preview.kind] === file}
            onPrev={() => setPreview((s) => s && { ...s, idx: (s.idx - 1 + list.length) % list.length })}
            onNext={() => setPreview((s) => s && { ...s, idx: (s.idx + 1) % list.length })}
            onChoose={async () => { await api.choose(p.id, shot.index, preview.kind, file); onChanged(); }}
            onDelete={async () => { await remove(preview.kind, file); setPreview(null); }}
            onClose={() => setPreview(null)}
          />
        );
      })()}
    </div>
  );
}

function ManifestView({ manifest, pid, onClose }: { manifest: any; pid: string; onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>导出完成 · beat {manifest.beatId}</h2>
        <p className="dim">
          目录：data/projects/{pid}/exports/aidrama/ ｜ 建议 {manifest.totalSuggestedSec}s / 实测{" "}
          {manifest.totalMeasuredSec}s ｜ 成本 ¥{manifest.totalCost}
        </p>
        {manifest.skipped.length > 0 && <div className="warn">未导出（无视频）：s{manifest.skipped.join("、s")}</div>}
        <table>
          <thead>
            <tr>
              <th>镜</th>
              <th>文件</th>
              <th>建议</th>
              <th>实测</th>
              <th>差值</th>
            </tr>
          </thead>
          <tbody>
            {manifest.items.map((i: any) => (
              <tr key={i.shotIndex}>
                <td>s{i.shotIndex}</td>
                <td>{i.file}</td>
                <td>{i.suggestedSec ?? "-"}s</td>
                <td>{i.measuredSec?.toFixed(2)}s</td>
                <td className={Math.abs(i.deltaSec ?? 0) > 1 ? "bad" : ""}>{i.deltaSec}s</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dim small">下一步：满意的镜可先放大到 720p 替换 → 把片段拖回你的 NLE，按 beat 区间对齐。</p>
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

function StylesPage({ styles, onChanged }: { styles: any[]; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="panel styles-page">
      <PageHeader
        eyebrow="视觉资产"
        title="画风资产库"
        description="集中管理画风文本、参考图和 LoRA 绑定。修改会影响使用该画风的后续生成。"
        meta={<><span className="meta-pill">{styles.length} 个画风</span><span className="meta-pill success">{styles.filter((style) => style.lora).length} 个已绑定 LoRA</span></>}
        actions={<div className="page-actions-row">
          <button className="primary" onClick={() => setCreating((x) => !x)}>{creating ? "取消新增" : "＋ 新增画风"}</button>
          <label className="button-like">
            导入 Style Pack
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  await api.importStylePack(JSON.parse(await file.text()), "rename");
                  setError("");
                  onChanged();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
                event.target.value = "";
              }}
            />
          </label>
        </div>}
      />
      <div className="info-strip"><span>Style Pack 默认不携带 LoRA 权重与参考图大文件。</span><span>删除操作不可撤销，系统会先检查项目引用。</span></div>
      {creating && <CreateStyleForm onCreated={() => { setCreating(false); onChanged(); }} />}
      {error && <div className="warn bad">{error}</div>}
      <div className="style-list">{styles.map((s) => <StyleEditor key={`${s.id}-${s.updatedAt ?? "legacy"}`} style={s} allStyles={styles} onChanged={onChanged} />)}</div>
      {styles.length === 0 && <div className="warn">画风库为空，请新增画风或导入 Style Pack。</div>}
    </div>
  );
}

function CreateStyleForm({ onCreated }: { onCreated: () => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="surface-card style-create">
      <div className="section-heading"><div><h2>新增画风</h2><p>先创建基本档案，再补充风格锁、参考图和 LoRA。</p></div><span className="step-badge">新建</span></div>
      <div className="form-actions style-create-fields">
        <label>ID <span>小写字母、数字和短横线</span><input value={id} onChange={(e) => setId(e.target.value)} placeholder="warm-home" /></label>
        <label>显示名称 <span>用于项目选择器</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="暖色家庭插画" /></label>
        <button className="primary" disabled={!id || !name} onClick={async () => {
          try {
            await api.createStyle({ id, name, styleLock: "", negatives: "", refs: [] });
            onCreated();
          } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        }}>创建画风</button>
      </div>
      {error && <div className="warn bad">{error}</div>}
    </div>
  );
}

function StyleEditor({ style, allStyles, onChanged }: { style: any; allStyles: any[]; onChanged: () => void }) {
  const [draft, setDraft] = useState({
    name: style.name ?? "",
    styleLock: style.styleLock ?? "",
    styleLockEn: style.styleLockEn ?? "",
    negatives: style.negatives ?? "",
    negativesEn: style.negativesEn ?? "",
    notes: style.notes ?? "",
    license: style.license ?? "",
  });
  const [msg, setMsg] = useState("");
  const field = (key: keyof typeof draft) => ({
    value: draft[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((x) => ({ ...x, [key]: e.target.value })),
  });
  const save = async () => {
    try { await api.saveStyle(style.id, draft); setMsg("已保存"); onChanged(); }
    catch (e) { setMsg(`保存失败：${e instanceof Error ? e.message : e}`); }
  };
  const removeWhole = async () => {
    try {
      const usage = await api.styleUsage(style.id);
      let replacementStyleId: string | undefined;
      let force = false;
      if (usage.projects.length) {
        const candidates = allStyles.filter((x) => x.id !== style.id).map((x) => x.id).join("、");
        const answer = window.prompt(`该画风仍被 ${usage.projects.length} 个项目引用。\n输入替代画风 ID（可选：${candidates || "无"}），或输入 FORCE 强制解绑；取消则不删除。`);
        if (answer == null || !answer.trim()) return;
        if (answer.trim() === "FORCE") force = true;
        else replacementStyleId = answer.trim();
      }
      if (!window.confirm(`永久删除整个画风「${style.name}」及其本地参考图？此操作不能撤销。`)) return;
      await api.deleteStyle(style.id, { replacementStyleId, force });
      onChanged();
    } catch (e) { setMsg(`删除失败：${e instanceof Error ? e.message : e}`); }
  };
  const exportPack = async () => {
    try {
      const pack = await api.exportStylePack(style.id, false, false);
      const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = `${style.id}.style-pack.json`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setMsg(`导出失败：${e instanceof Error ? e.message : e}`); }
  };
  return (
    <div className="style-card">
      <div className="style-card-head">
        <div className="style-identity"><span className="style-avatar">{style.name?.slice(0, 1) || "风"}</span><div><h2>{style.name}</h2><div><code>{style.id}</code><span className={`meta-pill compact ${style.lora ? "success" : ""}`}>{style.lora ? "LoRA 已绑定" : "无 LoRA"}</span></div></div></div>
        <div className="page-actions-row"><button onClick={exportPack}>导出 Pack</button><button className="danger" onClick={removeWhole}>删除整个画风</button></div>
      </div>
      <div className="style-editor-layout">
        <section className="style-copy-panel">
          <div className="form-grid style-fields"><label>名称<input {...field("name")} /></label><label>许可声明<input {...field("license")} placeholder="如 CC-BY-4.0" /></label></div>
          <div className="style-copy-grid">
            <label>Style Lock<textarea className="style-textarea" {...field("styleLock")} /></label>
            <label>Style Lock · EN<textarea className="style-textarea" {...field("styleLockEn")} /></label>
            <label>负面提示<textarea className="style-textarea short" {...field("negatives")} /></label>
            <label>负面提示 · EN<textarea className="style-textarea short" {...field("negativesEn")} /></label>
          </div>
          <label>维护备注<textarea className="style-textarea short" {...field("notes")} /></label>
          <div className="form-actions"><button className="primary" onClick={save}>保存修改</button><span className="dim">{msg}</span></div>
        </section>
        <aside className="style-assets-panel">
          <div className="section-heading"><div><h3>参考图</h3><p>{style.refs.length} 张画风锚图</p></div><label className="button-like small-button">＋ 添加图片<input type="file" accept="image/*" multiple hidden onChange={async (e) => { if (e.target.files?.length) { await api.uploadStyleRefs(style.id, e.target.files); onChanged(); } e.target.value = ""; }} /></label></div>
          <div className="style-refs">
            {style.refs.map((f: string) => <div className="style-ref-item" key={f}><img src={styleRef(style.id, f)} title={f} /><button className="media-delete" title="删除参考图" onClick={async () => { if (!window.confirm(`永久删除参考图「${f}」？`)) return; await api.deleteStyleRef(style.id, f); onChanged(); }}>×</button></div>)}
            {style.refs.length === 0 && <div className="empty-state"><b>暂无参考图</b><span>上传少量能够代表线条、色温和材质的锚图。</span></div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

const EMPTY_LORA_FORM = {
  name: "",
  pythonPath: "",
  trainerRoot: "",
  datasetConfig: "",
  baseModel: "",
  vaePath: "",
  textEncoderPath: "",
  outputDir: "",
  outputName: "",
  maxTrainSteps: "2000",
  saveEveryNSteps: "100",
  learningRate: "0.0001",
  networkDim: "32",
  networkAlpha: "16",
  blocksToSwap: "0",
  triggerWords: "",
  license: "",
  extraArgs: "",
  dryRun: false,
};

function LoraPage({ styles, onStylesChanged }: { styles: any[]; onStylesChanged: () => Promise<void> | void }) {
  const [form, setForm] = useState({ ...EMPTY_LORA_FORM });
  const [jobs, setJobs] = useState<LoraJob[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<LoraJob | null>(null);
  const [log, setLog] = useState("");
  const [publishStyle, setPublishStyle] = useState("");
  const [preflight, setPreflight] = useState<{ ok: boolean; missing: string[]; adapter?: string } | null>(null);
  const [message, setMessage] = useState("");

  const makeRequest = (): LoraTrainRequest => ({
    name: form.name,
    adapter: form.dryRun ? "fake" : "musubi-qwen-image-edit",
    pythonPath: form.pythonPath,
    trainerRoot: form.trainerRoot,
    datasetConfig: form.datasetConfig,
    baseModel: form.baseModel,
    vaePath: form.vaePath,
    textEncoderPath: form.textEncoderPath,
    outputDir: form.outputDir,
    outputName: form.outputName,
    maxTrainSteps: Number(form.maxTrainSteps),
    saveEveryNSteps: Number(form.saveEveryNSteps),
    learningRate: Number(form.learningRate),
    networkDim: Number(form.networkDim),
    networkAlpha: Number(form.networkAlpha),
    blocksToSwap: Number(form.blocksToSwap),
    triggerWords: form.triggerWords.split(",").map((x) => x.trim()).filter(Boolean),
    license: form.license || undefined,
    extraArgs: form.extraArgs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    dryRun: form.dryRun,
  });

  const refresh = useCallback(async () => {
    const next = await api.loraJobs() as LoraJob[];
    setJobs(next);
    const id = selectedId || next[0]?.id;
    if (id) {
      if (!selectedId) setSelectedId(id);
      const [job, tail] = await Promise.all([api.loraJob(id), api.loraLog(id).catch(() => ({ text: "" }))]);
      setSelected(job as LoraJob);
      setLog((tail as { text: string }).text);
    } else {
      setSelected(null);
      setLog("");
    }
  }, [selectedId]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
    const timer = setInterval(() => refresh().catch(() => undefined), 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  const setField = (key: keyof typeof EMPTY_LORA_FORM, value: string | boolean) => {
    setForm((current) => ({ ...current, [key]: value }));
    setPreflight(null);
  };
  const fakeExample = () => setForm({
    ...EMPTY_LORA_FORM,
    name: "smoke-test",
    pythonPath: "fake-python",
    trainerRoot: "fake-trainer",
    datasetConfig: "fake-dataset.toml",
    baseModel: "fake-base.safetensors",
    vaePath: "fake-vae.safetensors",
    textEncoderPath: "fake-text-encoder.safetensors",
    outputDir: "data/lora/smoke-output",
    outputName: "smoke-lora",
    maxTrainSteps: "8",
    saveEveryNSteps: "4",
    extraArgs: "--fake-delay-ms=10",
    license: "test-only",
    dryRun: true,
  });

  const validate = async () => {
    setMessage("");
    try {
      const result = await api.validateLora(makeRequest());
      setPreflight(result);
      return result as { ok: boolean; missing: string[] };
    } catch (error) {
      setPreflight(null);
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  const submit = async () => {
    const result = await validate();
    if (!result?.ok) return;
    try {
      const job = await api.trainLora(makeRequest()) as LoraJob;
      setSelectedId(job.id);
      setMessage(`已提交 ${job.id}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="panel lora-page">
      <PageHeader
        eyebrow="实验能力"
        title="LoRA 训练"
        description="创建、观察、恢复并发布画风 LoRA。训练会独占本地 GPU，本页不会自动安装训练器或下载模型。"
        meta={<><span className="meta-pill">{jobs.length} 个任务</span><span className="meta-pill success">{jobs.filter((job) => job.status === "succeeded").length} 个已完成</span></>}
        actions={<button onClick={fakeExample}>载入无 GPU 示例</button>}
      />
      <div className="beta-banner"><span className="beta-icon">β</span><div><b>{EDITION_NOTICE}</b><span>只在本工作台仓库中提供，不会注册到公开 gtrk-cli；正式训练前请先做提交前检查。</span></div></div>
      <div className="lora-layout">
        <section className="lora-form-card">
          <div className="section-heading"><div><h2>新建训练任务</h2><p>路径信息不会打包进开源发行物。</p></div><span className="step-badge">配置</span></div>
          <h3 className="form-subhead">任务标识</h3>
          <div className="lora-grid compact-grid">
            {([ ["name", "任务名"], ["outputName", "输出名"], ["triggerWords", "触发词（逗号分隔）"], ["license", "数据/产物许可"] ] as Array<[keyof typeof EMPTY_LORA_FORM, string]>).map(([key, label]) => <label key={key}>{label}<input value={String(form[key])} onChange={(e) => setField(key, e.target.value)} /></label>)}
          </div>
          <h3 className="form-subhead">训练环境与模型</h3>
          <div className="lora-grid path-grid">
            {([ ["pythonPath", "Python 路径"], ["trainerRoot", "musubi 目录"], ["datasetConfig", "数据集 TOML"], ["baseModel", "基础模型"], ["vaePath", "VAE"], ["textEncoderPath", "文本编码器"], ["outputDir", "输出目录"] ] as Array<[keyof typeof EMPTY_LORA_FORM, string]>).map(([key, label]) => <label key={key}>{label}<input value={String(form[key])} onChange={(e) => setField(key, e.target.value)} /></label>)}
          </div>
          <h3 className="form-subhead">训练参数</h3>
          <div className="lora-grid parameter-grid">
            {([ ["maxTrainSteps", "总 steps"], ["saveEveryNSteps", "每 N step 保存"], ["learningRate", "学习率"], ["networkDim", "network dim"], ["networkAlpha", "network alpha"], ["blocksToSwap", "blocks to swap"] ] as Array<[keyof typeof EMPTY_LORA_FORM, string]>).map(([key, label]) => <label key={key}>{label}<input value={String(form[key])} onChange={(e) => setField(key, e.target.value)} /></label>)}
          </div>
          <label>附加参数（每行一个）<textarea className="style-textarea short mono" value={form.extraArgs} onChange={(e) => setField("extraArgs", e.target.value)} /></label>
          <label className="inline-check"><input type="checkbox" checked={form.dryRun} onChange={(e) => setField("dryRun", e.target.checked)} />无 GPU 假训练（仅用于端到端验证）</label>
          <div className="form-actions"><button onClick={validate}>提交前检查</button><button className="primary" onClick={submit}>提交训练</button></div>
          {preflight && <div className={`warn ${preflight.ok ? "" : "bad"}`}>{preflight.ok ? `检查通过 · ${preflight.adapter}` : `缺失：${preflight.missing.join("、")}`}</div>}
          {message && <div className="warn">{message}</div>}
        </section>
        <section className="lora-jobs-card">
          <div className="section-heading"><div><h2>训练任务</h2><p>选择任务查看状态、checkpoint 和日志。</p></div><span className="step-badge muted">队列</span></div>
          <div className="lora-job-list">
            {jobs.map((job) => <button key={job.id} className={job.id === selectedId ? "on" : ""} onClick={() => setSelectedId(job.id)}><b>{job.request.name}</b><span>{job.status}{job.progress ? ` · ${job.progress.absoluteStep}/${job.progress.totalAbsoluteSteps}` : ""}</span></button>)}
            {jobs.length === 0 && <span className="dim">暂无任务</span>}
          </div>
          {selected && <LoraJobDetail job={selected} log={log} styles={styles} publishStyle={publishStyle} setPublishStyle={setPublishStyle} onChanged={async () => { await refresh(); await onStylesChanged(); }} />}
        </section>
      </div>
    </div>
  );
}

function LoraJobDetail({ job, log, styles, publishStyle, setPublishStyle, onChanged }: { job: LoraJob; log: string; styles: any[]; publishStyle: string; setPublishStyle: (id: string) => void; onChanged: () => Promise<void> }) {
  const canCancel = ["queued", "blocked", "starting", "running", "recoverable"].includes(job.status);
  const canResume = ["failed", "cancelled", "recoverable"].includes(job.status) && job.checkpoints.length > 0;
  return <div className="lora-detail">
    <div className="job-detail-head"><div><span className="eyebrow">任务详情</span><h2>{job.request.name}</h2><code>{job.id}</code></div><span className={`status-badge status-${job.status}`}>{job.status}</span></div>
    <div className="status-line">{job.progress ? <><b>{job.progress.absoluteStep}/{job.progress.totalAbsoluteSteps}</b><span>{job.progress.loss != null ? `loss ${job.progress.loss}` : "训练进行中"}</span></> : <span>尚无进度数据</span>}</div>
    {job.blockedReason && <div className="warn">GPU 阻塞：{job.blockedReason}</div>}
    {job.error && <div className="warn bad">{job.error}</div>}
    <div className="row compact">
      {canCancel && <button className="danger" onClick={async () => { if (!window.confirm(`取消任务 ${job.id}？`)) return; await api.cancelLora(job.id); await onChanged(); }}>取消</button>}
      {canResume && <button onClick={async () => { await api.resumeLora(job.id); await onChanged(); }}>从 checkpoint 恢复</button>}
      {job.manifest && <><select value={publishStyle} onChange={(e) => setPublishStyle(e.target.value)}><option value="">选择发布画风</option>{styles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}</select><button className="primary" disabled={!publishStyle} onClick={async () => { await api.publishLora(job.id, publishStyle); await onChanged(); }}>发布到画风</button></>}
    </div>
    <h3 className="detail-subhead">Checkpoints</h3>
    <ul className="checkpoint-list">{job.checkpoints.map((checkpoint) => <li key={`${checkpoint.step}-${checkpoint.path}`}>step {checkpoint.step} · {checkpoint.path}</li>)}{job.checkpoints.length === 0 && <li className="dim">尚无 checkpoint</li>}</ul>
    <h3 className="detail-subhead">训练日志（尾部）</h3>
    <pre className="trainer-log">{log || "暂无日志"}</pre>
  </div>;
}

function SettingsPage() {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [diagnostic, setDiagnostic] = useState<any>(null);
  const [diagnosticError, setDiagnosticError] = useState("");
  const inspect = useCallback(async () => {
    try {
      setDiagnostic(await api.comfyDiagnostic());
      setDiagnosticError("");
    } catch (error) {
      setDiagnosticError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => {
    api.config().then((c) => setText(JSON.stringify(c, null, 2)));
    inspect();
  }, [inspect]);
  return (
    <div className="panel settings-page">
      <PageHeader eyebrow="系统" title="设置与诊断" description="检查 ComfyUI 运行环境与工作流依赖，并管理工作台本地配置。" actions={<button onClick={inspect}>重新诊断</button>} />
      {diagnosticError && <div className="warn bad">{diagnosticError}</div>}
      <section className="page-section"><div className="section-heading"><div><h2>ComfyUI 运行诊断</h2><p>只读 system_stats、object_info 和 queue；不会提交 prompt、加载模型或调用付费服务。</p></div><span className="section-count">5 层检查</span></div>{diagnostic && <ComfyDiagnosticPanel diagnostic={diagnostic} />}</section>
      <section className="surface-card config-card">
        <div className="section-heading"><div><h2>工作台配置</h2><p>管理服务地址、workflow 模板、节点映射、云端密钥状态、分辨率和成本单价。</p></div><span className="step-badge muted">JSON</span></div>
        <textarea className="md-input mono config-editor" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="form-actions"><button className="primary" onClick={async () => { try { await api.saveConfig(JSON.parse(text)); setMsg("已保存"); } catch (e) { setMsg(`保存失败：${e instanceof Error ? e.message : e}`); } }}>保存配置</button><span className="dim">{msg || "修改后保存，新的生成任务将使用最新配置。"}</span></div>
      </section>
    </div>
  );
}

function ComfyDiagnosticPanel({ diagnostic }: { diagnostic: any }) {
  const bytes = (value?: number) => value == null ? "未知" : `${(value / 1024 ** 3).toFixed(1)} GB`;
  const stateLabel: Record<string, string> = { ready: "就绪", "not-ready": "未就绪", offline: "离线", "not-configured": "未配置", unknown: "未知" };
  return <div className="diagnostic-panel">
    <div className="diagnostic-summary">
      <b>ComfyUI：<span className={diagnostic.service.state === "ready" ? "ok" : "bad"}>{stateLabel[diagnostic.service.state]}</span></b>
      <span className="dim">{diagnostic.comfyUrl}</span>
      <span>队列：{diagnostic.queue.running ?? "?"} 运行 / {diagnostic.queue.pending ?? "?"} 等待</span>
    </div>
    {diagnostic.runtime && <div className="runtime-strip">
      <span>Python {diagnostic.runtime.pythonVersion ?? "?"}</span><span>Torch {diagnostic.runtime.torchVersion ?? "?"}</span><span>CUDA {diagnostic.runtime.cudaAvailable ? "可用" : "未报告"}</span>
      {diagnostic.runtime.devices.map((device: any, index: number) => <span key={`${device.name}-${index}`}>{device.name} · 显存 {bytes(device.vramFree)} / {bytes(device.vramTotal)}</span>)}
    </div>}
    <div className="diagnostic-grid">{Object.values(diagnostic.providers).map((provider: any) => <div className={`diagnostic-card ${provider.ready ? "ready" : ""}`} key={provider.id}>
      <div className="media-head"><b>{provider.id}</b><span className={provider.ready ? "ok" : "bad"}>{provider.ready ? "可运行" : "不可运行"}</span></div>
      {(["service", "runtime", "workflow", "nodes", "models"] as const).map((layer) => <div className="diagnostic-layer" key={layer}><span>{layer}</span><b className={provider[layer].state === "ready" ? "ok" : "bad"}>{stateLabel[provider[layer].state]}</b>{provider[layer].message && <small>{provider[layer].message}</small>}{provider[layer].missing?.length > 0 && <code>{provider[layer].missing.join("\n")}</code>}</div>)}
      {provider.nodes.missing?.length > 0 && <p className="dim small">修复：在 ComfyUI-Manager 中安装提供这些节点的插件，重启 ComfyUI 后重新诊断。</p>}
      {provider.models.missing?.length > 0 && <p className="dim small">修复：按前缀目录放入缺少模型（例如 models/diffusion_models、text_encoders、vae、loras），再刷新 ComfyUI 模型列表。</p>}
    </div>)}</div>
  </div>;
}
