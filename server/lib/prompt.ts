// 提示词组装：分层编译（Style Lock → 角色 → 镜头），一源多处、每镜复述。
// 参考图挑选：按 provider 参考策略组装（single-crop / multi-image / none），预算取各 provider refBudget。

import { join } from "node:path";
import { multiRefIncludedFiles, resolveCharacterGenerationReference } from "./character-refs.ts";
import { characterDir } from "./projects.ts";
import { styleRefPath } from "./styles.ts";
import type {
  CharacterDoc,
  Project,
  ProviderRefPolicy,
  Shot,
  StoryboardDoc,
  StudioConfig,
  StyleProfile,
} from "./types.ts";

function pureStyleText(source: string): string {
  return (source.match(/[^。！？!?]+[。！？!?]?/g) ?? [source])
    // Style Lock 只描述绘画语言。家庭成员、人物身份等主体设定必须由当前镜头 cast 注入。
    .filter((sentence) => !/(人物是|角色是|人物包括|characters? are|ordinary people from an ordinary .*family)/i.test(sentence))
    .map((sentence) => sentence
      .replaceAll("人物与关键道具", "主体与关键道具")
      .replace(/figures and key props/gi, "subjects and key props"))
    .join("")
    .trim();
}

function effectiveStyleLock(doc: StoryboardDoc, style: StyleProfile | null): string {
  // 画风资产的 Style Lock 必须是纯画风源；镜头变体由 shot.stylePrefix 承担。
  // 未绑定画风时兼容分镜稿 ①，但删除含具体角色名的剧情句，避免单人镜头被补入其他角色。
  const profileLock = style?.styleLock?.trim();
  if (profileLock) return pureStyleText(profileLock);
  const source = doc.styleLock?.trim() ?? "";
  const characterNames = doc.characters.map((character) => bareCharacterName(character.name)).filter(Boolean);
  return pureStyleText((source.match(/[^。！？!?]+[。！？!?]?/g) ?? [source])
    .filter((sentence) => !characterNames.some((name) => sentence.includes(name)))
    .join("")
    .trim());
}

function effectiveNegatives(doc: StoryboardDoc, style: StyleProfile | null): string {
  return doc.negatives?.trim() || style?.negatives || "";
}

function bareCharacterName(value: string): string {
  return value.trim().replace(/[（(].*$/, "").trim();
}

/**
 * 从 cast 文本解析镜头真实出现的角色。
 * `女儿（父亲虚在前景）` 必须先解析出主体女儿，再补充括号里实际可见的父亲；
 * 不能用 characters 数组顺序做一次模糊 find，否则会被括号里的“父亲”抢先命中。
 */
export function resolveShotCharacters(doc: StoryboardDoc, shot: Shot): CharacterDoc[] {
  const resolved: CharacterDoc[] = [];
  const add = (character?: CharacterDoc) => {
    if (character && !resolved.some((item) => item.name === character.name)) resolved.push(character);
  };

  for (const rawCast of shot.cast) {
    const cast = rawCast.trim();
    const primary = bareCharacterName(cast);
    add(doc.characters.find((character) => bareCharacterName(character.name) === primary));

    const mentioned = doc.characters
      .filter((character) => cast.includes(character.name) || cast.includes(bareCharacterName(character.name)))
      .sort((a, b) => cast.indexOf(bareCharacterName(a.name)) - cast.indexOf(bareCharacterName(b.name)));
    for (const character of mentioned) add(character);
  }
  return resolved;
}

/**
 * keyframe（分镜图）正向提示词。
 * plan 缺省时按旧行为（single-crop、预算 3）内联推导，保证既有调用方与测试不变；
 * 传入 assembleRefs 的计划时，参考图编号映射严格来源于计划（与实际请求携带的图一致）。
 */
export function buildKeyframePrompt(p: Project, shot: Shot, style: StyleProfile | null, plan?: RefPlan): string {
  const doc = p.doc;
  const parts: string[] = [];
  const lock = effectiveStyleLock(doc, style);
  if (lock) parts.push(lock);
  if (shot.stylePrefix) parts.push(`本镜基调：${shot.stylePrefix}`);
  if (shot.scene) parts.push(`场景：${shot.scene}`);
  const characters = resolveShotCharacters(doc, shot);
  if (characters.length > 0) {
    parts.push(`人物硬约束：画面中恰好出现 ${characters.length} 位人物，只能是 ${characters.map((character) => `「${character.name}」`).join("、")}；每个角色只出现一次，不得增加路人、分身或重复角色。`);
    const excluded = doc.characters.filter((character) => !characters.some((visible) => visible.name === character.name));
    if (excluded.length > 0) parts.push(`未出场角色硬约束：本镜不得出现 ${excluded.map((character) => `「${character.name}」`).join("、")}，包括前景、背景、倒影、照片或画外人物的实体形象。`);
    if (plan?.strategy === "multi-image") {
      parts.push("角色参考图说明：同一角色可对应多张参考图（多角度）；只提取该角色的身份、脸型、发型和服装的一致性，不复制参考图的姿势、排版或背景。画风文字只用于绘画语言，不增加人物、动作或构图元素。");
    } else {
      parts.push("角色主参考图说明：每张参考图只对应一名角色；只提取身份、脸型、发型和服装，不复制参考图的姿势、排版或背景。画风文字只用于绘画语言，不增加人物、动作或构图元素。");
    }
    const segments = plan
      ? plan.segments
      : characters
          .filter((character) => resolveCharacterGenerationReference(p, character.name))
          .slice(0, 3)
          .map((character, index) => ({ name: character.name, start: index + 1, end: index + 1 }));
    if (segments.length > 0) {
      const mapping = segments
        .map((segment) => segment.start === segment.end
          ? `Picture ${segment.start} / 图片${segment.start} = 「${segment.name}」`
          : `Picture ${segment.start}–${segment.end} / 图片${segment.start}–${segment.end} = 「${segment.name}」（同一角色多角度参考）`)
        .join("；");
      parts.push(`参考图编号与角色严格对应：${mapping}。不得交换身份、年龄或性别。`);
    }
  }
  // 出场角色的描述注入（一致性的文字兜底；图像一致性靠参考图）
  for (const character of characters) {
    parts.push(`角色「${character.name}」：${character.description.split(/\r?\n/)[0]}`);
  }
  const visualDescription = shot.description.replace(/(?:一个)?画外的?人物?/g, "镜头外不可见的方向");
  if (visualDescription !== shot.description) {
    parts.push("画外信息只表达镜内角色的视线和表演意图；听众、旁观者及任何画外人物都完全不可见，不得画入画面。");
  }
  parts.push(`画面内容：${visualDescription}`);
  parts.push("单帧静态画面，构图完整。");
  return parts.join("\n");
}

/** I2V（图生视频）提示词：首帧已锁内容，这里只描述运动与镜头 */
export function buildVideoPrompts(p: Project, shot: Shot, style: StyleProfile | null): { pos: string; neg: string } {
  const parts: string[] = [];
  if (shot.stylePrefix) parts.push(`〔${shot.stylePrefix}〕`);
  parts.push(shot.description);
  parts.push("画面主体与构图保持首帧不变，动作幅度小而连贯；镜头克制缓慢，固定或极缓推移。");
  return { pos: parts.join("\n"), neg: effectiveNegatives(p.doc, style) };
}

export function buildKeyframeNegatives(p: Project, style: StyleProfile | null, shot?: Shot): string {
  const characters = shot ? resolveShotCharacters(p.doc, shot) : [];
  const excluded = shot ? p.doc.characters.filter((character) => !characters.some((visible) => visible.name === character.name)) : [];
  const countNegative = characters.length === 1
    ? "第二个人、两人同框、多人、群像、家庭合影；second person, two people, multiple people, group portrait"
    : characters.length === 2
      ? "第三个人、三人及以上、多人、群像；third person, three or more people, group portrait"
      : "";
  return [
    effectiveNegatives(p.doc, style),
    "额外人物、无关人物、重复人物、克隆人物、同一角色出现两次、把三视图画成三个人、复制参考图人物；extra person, duplicate person, cloned character, repeated character, multiple copies of the same character",
    "听众、旁观者、画外人物实体、未指定人物；audience, bystander, visible off-screen character, unspecified person",
    excluded.length > 0 ? `本镜禁止出现：${excluded.map((character) => character.name).join("、")}` : "",
    countNegative,
  ].filter(Boolean).join("；");
}

/** 未登记 provider 的兜底策略：按最保守的单人单图 ×3 处理。 */
export function refPolicyOf(cfg: StudioConfig, provider: string): ProviderRefPolicy {
  return cfg.refPolicies[provider] ?? { refStrategy: "single-crop", refBudget: 3 };
}

/** 参考图计划里的一段连续编号：Picture start..end（1 起）对应同一角色。 */
export interface RefPlanSegment {
  name: string;
  start: number;
  end: number;
}

/** 按 provider 策略组装出的参考图计划：图 + 编号映射 + 预算裁减告警。 */
export interface RefPlan {
  strategy: ProviderRefPolicy["refStrategy"];
  refImages: string[];
  segments: RefPlanSegment[];
  warnings: string[];
}

const EMPTY_PLAN = (strategy: RefPlan["strategy"]): RefPlan => ({ strategy, refImages: [], segments: [], warnings: [] });

/** 空镜规则（各策略一致）：最多一张画风锚图；B 档（LoRA 持风格）连锚图也不补。 */
function emptyShotAnchor(p: Project, style: StyleProfile | null, plan: RefPlan, allowAnchor: boolean): RefPlan {
  if (style && allowAnchor) {
    for (const f of p.styleRefPicks) {
      if (style.refs.includes(f)) {
        plan.refImages.push(styleRefPath(style.id, f));
        break;
      }
    }
  }
  return plan;
}

/**
 * 按当前 keyframe provider 的参考策略组装参考图计划。
 * - single-crop：每出场角色一张单人主参考（显式裁剪件优先、否则回退源图首图）。
 * - multi-image：每出场角色取多图直喂集（默认全选 − excluded），**双集严格独立**：
 *   单人单图集的裁剪件绝不注入多图集（全排除 = 该角色明确不带参考）；预算不足先每角色
 *   保底一张（集内首图），再按角色轮转补齐；产出按角色分组的连续编号段。
 * - none：不携带任何参考。
 * 预算裁减一律产出点名角色的 warnings，由调用方挂到 job 上，不静默。
 */
export function assembleRefs(
  p: Project,
  shot: Shot,
  style: StyleProfile | null,
  cfg: StudioConfig,
  provider: string,
): RefPlan {
  const policy = refPolicyOf(cfg, provider);
  if (policy.refStrategy === "none" || policy.refBudget <= 0) return EMPTY_PLAN(policy.refStrategy);

  const plan = EMPTY_PLAN(policy.refStrategy);
  const characters = resolveShotCharacters(p.doc, shot);
  const allowAnchor = provider !== "comfyui-image2";

  if (characters.length === 0) return emptyShotAnchor(p, style, plan, allowAnchor);

  if (policy.refStrategy === "single-crop") {
    // Qwen-Image-Edit 会把参考图中的人物当作可编辑内容。只要镜头已有明确角色，
    // 就不再拿含人物的画风锚图补空槽；画风由 Style Lock（或 B 档 LoRA）承担。
    for (const character of characters) {
      const ref = resolveCharacterGenerationReference(p, character.name);
      if (!ref) continue;
      if (plan.refImages.length >= policy.refBudget) {
        plan.warnings.push(`参考预算不足（${provider} 预算 ${policy.refBudget}）：角色「${character.name}」未携带参考图`);
        continue;
      }
      plan.refImages.push(ref);
      plan.segments.push({ name: character.name, start: plan.refImages.length, end: plan.refImages.length });
    }
    return plan;
  }

  // multi-image：候选 = 多图集入选源图，与单人单图集严格独立（不注入裁剪件；全排除 = 零候选）
  const perCharacter = characters.map((character) => {
    const candidates = multiRefIncludedFiles(p, character.name)
      .map((file) => join(characterDir(p.id, character.name), file));
    return { name: character.name, candidates, picked: [] as string[] };
  });

  let budget = policy.refBudget;
  // 保底：每个有候选的角色先占一张
  for (const entry of perCharacter) {
    if (entry.candidates.length === 0) continue;
    if (budget <= 0) {
      plan.warnings.push(`参考预算不足（${provider} 预算 ${policy.refBudget}）：角色「${entry.name}」未携带任何参考图`);
      continue;
    }
    entry.picked.push(entry.candidates[0]);
    budget -= 1;
  }
  // 轮转补齐：按角色顺序循环，每轮每角色补一张，直到预算耗尽或全部取完
  let progressed = true;
  while (budget > 0 && progressed) {
    progressed = false;
    for (const entry of perCharacter) {
      if (budget <= 0) break;
      const next = entry.candidates[entry.picked.length];
      if (!next) continue;
      entry.picked.push(next);
      budget -= 1;
      progressed = true;
    }
  }
  for (const entry of perCharacter) {
    if (entry.picked.length > 0 && entry.picked.length < entry.candidates.length) {
      plan.warnings.push(
        `参考预算不足（${provider} 预算 ${policy.refBudget}）：角色「${entry.name}」入选 ${entry.candidates.length} 张，仅携带 ${entry.picked.length} 张`,
      );
    }
  }
  // 按角色分组展开为连续编号段
  for (const entry of perCharacter) {
    if (entry.picked.length === 0) continue;
    const start = plan.refImages.length + 1;
    plan.refImages.push(...entry.picked);
    plan.segments.push({ name: entry.name, start, end: plan.refImages.length });
  }
  return plan;
}

/**
 * 兼容入口（既有测试与旧调用方）：single-crop 行为，预算取 comfyui-image 策略（3）；
 * includeStyleRefs=false 即 B 档语义（空镜不补锚图）。新代码请直接用 assembleRefs。
 */
export function pickRefs(p: Project, shot: Shot, style: StyleProfile | null, cfg: StudioConfig, includeStyleRefs = true): string[] {
  return assembleRefs(p, shot, style, cfg, includeStyleRefs ? "comfyui-image" : "comfyui-image2").refImages;
}

/** Wan 系帧数量化：4n+1 */
export function wanFrames(durationSec: number, fps: number): number {
  const raw = Math.max(1, Math.round(durationSec * fps));
  const n = Math.max(1, Math.round((raw - 1) / 4));
  return n * 4 + 1;
}
