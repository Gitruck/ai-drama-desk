/**
 * 失败分类：让「这算哪种失败」变成机器可读的事实。
 *
 * 分类必须在**抛出点**打，MUST NOT 事后拿错误文案做正则猜——
 * 文案会随上游变、会被截断、还会把 abort 后的 fetch 错误误判成网络抖动。
 * 本仓刚在产物命名上吃过「按臆想的格式写判据、单测用臆造数据跑成假绿」的亏。
 *
 * 分不清就落 unknown，别装作分得清：unknown 一律按不可自动处理对待。
 */

export type FailureKind =
  /** 网络抖动、服务暂时不可达、上游 5xx —— 同样的请求过一会儿可能就成了 */
  | "transient"
  /** 缺 Key、缺模板、节点映射错、缺 keyframe —— 不改配置重试多少次都一样 */
  | "config"
  /** 内容策略拒绝、输入图不合法 —— 确定性失败，换输入才有意义 */
  | "content"
  /** 显存不足、磁盘写满 —— 重试通常再炸一次，且独占本地车道分钟级 */
  | "resource"
  /** 云端已建单、费用已产生 —— 重试等于二次扣费 */
  | "cloud-billed"
  /** 分不清。默认值，按不可自动处理对待 */
  | "unknown";

/** 带分类的错误。provider 与 queue 都抛它，分类随错误一起往上走。 */
export class ProviderError extends Error {
  readonly kind: FailureKind;
  /** 可选的机读细节，如上游异常类型、出错节点 */
  readonly detail?: Record<string, unknown>;

  constructor(kind: FailureKind, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** 从任意抛出物取分类；不是 ProviderError 就是 unknown（不猜）。 */
export function failureKindOf(e: unknown): FailureKind {
  return e instanceof ProviderError ? e.kind : "unknown";
}

/**
 * ComfyUI 的 history.status.messages 是结构化的：
 * `[["execution_error", { node_type, exception_type, exception_message, ... }], ...]`
 * 原先的实现把整段 JSON.stringify 后 slice(0,500) 抛出去——
 * OOM / 缺模型 / 缺节点 / 图校验错全压成同一句，截断点还可能正好切掉异常类型名。
 * 这里把它解出来分别成文。
 */
export function parseComfyExecutionError(messages: unknown): {
  kind: FailureKind;
  message: string;
  detail?: Record<string, unknown>;
} {
  const err = findExecutionError(messages);
  if (!err) {
    // 解不出结构就如实说解不出，并附原始片段供人工排查——不猜分类
    const raw = JSON.stringify(messages ?? []).slice(0, 300);
    return { kind: "unknown", message: `ComfyUI 执行出错（未能解析出错误结构）：${raw}` };
  }

  const type = String(err.exception_type ?? "");
  const msg = String(err.exception_message ?? "");
  const node = err.node_type ? `节点 ${err.node_type}` : "某节点";
  const detail = { exceptionType: type, nodeType: err.node_type, nodeId: err.node_id };

  // 显存不足：重试必再炸，且会独占本地车道分钟级
  if (/OutOfMemoryError|CUDA out of memory|out of memory/i.test(`${type} ${msg}`)) {
    return {
      kind: "resource",
      message: `ComfyUI 显存不足（${node}）。换更小的分辨率/帧数，或关掉占显存的其他程序再试。原文：${msg.slice(0, 200)}`,
      detail,
    };
  }
  // 缺模型/权重：诊断页会点名具体文件
  if (/not.*(found|exist)|无法找到|does not exist|FileNotFound/i.test(msg) && /\.(safetensors|ckpt|pt|pth|gguf|bin)/i.test(msg)) {
    return {
      kind: "config",
      message: `ComfyUI 缺少模型权重（${node}）：${msg.slice(0, 200)}。按 README 模型清单落位后在设置页重新诊断。`,
      detail,
    };
  }
  // 缺节点/插件
  if (/does not exist|not a valid|KeyError/i.test(`${type} ${msg}`) && /node|class_type/i.test(msg)) {
    return {
      kind: "config",
      message: `ComfyUI 缺少节点或节点映射不对（${node}）：${msg.slice(0, 200)}。装对应插件并重启，或检查模板的节点映射。`,
      detail,
    };
  }
  // 图校验/入参类
  if (/ValueError|TypeError|unexpected keyword|required input/i.test(`${type} ${msg}`)) {
    return {
      kind: "config",
      message: `ComfyUI 图或入参不合法（${node}，${type}）：${msg.slice(0, 200)}。多半是模板与节点映射对不上。`,
      detail,
    };
  }
  return {
    kind: "unknown",
    message: `ComfyUI 执行出错（${node}，${type || "未知异常"}）：${msg.slice(0, 240)}`,
    detail,
  };
}

function findExecutionError(messages: unknown): Record<string, any> | null {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    // 形如 ["execution_error", {...}]
    if (Array.isArray(m) && m.length >= 2 && String(m[0]).includes("error") && m[1] && typeof m[1] === "object") {
      return m[1] as Record<string, any>;
    }
  }
  return null;
}
