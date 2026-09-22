/**
 * 产物根的校验与迁移（openspec: add-configurable-workspace-root）。
 *
 * ## 立题
 *
 * 前两件把「数据在哪」从**不可知**做成了**可见**（`/api/paths` + `DataDirPanel`）。
 * 但**可见不等于可用**：看见了，然后呢——想挪走，界面上没有任何入口。
 *
 * 这是容量问题不是偏好问题。实测一条片子 **351 MB**，其中 **97% 是 `projects/`**，
 * 而它默认落在系统盘的用户目录（打包版 `C:\Users\<user>\AppData\Local\...`）。
 * 做几条片子就是好几个 GB 压在 C 盘，而素材盘通常在别处。
 *
 * ## 射程：只管 `projects` 根，**不动 `DATA_DIR`**
 *
 * `config.json` 自己就住在 `DATA_DIR` 里——要让整个 `DATA_DIR` 可配，设置项就不能放
 * config.json，得另立引导文件。而 `projectsRoot` 放 config.json 完全没有这个循环，
 * 且拿到了 97% 的收益。config.json 里那三把明文密钥留在用户目录也更稳妥——
 * 跟着产物搬到移动硬盘/共享盘是**扩大**暴露面。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DATA_DIR, projectsRoot } from "./config.ts";

export interface RootCheck {
  ok: boolean;
  /** 规范化后的绝对路径（ok=false 时仍给，便于界面回显用户到底填了什么）。 */
  resolved: string;
  /** 拒绝原因（人读，MUST 说清下一步）。 */
  reason?: string;
  /** 目标是否已存在。 */
  exists: boolean;
  /** 目标里已有的项目数（已存在时才有意义）。 */
  existingProjects?: number;
}

/** 一个目录是不是另一个的祖先或后代（含自身）。 */
function isNested(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  if (ra === rb) return true;
  const rel1 = relative(ra, rb);
  const rel2 = relative(rb, ra);
  const inside = (rel: string) => rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  return inside(rel1) || inside(rel2);
}

/** 目录里有几个看着像项目的子目录（有 project.json）。 */
export function countProjectsIn(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "project.json"))).length;
  } catch {
    return 0;
  }
}

/**
 * 目标目录能不能当产物根。
 *
 * ⚠️ **套娃是主要拦截对象**：把产物根设成 `DATA_DIR` 本身或它的后代/祖先，
 * 会让 config.json 与产物互相嵌套——迁移时「把源删掉」就可能把配置一起删掉。
 * 这条 MUST 在任何写盘之前拦住。
 */
export function checkRootCandidate(
  input: string,
  opts: { occupiedBy?: (dir: string) => string | null } = {},
): RootCheck {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, resolved: "", exists: false, reason: "路径是空的" };
  if (!isAbsolute(raw)) {
    return { ok: false, resolved: raw, exists: false, reason: "请给绝对路径（如 D:\\gitruck-projects），相对路径会随启动目录漂移" };
  }
  const target = resolve(raw);

  if (isNested(target, DATA_DIR)) {
    return {
      ok: false,
      resolved: target,
      exists: existsSync(target),
      reason: `不能设在数据目录里面或外面套住它（数据目录：${DATA_DIR}）——config.json 就住在那儿，嵌套会让迁移时的删源动作误删配置`,
    };
  }

  const occupier = opts.occupiedBy?.(target);
  if (occupier) {
    return { ok: false, resolved: target, exists: true, reason: `这个目录已被另一个实例用作产物根（${occupier}）；两个实例共用一个根会互相覆盖项目` };
  }

  // 存在 ⇒ 必须是目录且可写；不存在 ⇒ 父目录必须能建出来
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) return { ok: false, resolved: target, exists: true, reason: "这是个文件，不是目录" };
    const probe = join(target, `.gtrk-write-probe-${process.pid}`);
    try {
      writeFileSync(probe, "");
      rmSync(probe, { force: true });
    } catch (e) {
      return { ok: false, resolved: target, exists: true, reason: `目录不可写：${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, resolved: target, exists: true, existingProjects: countProjectsIn(target) };
  }

  try {
    mkdirSync(target, { recursive: true });
  } catch (e) {
    return { ok: false, resolved: target, exists: false, reason: `建不出这个目录：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, resolved: target, exists: false, existingProjects: 0 };
}

export interface MigrationResult {
  moved: string[];
  /** 没搬成的（逐条报因）。 */
  failed: Array<{ id: string; reason: string }>;
  /** 因目标已同名存在而跳过的。 */
  skipped: Array<{ id: string; reason: string }>;
  /** 源里还剩几个（用户选「不搬」时 = 全部）。 */
  remainingAtOld: number;
  oldRoot: string;
  newRoot: string;
}

/**
 * 把项目从旧根搬到新根。
 *
 * ⚠️ **MUST NOT 用 rename**：跨盘 `rename` 抛 `EXDEV`，而改产物根的**典型场景就是跨盘**
 * （C 盘搬到素材盘）。走 copy → 校验 → 删源。
 *
 * ⚠️ **删源在校验之后**，且逐项目独立：中途失败时源还在、目标那一个残件被清掉，
 * **MUST NOT 留下半个项目**。宁可留两份也不能留半份——半份会被 `listProjects()`
 * 当成正常项目列出来。
 */
export function migrateProjects(
  oldRoot: string,
  newRoot: string,
  opts: { copy?: (src: string, dst: string) => void; onTick?: (done: number, total: number, id: string) => void } = {},
): MigrationResult {
  const copy = opts.copy ?? ((src: string, dst: string) => cpSync(src, dst, { recursive: true, errorOnExist: true, force: false }));
  const result: MigrationResult = { moved: [], failed: [], skipped: [], remainingAtOld: 0, oldRoot, newRoot };
  if (!existsSync(oldRoot) || resolve(oldRoot) === resolve(newRoot)) {
    result.remainingAtOld = countProjectsIn(oldRoot);
    return result;
  }

  const ids = readdirSync(oldRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(oldRoot, d.name, "project.json")))
    .map((d) => d.name);

  for (const [i, id] of ids.entries()) {
    const src = join(oldRoot, id);
    const dst = join(newRoot, id);
    if (existsSync(dst)) {
      // 同名已存在 ⇒ **不覆盖**。用户可能早就手动搬过一部分，覆盖就是数据丢失。
      result.skipped.push({ id, reason: "新位置已有同名项目，未覆盖" });
      continue;
    }
    try {
      copy(src, dst);
      if (!existsSync(join(dst, "project.json"))) throw new Error("拷完校验不通过：新位置缺 project.json");
      rmSync(src, { recursive: true, force: true });
      result.moved.push(id);
    } catch (e) {
      // 残件清掉，源保持原样 —— 失败后的状态必须是「还没搬」而不是「搬了一半」
      try {
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
      } catch {
        /* 清不掉就如实留在 failed 里，别把清理失败伪装成迁移失败之外的新状态 */
      }
      result.failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
    }
    opts.onTick?.(i + 1, ids.length, id);
  }
  result.remainingAtOld = countProjectsIn(oldRoot);
  return result;
}

/**
 * 有任务在途时的拒绝文案；不忙时返回 `null`。
 *
 * 拆成纯函数是因为**这条分支在集成测试里天然竞态**：真起一个 job 去断言 409，
 * job 可能在断言之前就跑完了，用例会时绿时红——那种用例比没有更坏。
 * 判据与文案在这里被确定性地钉住，端点只负责把 `listJobs()` 递进来。
 *
 * 拍板口径（tasks 0.2）：**直接拒绝**，不做「待执行的设置变更」状态——
 * 那东西在进程重启时的语义是一串新问题。
 */
export function activeJobsRejection(jobs: ReadonlyArray<{ status: string }>): string | null {
  const busy = jobs.filter((j) => j.status === "queued" || j.status === "running");
  if (!busy.length) return null;
  const byStatus = busy.reduce<Record<string, number>>((acc, j) => ({ ...acc, [j.status]: (acc[j.status] ?? 0) + 1 }), {});
  const detail = Object.entries(byStatus)
    .map(([k, v]) => `${v} 个${k === "running" ? "在跑" : "排队中"}`)
    .join("、");
  return `还有 ${busy.length} 个任务（${detail}），现在改产物根会把写到一半的项目分裂在两个位置。等它们结束或取消后再改。`;
}

/** 当刻根 + 默认根，供 `/api/paths` 与迁移端点共用（MUST NOT 各推断一份）。 */
export function currentRoots(): { projectsRoot: string; dataRoot: string } {
  return { projectsRoot: projectsRoot(), dataRoot: DATA_DIR };
}
