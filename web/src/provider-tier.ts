/**
 * H3 两档（抽卡 / 成片）的产物归属判定。
 *
 * 为什么要单独一个模块、且必须最长前缀匹配：
 * 产物落盘名形如 `${provider}-${ts}`，而 `h3-video-final` 也 startsWith `h3-video`。
 * 若按最短前缀或首个命中匹配，成片档会被静默标成抽卡档——正好把两档的身份标反，
 * 用户以为自己在挑抽卡的，其实挑的是成片的。
 *
 * ts 的真实形状由 shared/contracts/artifact-name.ts 定义（base36 毫秒 + job 短 id），
 * 本模块不再自行猜测——曾经猜成"十进制时间戳"，导致对一切真实产物名都不命中。
 *
 * 判定只回答"这条是哪档出的"，不回答"哪档更好"——审美取舍留给用户。
 */
import { isArtifactTail } from "../../shared/contracts/artifact-name.ts";

export type TierKind = "draft" | "final";

export interface ProviderTier {
  /** 出口 id，如 h3-video / h3-video-final */
  providerId: string;
  kind: TierKind;
  /** 候选卡上显示的徽章文字 */
  badge: string;
}

/** 只登记成对的分档出口；未登记的出口不打徽章（单档出口没有"哪档"可言）。 */
const TIERED_PROVIDERS: readonly ProviderTier[] = [
  { providerId: "h3-video", kind: "draft", badge: "抽卡" },
  { providerId: "h3-video-final", kind: "final", badge: "成片" },
];

/** 长的排前面，保证 startsWith 命中的是最长的那个。 */
const BY_LENGTH_DESC = [...TIERED_PROVIDERS].sort(
  (a, b) => b.providerId.length - a.providerId.length,
);

/**
 * 从出口 id 或产物文件名判定档位。
 *
 * @param idOrFilename `h3-video-final` 或 `h3-video-final-1755400000000-s12345.mp4`
 * @returns 未登记为分档出口时返回 undefined（不打徽章）
 */
export function providerTier(idOrFilename: string): ProviderTier | undefined {
  return BY_LENGTH_DESC.find(
    (t) =>
      idOrFilename.startsWith(t.providerId) &&
      // 边界判据来自共享契约，不在这里自己猜 ts 长什么样
      isArtifactTail(idOrFilename.slice(t.providerId.length)),
  );
}

/** 候选卡徽章文字；非分档出口返回空串（调用方据此不渲染徽章）。 */
export function tierBadge(idOrFilename: string): string {
  return providerTier(idOrFilename)?.badge ?? "";
}
