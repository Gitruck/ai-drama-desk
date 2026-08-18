/**
 * 产物文件名契约——服务端拼、前端解，放这里当单一事实源。
 *
 * 现状（server/lib/queue.ts:234）：
 *   const ts = `${Date.now().toString(36)}-${job.id.split("-")[0]}`;   // 形如 msy9nomi-j7
 *   outPrefix = `${job.provider}-${ts}`;                               // comfyui-video-mrxf2qsp-j3
 * 盘上实名印证：`comfyui-video-mrxf2qsp-j3.mp4`、`pixmind-video-msx8qoqu-j1.mp4`。
 *
 * **注意 ts 是 base36 毫秒，不是十进制时间戳**——首字符在 2059 年前恒为字母。
 * 曾按"十进制时间戳"写过边界判据，结果对一切真实产物名都不命中、徽章恒不渲染，
 * 而单测用臆造的十进制文件名跑成假绿。所以契约必须写在一处、由两边共用，
 * 且测试用例必须按下面的 ARTIFACT_TS 构造，不许手写字面量。
 */

/** 与 queue.ts 同款的 ts 段构造式。测试与服务端都用它，避免各拼各的。 */
export function artifactTs(nowMs: number, jobShortId: string): string {
  return `${nowMs.toString(36)}-${jobShortId}`;
}

/**
 * 产物文件名前缀。带 seed 的形态用于本地采样类出口（种子可复现）；
 * 云出口无本地种子概念，省略即可。
 */
export function artifactPrefix(provider: string, ts: string, seed?: number): string {
  return seed === undefined ? `${provider}-${ts}` : `${provider}-${ts}-s${seed}`;
}

/**
 * provider 之后允许出现的尾巴形状：
 *   ""                      裸出口 id
 *   "-<base36>-j<n>…"       产物名（可再带 -s<seed> 与扩展名）
 *   ".<ext>"                极少数直接接扩展名的情形
 * base36 毫秒当前恒为 8 位，取 {6,} 既容错又能挡住 `-8step` 这类档位后缀被误吞。
 */
const TAIL_RE = /^-[0-9a-z]{6,}-j\d+/;

export function isArtifactTail(rest: string): boolean {
  return rest === "" || TAIL_RE.test(rest) || rest.startsWith(".");
}
