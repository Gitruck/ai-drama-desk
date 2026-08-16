// gtrk-ai-drama 分镜稿（Markdown）→ StoryboardDoc 解析器
// 契约：cli/skills/gtrk-ai-drama/SKILL.md「输出契约」节。
// 设计取向：容错优先——真实产物在标题层级/全半角/空格上有变体，
// 解析尽力而为，解析不出的字段留空、由工作台 UI 手工补齐（skill 也可直接投喂 shots.json 跳过本解析器）。

import type { CharacterDoc, Shot, StoryboardDoc } from "./types.ts";

const CN_BLOCK = /##\s*一、中文稿|中文稿（喂/;
const EN_BLOCK = /##\s*二、English Storyboard|English Storyboard/i;

/**
 * 剥 Markdown 强调符号。真实产物的元信息键名与角色头普遍带 `**`（金样 b17.md 没有），
 * 键名匹配前不剥就全线对不上。只用于**键名匹配与角色名提取**——描述正文原样保留，
 * 加粗是作者的语义，下游要拿去喂平台。
 */
function stripEmphasis(s: string): string {
  return s.replace(/(\*\*|__|\*|`)/g, "").trim();
}

/** 段落标记：①…⑤（可带 ### 前缀与「视觉基调」等标题文字） */
function sectionMarker(line: string): 1 | 2 | 3 | 4 | 5 | null {
  const m = line.match(/^#{0,6}\s*([①②③④⑤])/);
  if (!m) return null;
  return (["①", "②", "③", "④", "⑤"].indexOf(m[1]) + 1) as 1 | 2 | 3 | 4 | 5;
}

function toNumber(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/，/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** 分镜头行：`#### 分镜 01 · 标题 ｜建议 ≈5s ｜段：… ｜场景：… ｜角色：… ｜对应原文：…` */
const SHOT_HEAD = /^#{0,6}\s*分镜\s*(\d+)\s*[·•．.]?\s*(.*)$/;
const SHOT_HEAD_EN = /^#{0,6}\s*Shot\s*(\d+)\s*[·•．.]?\s*(.*)$/i;

interface ShotHeadFields {
  title: string;
  durationSec: number | null;
  segment?: string;
  scene?: string;
  cast: string[];
  sourceLines?: string;
}

const FIELD_HEAD = /^(建议|≈|~|约|段|场景|角色|对应原文|segment|scene|cast|source lines?)\s*[:：]?/i;

function parseShotHeadRest(rest: string, en = false): ShotHeadFields {
  const parts = rest.split(/[｜|]/).map((p) => p.trim()).filter(Boolean);
  // 首段若本身就是字段（分镜头行省略了「· 标题」），别把它吞成标题
  const firstIsField = parts.length > 0 && FIELD_HEAD.test(parts[0]);
  const out: ShotHeadFields = { title: firstIsField ? "" : (parts[0] ?? ""), durationSec: null, cast: [] };
  for (const p of parts.slice(firstIsField ? 0 : 1)) {
    if (/^(建议|≈|~|约)/.test(p) || /^≈?\s*\d+(\.\d+)?\s*s/i.test(p)) {
      out.durationSec = toNumber(p);
    } else if (/^(段|segment)\s*[:：]/i.test(p)) {
      out.segment = p.replace(/^(段|segment)\s*[:：]\s*/i, "");
    } else if (/^(场景|scene)\s*[:：]/i.test(p)) {
      out.scene = p.replace(/^(场景|scene)\s*[:：]\s*/i, "");
    } else if (/^(角色|cast)\s*[:：]/i.test(p)) {
      const raw = p.replace(/^(角色|cast)\s*[:：]\s*/i, "");
      out.cast = raw
        .split(en ? /,/ : /[、，,]/)
        .map((c) => c.trim())
        .filter(Boolean);
    } else if (/^(对应原文|source lines?)\s*[:：]/i.test(p)) {
      out.sourceLines = p.replace(/^(对应原文|source lines?)\s*[:：]\s*/i, "");
    }
  }
  return out;
}

/** 把 ④ 区块文本解析成 Shot[]（中/英通用） */
function parseShots(block: string, en = false): Shot[] {
  const lines = block.split(/\r?\n/);
  const shots: Shot[] = [];
  let cur: Shot | null = null;
  let buf: string[] = [];
  const headRe = en ? SHOT_HEAD_EN : SHOT_HEAD;

  const flush = () => {
    if (!cur) return;
    let desc = buf.join("\n").trim();
    // 抽取行首〔视觉基调前缀〕
    const pm = desc.match(/^〔([^〕]*)〕\s*/);
    if (pm) {
      cur.stylePrefix = pm[1].trim();
      desc = desc.slice(pm[0].length).trim();
    }
    cur.description = desc;
    shots.push(cur);
    cur = null;
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(headRe);
    if (m) {
      flush();
      const fields = parseShotHeadRest(m[2] ?? "", en);
      cur = {
        index: parseInt(m[1], 10),
        title: fields.title,
        durationSec: fields.durationSec,
        segment: fields.segment,
        scene: fields.scene,
        cast: fields.cast,
        sourceLines: fields.sourceLines,
        description: "",
      };
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return shots;
}

/**
 * 角色名 = 剥强调后、首个中英文左括号之前的部分。
 * 括注是「B10 / B20 已建 · 同一张脸」这类溯源说明，不进名字；
 * `成年·林` 的间隔号不是截断点，必须留在名字里。
 */
function characterName(headingText: string): string {
  const head = stripEmphasis(headingText.split(/[（(]/)[0]);
  return head || stripEmphasis(headingText);
}

/** ③ 角色区块 → CharacterDoc[]：标题行一律是角色头；无标题稿件退回「名字（备注）」短行 */
function parseCharacters(block: string): CharacterDoc[] {
  const lines = block.split(/\r?\n/);
  const chars: CharacterDoc[] = [];
  let cur: CharacterDoc | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (!cur) return;
    cur.description = buf.join("\n").trim();
    chars.push(cur);
    cur = null;
    buf = [];
  };
  for (const line of lines) {
    const isHeading = /^#{3,6}\s/.test(line.trim());
    const t = line.replace(/^#{1,6}\s*/, "").trim();
    // ③ 区块内的标题行一律是角色头，不设长度上限——真实角色头带长括注，
    // 卡长度会让整个角色连同描述被吞进上一个角色的正文里（B10/B20 丢主角的原因）。
    if (isHeading && t.length > 0) {
      flush();
      cur = { name: characterName(t), description: "", refs: [] };
      continue;
    }
    // 不带 #### 前缀的稿件兜底：短行「名字（备注）」。这里放开长度会把正文误判成角色头。
    const m = t.match(/^(\S[^（(]{0,20})[（(]([^）)]*)[）)]$/);
    if (m && t.length <= 30) {
      flush();
      cur = { name: characterName(t), description: "", refs: [] };
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return chars;
}

/** ① 区块 → styleLock 正文 + 禁忌行 */
function parseStyleSection(block: string): { styleLock: string; negatives?: string } {
  const lines = block.split(/\r?\n/).map((l) => l.replace(/^>\s?/, ""));
  const negIdx = lines.findIndex((l) => /^(禁忌|Avoid)\s*[:：]/i.test(l.trim()));
  let negatives: string | undefined;
  let body: string[];
  if (negIdx >= 0) {
    negatives = lines
      .slice(negIdx)
      .join("\n")
      .replace(/^(禁忌|Avoid)\s*[:：]\s*/i, "")
      .trim();
    body = lines.slice(0, negIdx);
  } else {
    body = lines;
  }
  // 去掉「权威源，供各分镜前缀复述。来源：…」一类引导行
  const styleLock = body
    .filter((l) => !/^(权威源|Authoritative source)/.test(l.trim()))
    .join("\n")
    .trim();
  return { styleLock, negatives };
}

/** 元信息扫描（不依赖列表符号，全稿逐行匹配；键名先剥强调符号） */
function parseMeta(text: string, doc: StoryboardDoc) {
  for (const raw of text.split(/\r?\n/)) {
    const line = stripEmphasis(raw.replace(/^[-*]\s*/, ""));
    let m: RegExpMatchArray | null;
    // 两种键名：现行契约的「区间总时长：a → b ≈ c 秒」，与早期产物的「区间：a → b，总时长 ≈ c 秒」
    if ((m = line.match(/^区间(?:总时长)?\s*[:：](.*)$/)) || (m = line.match(/区间总时长\s*[:：](.*)$/))) {
      const nums = (m[1].match(/\d+(?:\.\d+)?/g) ?? []).map(parseFloat);
      // 形如 track_st 294.965 → track_ed 331.835 ≈ 36.9 秒
      if (nums.length >= 3) {
        doc.trackSt = nums[0];
        doc.trackEd = nums[1];
        doc.totalSec = nums[2];
      } else if (nums.length >= 1) {
        doc.totalSec = nums[nums.length - 1];
      }
    } else if ((m = line.match(/建议分镜数\s*[:：]\s*(\d+)/))) {
      doc.suggestedShots = parseInt(m[1], 10);
    } else if ((m = line.match(/^(?:风格参考图|建议参考图).*[:：](.*)$/))) {
      // 真实产物用的是「建议参考图」，两种键名等价
      doc.refHints = m[1].trim();
    }
  }
}

export function parseStoryboard(md: string): StoryboardDoc {
  const doc: StoryboardDoc = { beatId: "", characters: [], shots: [] };

  // 标题与 beat id
  const titleM = md.match(/^#\s*(.+?)\s*$/m);
  if (titleM) {
    doc.title = titleM[1].replace(/[（(]\s*beat\s+[^）)]+[）)]/i, "").trim();
  }
  const beatM = md.match(/[（(]\s*beat\s+([A-Za-z0-9_-]+)\s*[）)]/i);
  if (beatM) doc.beatId = beatM[1];

  parseMeta(md, doc);

  // 切中英两大块
  const enM = md.match(EN_BLOCK);
  const cnEnd = enM ? md.indexOf(enM[0]) : md.length;
  const cnStartM = md.match(CN_BLOCK);
  const cnStart = cnStartM ? md.indexOf(cnStartM[0]) : 0;
  const cnText = md.slice(cnStart, cnEnd);
  const enText = enM ? md.slice(cnEnd) : "";

  // 中文块按 ①–⑤ 切段
  const cnLines = cnText.split(/\r?\n/);
  const sections: Record<number, string[]> = {};
  let curSec: number | null = null;
  for (const line of cnLines) {
    const s = sectionMarker(line);
    if (s) {
      curSec = s;
      sections[s] = [];
      continue;
    }
    // 分隔线不入正文
    if (/^={5,}$/.test(line.trim())) continue;
    if (curSec) sections[curSec].push(line);
  }

  if (sections[1]) {
    const { styleLock, negatives } = parseStyleSection(sections[1].join("\n"));
    doc.styleLock = styleLock;
    doc.negatives = negatives;
  }
  if (sections[2]) doc.background = sections[2].join("\n").trim();
  if (sections[3]) doc.characters = parseCharacters(sections[3].join("\n"));
  if (sections[4]) doc.shots = parseShots(sections[4].join("\n"));
  if (sections[5]) doc.sourceText = sections[5].join("\n").trim();

  // 英文块：① Style Lock + ④ Shots（按 index 回填）
  if (enText) {
    const enLines = enText.split(/\r?\n/);
    const enSections: Record<number, string[]> = {};
    let cur: number | null = null;
    for (const line of enLines) {
      const s = sectionMarker(line);
      if (s) {
        cur = s;
        enSections[s] = [];
        continue;
      }
      if (/^={5,}$/.test(line.trim())) continue;
      if (cur) enSections[cur].push(line);
    }
    if (enSections[1]) {
      const { styleLock, negatives } = parseStyleSection(enSections[1].join("\n"));
      doc.styleLockEn = styleLock;
      doc.negativesEn = negatives;
    }
    const enShots = enSections[4] ? parseShots(enSections[4].join("\n"), true) : [];
    for (const es of enShots) {
      const target = doc.shots.find((s) => s.index === es.index);
      if (target) target.descriptionEn = (es.stylePrefix ? `〔${es.stylePrefix}〕` : "") + es.description;
    }
  }

  return doc;
}

/** cast 空值词：这些不是角色，不该触发缺失告警 */
const EMPTY_CAST = new Set(["无人", "无", "空镜", "无角色", "不适用", "none", "n/a", "na", "-", "—", "–"]);

/** 角色名归一（比对用）：剥强调 + 截到首个左括号，让「女儿（父亲虚在前景）」对上「女儿」 */
function castKey(value: string): string {
  return characterName(value);
}

/** 校验解析结果是否够用（工作台导入时给出提示） */
export function validateDoc(doc: StoryboardDoc): string[] {
  const warnings: string[] = [];
  if (!doc.beatId) warnings.push("未解析到 beat id（标题里应有「（beat BXX）」），导出命名将用 b00");
  if (doc.shots.length === 0) warnings.push("未解析到任何分镜（④ 区块），请检查分镜稿格式或手工投喂 shots.json");
  if (!doc.styleLock) warnings.push("未解析到 ① 视觉基调");
  if (doc.characters.length === 0) warnings.push("未解析到 ③ 角色描述");
  // 交叉校验：只报「角色数为 0」会让部分丢失静默通过——丢的偏偏常是主角，
  // 主角没有角色条目就拿不到参考图，跨镜跨集的脸会一路漂而没人察觉。
  const defined = new Set(doc.characters.map((c) => castKey(c.name)));
  const missing: string[] = [];
  for (const shot of doc.shots) {
    for (const raw of shot.cast) {
      const name = castKey(raw);
      if (!name || EMPTY_CAST.has(name.toLowerCase())) continue;
      if (defined.has(name) || missing.includes(name)) continue;
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    warnings.push(`④ 分镜里出现但 ③ 未定义的角色：${missing.join("、")}（这些角色拿不到参考图，一致性会漂）`);
  }
  const noDur = doc.shots.filter((s) => s.durationSec == null).length;
  if (noDur > 0) warnings.push(`${noDur} 个分镜缺建议秒数，将用默认秒数兜底`);
  return warnings;
}
