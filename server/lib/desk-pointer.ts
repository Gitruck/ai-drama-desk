/**
 * 用户级落脚点：让下游在**服务没起**时也能确定性解析到项目与产物的位置。
 *
 * 为什么需要它：`gtrk ai-drama lay` 吃的是文件系统路径，而用户手上只有项目 id。
 * 服务在跑时下游可以问 API；服务没跑时，若没有这份落脚点，下游就只剩两条路——
 * 扫盘（明令禁止）或卡住问人。2026-09-18 真机就是这么被逼着跑了一次全盘 find。
 *
 * 为什么是**数组**而不是单条覆盖：同一台机器上源码部署（`<仓库>/data`）与打包部署
 * （用户应用数据目录）长期并存，各有独立数据根、各有真实项目。后写覆盖先写会让下游
 * 在「明明导出了却说找不到」时被引向完全错误的方向；存多条则能直接指出
 * 「你要的在另一个部署里」。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR, PROJECTS_DIR } from "./config.ts";

/**
 * 落脚点文件路径。默认 `~/.gitruck/ai-drama-desk.json`（与 gtrk 生态的配置根归一，
 * 同目录已住 config.json / columns/ / local-broll-index/）。
 *
 * `GITRUCK_DESK_POINTER_PATH` 的存在理由与 `GITRUCK_DESK_DATA_DIR` 同源，是**安全而非灵活**：
 * 测试要验落脚点行为就得写这个文件，没有覆盖时只能去动用户真实的那一份。
 * 2026-08-18 已经因为「测试动真实 config.json + finally 没执行」弄丢过三把 Key，
 * 不再让任何测试有机会碰到用户的 ~/.gitruck。
 */
export function pointerPath(): string {
  const override = process.env.GITRUCK_DESK_POINTER_PATH;
  return override ? resolve(override) : join(homedir(), ".gitruck", "ai-drama-desk.json");
}

/** 条目上限。超出按 lastSeenAt 最旧淘汰——够覆盖「源码 + 打包 + 几次搬家」，又不会无限堆积。 */
export const MAX_INSTANCES = 8;

export interface DeskInstance {
  dataRoot: string;
  projectsDir: string;
  port: number;
  buildId: string;
  /** epoch ms。淘汰依据；也让下游能看出某条是不是很久没露面了。 */
  lastSeenAt: number;
}

export interface DeskPointer {
  instances: DeskInstance[];
}

function readPointer(file: string): DeskPointer {
  if (!existsSync(file)) return { instances: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    const list = (raw as DeskPointer | null)?.instances;
    if (!Array.isArray(list)) return { instances: [] };
    // 逐条校验：这个文件是别的进程写的，也可能被手改坏。坏条目丢掉即可，
    // 但 MUST NOT 因为一条坏的就把整份当空——那会把别的部署的登记一起抹掉。
    const instances = list.filter(
      (x): x is DeskInstance =>
        !!x &&
        typeof (x as DeskInstance).dataRoot === "string" &&
        !!(x as DeskInstance).dataRoot &&
        typeof (x as DeskInstance).projectsDir === "string" &&
        typeof (x as DeskInstance).lastSeenAt === "number",
    );
    return { instances };
  } catch {
    // 半截 JSON（并发写没走原子替换的历史产物）当空处理，本次写入会把它修好
    return { instances: [] };
  }
}

/**
 * 把本实例登记进落脚点。
 *
 * - 按 `dataRoot` 去重：本实例已在册就原地更新 port / buildId / lastSeenAt，不在册则追加；
 *   **MUST NOT 覆盖掉其他 dataRoot 的条目**。
 * - 写入走「临时文件 + rename」原子替换：两个实例可能几乎同时启动，就地覆写会造出半截 JSON。
 * - 读取方不清理条目——暂时没在跑的实例不等于不存在。
 *
 * 返回写成的那份内容；写失败时返回 null（由调用方决定怎么报，**不抛**，落脚点写不成
 * 不该拖垮服务启动）。
 */
export function registerInstance(opts: { port: number; buildId: string; now?: number }): DeskPointer | null {
  const file = pointerPath();
  const now = opts.now ?? Date.now();
  const self: DeskInstance = {
    dataRoot: DATA_DIR,
    projectsDir: PROJECTS_DIR,
    port: opts.port,
    buildId: opts.buildId,
    lastSeenAt: now,
  };

  const current = readPointer(file);
  const others = current.instances.filter((x) => x.dataRoot !== self.dataRoot);
  const next = [self, ...others]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_INSTANCES);

  try {
    mkdirSync(dirname(file), { recursive: true });
    // 同目录临时文件 + rename：跨盘 rename 会失败，所以 tmp 必须和目标同目录
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ instances: next }, null, 2)}\n`, "utf-8");
    renameSync(tmp, file);
    return { instances: next };
  } catch {
    return null;
  }
}
