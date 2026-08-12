// gitruck-ai-drama-desk 核心数据类型
// 契约对齐：gtrk-ai-drama 分镜稿输出契约（cli/skills/gtrk-ai-drama/SKILL.md）
// 与 07 号调研起草的 return-v1 命名约定（<slug>-<beatId>-s<n>.mp4）

import type { StyleProfileContract } from "../../shared/contracts/index.ts";

/** 画风资产档案；共享契约是 UI、CLI 和服务端的共同边界。 */
export type StyleProfile = StyleProfileContract;

/** 分镜（Shot IR）——从分镜稿 ④ 区块解析或手工编辑 */
export interface Shot {
  /** 1-based 序号 */
  index: number;
  title: string;
  /** 建议秒数（意图值） */
  durationSec: number | null;
  /** 蒙太奇段名 */
  segment?: string;
  scene?: string;
  cast: string[];
  /** 对应原文句 */
  sourceLines?: string;
  /** 〔视觉基调前缀〕 */
  stylePrefix?: string;
  /** 镜头正文描述（中文） */
  description: string;
  /** 英文镜头描述（若分镜稿含 English Storyboard 块） */
  descriptionEn?: string;
}

export interface CharacterDoc {
  name: string;
  /** ③ 角色描述原文（含禁变项） */
  description: string;
  /** 角色参考图（项目内相对路径 characters/<name>/*.png） */
  refs: string[];
}

export interface ImageCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 角色资产原图之外，实际送入图像模型的单人主参考。 */
export interface CharacterGenerationReference {
  /** 角色目录根部的原始上传文件名。 */
  source: string;
  /** 角色目录内相对路径；整图时等于 source，裁剪时位于 generation/。 */
  file: string;
  crop?: ImageCropRect;
  updatedAt: number;
}

export interface CharacterGenerationReferenceView extends CharacterGenerationReference {
  status: "ready" | "fallback";
}

/** 多图直喂集的角色级配置：记「排除项」——无记录 = 默认全选，新上传自动纳入。 */
export interface CharacterMultiRefConfig {
  excluded: string[];
  updatedAt: number;
}

/** 共享源图上的双参考集：single 供 single-crop 策略（承接旧结构），multi 供 multi-image 策略。 */
export interface CharacterRefSets {
  single: Record<string, CharacterGenerationReference>;
  multi: Record<string, CharacterMultiRefConfig>;
}

/** 多图直喂集视图：ready=有显式记录；fallback=无记录默认全选；missing=源图目录为空。 */
export interface CharacterMultiRefView {
  status: "ready" | "fallback" | "missing";
  /** 入选源图（目录字典序，全选 − excluded） */
  included: string[];
  excluded: string[];
  updatedAt?: number;
}

/** 解析后的分镜稿（一 beat 一份） */
export interface StoryboardDoc {
  beatId: string;
  title?: string;
  trackSt?: number;
  trackEd?: number;
  totalSec?: number;
  suggestedShots?: number;
  /** ① 视觉基调（权威源） */
  styleLock?: string;
  styleLockEn?: string;
  negatives?: string;
  negativesEn?: string;
  /** ② 故事背景 */
  background?: string;
  characters: CharacterDoc[];
  shots: Shot[];
  /** ⑤ 原文文稿 */
  sourceText?: string;
  /** 元信息里的风格参考图建议原文 */
  refHints?: string;
}

export type JobKind = "keyframe" | "video" | "charref";
export type JobStatus = "queued" | "running" | "done" | "error";
export type CharRefMode = "single" | "turnaround";

export interface GenJob {
  id: string;
  projectId: string;
  shotIndex: number;
  kind: JobKind;
  provider: string;
  status: JobStatus;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 产物文件（项目内相对路径） */
  output?: string;
  /** 全自动模式：keyframe 完成后接力生成视频所用的 provider */
  chainVideoProvider?: string;
  /** 参考预算不足等非致命告警（点名被裁减参考的角色），前端沿现有 jobs 链路展示 */
  warnings?: string[];
  /** charref 任务：目标角色名（shotIndex 置 0 哨兵） */
  charName?: string;
  /** charref 任务：single=单人立绘 / turnaround=三视图设定表 */
  charRefMode?: CharRefMode;
  /** charref 任务：追加到角色权威描述的补充说明（可空） */
  charRefDesc?: string;
}

export interface CostEntry {
  at: number;
  provider: string;
  kind: JobKind;
  shotIndex: number;
  cost: number;
}

/** 每镜的生成状态（产物按目录扫描，choices 落 project.json） */
export interface ShotChoices {
  /** 选中的 keyframe（keyframes/sNN/ 下文件名） */
  keyframe?: string;
  /** 选中的视频（videos/sNN/ 下文件名） */
  video?: string;
}

export interface Project {
  id: string;
  name: string;
  /** 导出命名用 slug（默认 = id） */
  slug: string;
  styleId?: string;
  /** 从画风档案里挑选参与生成的锚图（refs/ 文件名），上限受各 provider refBudget 约束 */
  styleRefPicks: string[];
  /** 旧字段：以角色原名为键的单人主参考；读时懒迁移进 characterRefSets.single，写回后保留原样（可回滚）。 */
  characterGenerationRefs?: Record<string, CharacterGenerationReference>;
  /** 新结构：共享源图上的双参考集；缺省时由旧 characterGenerationRefs 懒迁移。 */
  characterRefSets?: CharacterRefSets;
  doc: StoryboardDoc;
  choices: Record<string, ShotChoices>;
  costLedger: CostEntry[];
  createdAt: number;
  updatedAt: number;
}

/** ComfyUI workflow 模板的节点映射（照抄 AI-storyboard-generator 的可配置节点 ID 范式） */
export interface ComfyNodeMap {
  /** 正向提示词写入节点：{ nodeId, 输入字段名 }（如 CLIPTextEncode 的 text） */
  prompt: { id: string; field: string };
  negative?: { id: string; field: string };
  /** 参考图 LoadImage 节点列表，按序喂 refs（Qwen-Image-Edit-2511 支持 1-3 张） */
  imageInputs?: { id: string; field: string }[];
  /** 首帧 LoadImage（视频 workflow 用） */
  startImage?: { id: string; field: string };
  seed?: { id: string; field: string };
  width?: { id: string; field: string };
  height?: { id: string; field: string };
  /** LoRA 模板可由项目所选画风动态覆盖的权重与强度节点。 */
  loraName?: { id: string; field: string };
  loraStrength?: { id: string; field: string };
  /** 时长（帧数）节点（视频 workflow 用，Wan 系 4n+1 帧） */
  frames?: { id: string; field: string };
}

export interface ComfyWorkflowConfig {
  /** templates/ 下的 workflow JSON（ComfyUI「保存 API 格式」导出） */
  template: string;
  /** 该 workflow 固定需要的正向提示前缀，例如风格 LoRA 触发词。 */
  promptPrefix?: string;
  nodeMap: ComfyNodeMap;
}

/** keyframe provider 的参考策略：single-crop=每角色单人裁剪主参考；multi-image=多图直喂；none=不消费参考。 */
export type RefStrategy = "single-crop" | "multi-image" | "none";

export interface ProviderRefPolicy {
  refStrategy: RefStrategy;
  /** 该 provider 单次请求可携带的参考图总数上限（Qwen A/B=3、Seedream 5.0 Pro=10、mock=0） */
  refBudget: number;
}

export interface StudioConfig {
  port: number;
  comfyUrl: string;
  /** 图像/视频两类 workflow 模板配置 */
  comfyImage?: ComfyWorkflowConfig;
  /** 第二图像模板槽（如 风格 LoRA 版），UI 里显示为「本地 ComfyUI · B」做 A/B 对比 */
  comfyImage2?: ComfyWorkflowConfig;
  comfyVideo?: ComfyWorkflowConfig;
  /** 混元 1.5 I2V 视频模板槽（480p 步数蒸馏），与 Wan 做对比 */
  comfyVideoHunyuan?: ComfyWorkflowConfig;
  /** MiniMax H3 I2V 视频模板槽（4 步 Turbo，出片自带原生 32kHz 立体声） */
  comfyVideoH3?: ComfyWorkflowConfig;
  falKey?: string;
  /** 火山方舟 API Key（Seedream 图像出口） */
  arkApiKey?: string;
  /** 方舟 Seedream 模型 ID */
  seedreamModel: string;
  /** Seedream 出图尺寸 */
  seedreamSize: string;
  /** fal 模型端点，如 fal-ai/wan/v2.2-a14b/image-to-video */
  falVideoModel: string;
  /** 生成分辨率（本地 540p 抽卡档） */
  videoWidth: number;
  videoHeight: number;
  videoFps: number;
  keyframeWidth: number;
  keyframeHeight: number;
  /** 每 keyframe provider 的参考策略与预算（退役旧全局 maxRefs 单值） */
  refPolicies: Record<string, ProviderRefPolicy>;
  /** 每 provider 单条成本（元），进成本台账 */
  prices: Record<string, number>;
  /** 单镜默认视频秒数兜底（分镜稿无建议秒数时） */
  defaultShotSec: number;
  /**
   * 导出回轨包时是否保留片段自带音轨。默认 false（剥离）。
   * H3 出片必带原生立体声（音频与画面在同一次去噪里联合生成，关不掉），
   * 垫在口播下面会叠声；剥离走 ffmpeg 流拷贝，不重编码、不动画面。
   * 生成阶段永远保留音轨，改这个开关无需重新出片，重导即可。
   */
  exportKeepAudio: boolean;
}

export const DEFAULT_CONFIG: StudioConfig = {
  port: 7799,
  comfyUrl: "http://127.0.0.1:8188",
  comfyImage: {
    template: "qwen-edit-keyframe.json",
    nodeMap: {
      prompt: { id: "6", field: "prompt" },
      negative: { id: "7", field: "prompt" },
      imageInputs: [{ id: "10", field: "image" }, { id: "11", field: "image" }, { id: "12", field: "image" }],
      seed: { id: "15", field: "seed" },
      width: { id: "14", field: "width" },
      height: { id: "14", field: "height" },
    },
  },
  comfyImage2: {
    template: "qwen-edit-keyframe-lora.json",
    promptPrefix: "example style",
    nodeMap: {
      prompt: { id: "6", field: "prompt" },
      negative: { id: "7", field: "prompt" },
      imageInputs: [{ id: "10", field: "image" }, { id: "11", field: "image" }, { id: "12", field: "image" }],
      seed: { id: "15", field: "seed" },
      width: { id: "14", field: "width" },
      height: { id: "14", field: "height" },
      loraName: { id: "18", field: "lora_name" },
      loraStrength: { id: "18", field: "strength_model" },
    },
  },
  comfyVideo: {
    template: "wan22-i2v-540p.json",
    nodeMap: {
      prompt: { id: "6", field: "text" },
      negative: { id: "7", field: "text" },
      startImage: { id: "71", field: "image" },
      seed: { id: "57", field: "noise_seed" },
      width: { id: "73", field: "width" },
      height: { id: "73", field: "height" },
      frames: { id: "73", field: "length" },
    },
  },
  comfyVideoHunyuan: {
    template: "hunyuan15-i2v-480p.json",
    nodeMap: {
      prompt: { id: "44", field: "text" },
      negative: { id: "93", field: "text" },
      startImage: { id: "80", field: "image" },
      seed: { id: "127", field: "noise_seed" },
      frames: { id: "78", field: "length" },
    },
  },
  // H3 权重本身经 CFG 蒸馏、无负分支（走 BasicGuider 而非 CFGGuider），故不映射 negative。
  // 分辨率跟随 videoWidth/videoHeight（须为 32 的倍数）；帧率固定 24，由模板写死。
  comfyVideoH3: {
    template: "minimax-h3-i2v-4step.json",
    nodeMap: {
      prompt: { id: "5", field: "prompt" },
      startImage: { id: "80", field: "image" },
      seed: { id: "7", field: "noise_seed" },
      width: { id: "5", field: "width" },
      height: { id: "5", field: "height" },
      frames: { id: "5", field: "length" },
    },
  },
  falVideoModel: "fal-ai/wan/v2.2-a14b/image-to-video",
  seedreamModel: "doubao-seedream-5-0-pro-260628",
  seedreamSize: "1664x928",
  videoWidth: 960,
  videoHeight: 544, // Wan 要 16 的倍数，544≈540p
  videoFps: 16,
  keyframeWidth: 1280,
  keyframeHeight: 720,
  refPolicies: {
    "comfyui-image": { refStrategy: "single-crop", refBudget: 3 },
    "comfyui-image2": { refStrategy: "single-crop", refBudget: 3 },
    "seedream-image": { refStrategy: "multi-image", refBudget: 10 },
    "mock-image": { refStrategy: "none", refBudget: 0 },
  },
  prices: {
    "comfyui-image": 0,
    "comfyui-image2": 0,
    "comfyui-video": 0,
    "hunyuan-video": 0,
    "h3-video": 0,
    "fal-video": 0.7,
    "seedream-image": 0.3,
    "mock-image": 0,
    "mock-video": 0,
  },
  defaultShotSec: 5,
  exportKeepAudio: false,
};
