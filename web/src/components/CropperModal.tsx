import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import {
  clampRect,
  displayToNatural,
  drawRect,
  moveRect,
  rectToPercent,
  resizeRect,
  smartInitialRect,
  thirdPreset,
  type Handle,
  type Rect,
} from "../crop-math.ts";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const RATIO_OPTIONS: { label: string; value: number | null }[] = [
  { label: "自由", value: null },
  { label: "1:1", value: 1 },
  { label: "3:4", value: 3 / 4 },
];

type DragMode =
  | { kind: "draw"; anchor: { x: number; y: number } }
  | { kind: "move"; origin: Rect; from: { x: number; y: number } }
  | { kind: "resize"; handle: Handle; origin: Rect; from: { x: number; y: number } };

export function characterAssetUrl(projectId: string, character: any, file: string) {
  const encodedFile = file.split(/[\\/]/).map(encodeURIComponent).join("/");
  return `/files/projects/${projectId}/characters/${encodeURIComponent(character.dirName ?? character.name)}/${encodedFile}`;
}

/**
 * 拖拽裁剪画布：坐标一律以原图自然像素维护（crop-math），显示层按 img 实际渲染尺寸换算。
 * crop === null 表示「使用整图」。保存目标恒为该角色的单人单图集（generation-reference）。
 */
export function CropperModal({
  projectId,
  character,
  initialSource,
  onClose,
  onSaved,
}: {
  projectId: string;
  character: any;
  initialSource: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [source, setSource] = useState(initialSource);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragMode | null>(null);
  const generationRef = character.generationRef;

  // 指针显示坐标 → 自然像素坐标
  const toNatural = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img || !dims) return null;
    const box = img.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    const point = displayToNatural(
      { x: clientX - box.left, y: clientY - box.top },
      dims.width / box.width,
      dims.height / box.height,
    );
    return { x: Math.max(0, Math.min(dims.width, point.x)), y: Math.max(0, Math.min(dims.height, point.y)) };
  }, [dims]);

  const onImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const next = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
    setDims(next);
    // 二次编辑回填：该 source 已是当前主参考且带裁剪记录时，回填上次矩形；
    // 否则横排多视图（宽高比 ≥2.5）智能预置中 1/3；再否则整图。
    if (generationRef?.status === "ready" && generationRef.source === source && generationRef.crop) {
      setCrop(clampRect(generationRef.crop, next.width, next.height));
    } else {
      setCrop(smartInitialRect(next.width, next.height));
    }
  };

  const beginDrag = (event: React.PointerEvent, mode: DragMode) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = mode;
    stageRef.current?.setPointerCapture(event.pointerId);
  };

  const onStagePointerDown = (event: React.PointerEvent) => {
    const point = toNatural(event.clientX, event.clientY);
    if (!point) return;
    beginDrag(event, { kind: "draw", anchor: point });
    setCrop(null);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !dims) return;
    const point = toNatural(event.clientX, event.clientY);
    if (!point) return;
    if (drag.kind === "draw") {
      // 拖出 ≥3px 才算画框，避免单击误产生极小选框
      if (Math.abs(point.x - drag.anchor.x) < 3 && Math.abs(point.y - drag.anchor.y) < 3) return;
      setCrop(drawRect(drag.anchor, point, dims.width, dims.height, ratio));
    } else if (drag.kind === "move") {
      setCrop(moveRect(drag.origin, point.x - drag.from.x, point.y - drag.from.y, dims.width, dims.height));
    } else {
      setCrop(resizeRect(drag.origin, drag.handle, point.x - drag.from.x, point.y - drag.from.y, dims.width, dims.height, ratio));
    }
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!crop || !dims) return;
    const step = event.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    setCrop(moveRect(crop, move[0], move[1], dims.width, dims.height));
  };

  const updateNumber = (key: keyof Rect, raw: number) => {
    if (!crop || !dims || !Number.isFinite(raw)) return;
    setCrop(clampRect({ ...crop, [key]: Math.round(raw) }, dims.width, dims.height));
  };

  // 所见即所得预览：canvas 按当前矩形真实绘制（替换 background-position 数学模拟）
  useEffect(() => {
    const canvas = previewRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !dims || !img.complete) return;
    const region = crop ?? { x: 0, y: 0, width: dims.width, height: dims.height };
    const scale = Math.min(220 / region.width, 220 / region.height, 1);
    canvas.width = Math.max(1, Math.round(region.width * scale));
    canvas.height = Math.max(1, Math.round(region.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  }, [crop, dims, source]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api.setCharacterGenerationReference(projectId, character.name, { source, ...(crop ? { crop } : {}) });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const percent = crop && dims ? rectToPercent(crop, dims.width, dims.height) : null;
  const imageUrl = characterAssetUrl(projectId, character, source);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal character-ref-modal" onClick={(e) => e.stopPropagation()}>
        <div className="section-heading">
          <div><h2>{character.name} · 单人主参考</h2><p>在原图上直接拖出选框；原图保留不变，生成时只送框内人物。</p></div>
          <button className="mini" onClick={onClose}>关闭</button>
        </div>

        <div className="generation-source-picker">
          {character.refs.map((file: string) => (
            <button
              key={file}
              className={source === file ? "on" : ""}
              onClick={() => {
                // 同图早退：src 不变时 onLoad 不会再触发，清空 dims 会把弹窗卡死在「正在读取图片尺寸」
                if (file === source) return;
                setSource(file);
                setDims(null);
                setCrop(null);
              }}
            ><img src={characterAssetUrl(projectId, character, file)} alt={file} /><span>{file}</span></button>
          ))}
        </div>

        <div className="crop-workspace">
          <div
            ref={stageRef}
            className="crop-canvas cropper-stage"
            tabIndex={0}
            onPointerDown={onStagePointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          >
            <img ref={imgRef} src={imageUrl} alt={`${character.name}原始参考图`} onLoad={onImageLoad} draggable={false} />
            {percent && (
              <div
                className="crop-selection crop-box"
                style={{ left: `${percent.x}%`, top: `${percent.y}%`, width: `${percent.width}%`, height: `${percent.height}%` }}
                onPointerDown={(event) => {
                  const point = toNatural(event.clientX, event.clientY);
                  if (!point || !crop) return;
                  beginDrag(event, { kind: "move", origin: crop, from: point });
                }}
              >
                {HANDLES.map((handle) => (
                  <span
                    key={handle}
                    className={`crop-handle handle-${handle}`}
                    onPointerDown={(event) => {
                      const point = toNatural(event.clientX, event.clientY);
                      if (!point || !crop) return;
                      beginDrag(event, { kind: "resize", handle, origin: crop, from: point });
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          <aside className="crop-controls">
            <div className="crop-presets">
              <button className={crop === null ? "on" : ""} onClick={() => setCrop(null)}>整图</button>
              {([0, 1, 2] as const).map((i) => (
                <button key={i} disabled={!dims} onClick={() => dims && setCrop(thirdPreset(dims.width, dims.height, i))}>
                  {["左侧", "中间", "右侧"][i]} 1/3
                </button>
              ))}
            </div>
            <div className="crop-presets ratio-row">
              <span className="dim small">比例锁</span>
              {RATIO_OPTIONS.map((option) => (
                <button key={option.label} className={ratio === option.value ? "on" : ""} onClick={() => setRatio(option.value)}>{option.label}</button>
              ))}
            </div>
            <div className="crop-number-grid">
              {(["x", "y", "width", "height"] as const).map((key) => (
                <label key={key}>{({ x: "左边", y: "顶部", width: "宽度", height: "高度" })[key]} px
                  <input
                    type="number"
                    step="1"
                    value={crop ? crop[key] : ""}
                    placeholder="整图"
                    disabled={!crop}
                    onChange={(e) => updateNumber(key, Number(e.target.value))}
                  />
                </label>
              ))}
            </div>
            <p className="dim small">
              {dims ? `原图 ${dims.width}×${dims.height}` : "正在读取图片尺寸"}
              {crop ? ` · 输出 ${crop.width}×${crop.height}（${percent!.width.toFixed(1)}%×${percent!.height.toFixed(1)}%）` : " · 使用整图"}
            </p>
            <p className="dim small">空白处拖出新框 · 框内拖动平移 · 八向手柄缩放 · 方向键微调（Shift=10px）</p>
            <div className="crop-preview-card">
              <span>实际生成预览</span>
              <canvas ref={previewRef} className="crop-preview-canvas" />
            </div>
          </aside>
        </div>

        {error && <div className="warn bad">保存失败：{error}</div>}
        <div className="form-actions crop-actions">
          <button className="primary" disabled={busy || !dims} onClick={save}>{busy ? "保存中…" : crop ? "保存单人裁剪" : "使用整图作为主参考"}</button>
          {generationRef?.status === "ready" && <button className="danger" disabled={busy} onClick={async () => {
            if (!window.confirm("清除显式主参考并恢复首张原图回退？原始图片不会删除。")) return;
            setBusy(true);
            try { await api.clearCharacterGenerationReference(projectId, character.name); onSaved(); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
          }}>清除主参考</button>}
        </div>
      </div>
    </div>
  );
}
