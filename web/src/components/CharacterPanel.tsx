import { useState } from "react";
import { api } from "../api.ts";
import { characterAssetUrl, CropperModal } from "./CropperModal.tsx";

type RefPolicy = { refStrategy: "single-crop" | "multi-image" | "none"; refBudget: number };

/** 健康接口没回 refPolicies 时的兜底（与服务端 refPolicyOf/DEFAULT_CONFIG 对齐） */
const FALLBACK_POLICIES: Record<string, RefPolicy> = {
  "comfyui-image": { refStrategy: "single-crop", refBudget: 3 },
  "comfyui-image2": { refStrategy: "single-crop", refBudget: 3 },
  "seedream-image": { refStrategy: "multi-image", refBudget: 10 },
  "mock-image": { refStrategy: "none", refBudget: 0 },
};

export function refPolicyFor(kfProvider: string, refPolicies: Record<string, RefPolicy> | undefined): RefPolicy {
  return refPolicies?.[kfProvider] ?? FALLBACK_POLICIES[kfProvider] ?? { refStrategy: "single-crop", refBudget: 3 };
}

export function strategyBadgeText(policy: RefPolicy): string {
  if (policy.refStrategy === "none") return "本工作流不消费参考图";
  if (policy.refStrategy === "multi-image") return `本工作流：每角色多图直喂 · 总预算 ${policy.refBudget}`;
  return `本工作流：每角色单人 1 图 · 总预算 ${policy.refBudget}`;
}

/**
 * 角色资产区：共享源图 + 双参考集，随当前 keyframe provider 的参考策略切换视图。
 * single-crop → 单人单图集（裁剪主参考）；multi-image → 多图勾选墙（默认全选 − excluded）；none → 空态提示。
 */
export function CharacterPanel({
  p,
  kfProvider,
  refPolicies,
  onChanged,
}: {
  p: any;
  kfProvider: string;
  refPolicies: Record<string, RefPolicy> | undefined;
  // 返回 Promise：勾选墙的整表提交必须等刷新落地才解锁下一次点击，否则陈旧基线会丢更新
  onChanged: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState<{ character: any; source: string } | null>(null);
  const policy = refPolicyFor(kfProvider, refPolicies);
  if (!p.doc.characters.length) return null;

  const removeSource = async (character: any, file: string) => {
    if (!window.confirm(`永久删除源图「${file}」？该图会同时从两个参考集的可选范围消失。`)) return;
    try {
      await api.deleteCharRef(p.id, character.name, file);
      onChanged();
    } catch (error) {
      window.alert(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <>
      <div className={`strategy-banner strategy-${policy.refStrategy}`}>
        <span className="strategy-badge">{strategyBadgeText(policy)}</span>
        <span className="dim small">
          {policy.refStrategy === "single-crop" && "本地出图每角色只送一张裁好的单人图；点源图可打开裁剪画布。"}
          {policy.refStrategy === "multi-image" && "Seedream 直接吃多张源图（三视图/神态图）；默认全选，点图可排除。单人单图集互不影响。"}
          {policy.refStrategy === "none" && "当前引擎（mock）不携带任何参考图，这里的配置不影响本引擎出图，可先维护资产。"}
        </span>
      </div>
      <div className="char-strip">
        {p.doc.characters.map((c: any) => (
          <CharacterCard
            key={c.name}
            p={p}
            character={c}
            strategy={policy.refStrategy}
            onEdit={(source) => setEditing({ character: c, source })}
            onRemoveSource={(file) => removeSource(c, file)}
            onChanged={onChanged}
          />
        ))}
      </div>
      {editing && (
        <CropperModal
          projectId={p.id}
          character={editing.character}
          initialSource={editing.source}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
    </>
  );
}

function CharacterCard({
  p,
  character: c,
  strategy,
  onEdit,
  onRemoveSource,
  onChanged,
}: {
  p: any;
  character: any;
  strategy: RefPolicy["refStrategy"];
  onEdit: (source: string) => void;
  onRemoveSource: (file: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const generationRef = c.generationRef ?? { status: c.refs.length ? "fallback" : "missing" };
  const multiRef = c.multiRef ?? { status: c.refs.length ? "fallback" : "missing", included: c.refs, excluded: [] };
  const generationUrl = generationRef.file ? characterAssetUrl(p.id, c, generationRef.file) : "";

  const toggleExclusion = async (file: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const excluded: string[] = multiRef.excluded.includes(file)
        ? multiRef.excluded.filter((item: string) => item !== file)
        : [...multiRef.excluded, file];
      await api.setMultiRefExclusions(p.id, c.name, excluded);
      // 等父级刷新落地再解锁：整表提交基于 prop 基线，提前解锁会让连续点选用陈旧基线互相覆盖
      await onChanged();
    } catch (error) {
      window.alert(`更新失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="char-card">
      <div className="char-head">
        <div><b>{c.name}</b><span>{c.refs.length} 张源图（两集共享）</span></div>
        <label className="upload-btn">
          ＋ 上传
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={async (e) => {
              if (e.target.files?.length) {
                try {
                  await api.uploadCharRefs(p.id, c.name, e.target.files);
                  onChanged();
                } catch (error) {
                  window.alert(`上传失败：${error instanceof Error ? error.message : String(error)}`);
                }
              }
              // 清空 value：否则二次选同一文件不触发 onChange，重传链路静默断
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {strategy === "single-crop" && (
        <div className={`generation-ref-summary ${generationRef.status}`}>
          {generationUrl ? <img src={generationUrl} alt={`${c.name}生成主参考`} /> : <div className="generation-ref-empty">?</div>}
          <div>
            <span className={`generation-status ${generationRef.status}`}>
              {generationRef.status === "ready" ? "已配置单人主参考" : generationRef.status === "fallback" ? "正在回退原图" : "缺少角色参考图"}
            </span>
            <small>
              {generationRef.status === "ready"
                ? generationRef.crop ? "生成时使用裁剪副本，原图保持不变" : "生成时使用所选整图"
                : generationRef.status === "fallback" ? "三视图可能被模型复制为多个人" : "本地出图只能依赖文字描述"}
            </small>
          </div>
          <button
            className="mini"
            disabled={c.refs.length === 0}
            onClick={() => onEdit(generationRef.source && c.refs.includes(generationRef.source) ? generationRef.source : c.refs[0])}
          >编辑主参考</button>
        </div>
      )}

      {strategy === "multi-image" && (
        <div className={`generation-ref-summary multi ${multiRef.status}`}>
          <div>
            <span className={`generation-status ${multiRef.status === "missing" ? "missing" : "ready"}`}>
              {multiRef.status === "missing" ? "缺少角色参考图" : `直喂 ${multiRef.included.length} 张（${multiRef.status === "ready" ? "已自定义" : "默认全选"}）`}
            </span>
            <small>
              {multiRef.status === "missing"
                ? "上传三视图/神态图后自动全部入选"
                : multiRef.included.length === 0
                  ? "⚠ 所有源图都被排除，该角色将不携带任何参考图"
                  : "新上传的源图会自动纳入；点图排除/恢复"}
            </small>
          </div>
          {multiRef.status === "ready" && (
            <button className="mini" disabled={busy} onClick={async () => {
              setBusy(true);
              try { await api.clearMultiRefConfig(p.id, c.name); await onChanged(); }
              catch (error) { window.alert(`恢复失败：${error instanceof Error ? error.message : String(error)}`); }
              finally { setBusy(false); }
            }}>恢复默认全选</button>
          )}
        </div>
      )}

      <div className="char-refs">
        {c.refs.length === 0 && <span className="dim small">（暂无源图）</span>}
        {c.refs.map((f: string) => {
          const excluded = strategy === "multi-image" && multiRef.excluded.includes(f);
          return (
            <div key={f} className={`char-ref-tile ${excluded ? "excluded" : ""} ${strategy === "single-crop" && generationRef.source === f ? "source-on" : ""}`}>
              <button
                type="button"
                className="char-ref-source"
                title={strategy === "multi-image" ? `${f} · 点击${excluded ? "恢复入选" : "排除"}` : `${f} · 点击打开裁剪画布`}
                onClick={() => (strategy === "multi-image" ? toggleExclusion(f) : onEdit(f))}
              >
                <img src={characterAssetUrl(p.id, c, f)} alt={f} />
                {strategy === "single-crop" && generationRef.source === f && <span>主参考来源</span>}
                {excluded && <span className="excluded-tag">已排除</span>}
              </button>
              <div className="tile-actions">
                {strategy === "multi-image" && (
                  <button className="tile-btn" title="从这张裁一张进单人单图集" onClick={() => onEdit(f)}>✂</button>
                )}
                <button className="tile-btn danger" title="永久删除源图" onClick={() => onRemoveSource(f)}>×</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="char-desc">{c.description.split("\n")[0]}</div>
    </div>
  );
}
