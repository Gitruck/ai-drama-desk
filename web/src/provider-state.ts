export interface StyleWithLora {
  lora?: unknown;
}

export function keyframeProviderState(
  providerId: string,
  providerReady: Record<string, boolean>,
  style: StyleWithLora | undefined,
): { enabled: boolean; suffix: string; reason?: string } {
  if (providerId === "comfyui-image2" && !style?.lora) {
    return { enabled: false, suffix: "（当前画风未绑定 LoRA）", reason: "请先选择已绑定 LoRA 的画风，或在 LoRA 训练页发布到当前画风" };
  }
  if (providerReady[providerId] === false) {
    return { enabled: false, suffix: "（运行环境未就绪）", reason: "请到设置页查看 ComfyUI 分层诊断" };
  }
  return { enabled: true, suffix: "" };
}
