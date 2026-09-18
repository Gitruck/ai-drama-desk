/**
 * 在系统文件管理器里打开一个本地目录。
 *
 * 为什么服务端做这件事：工作台只监听回环，服务与用户在同一台机器上，
 * 由服务端调起文件管理器是唯一可行的路（浏览器没有这个能力）。
 * 这也是 `server/index.ts` 里 `hostname: "127.0.0.1"` 那个硬编码的又一条依赖——
 * **放开监听面时，本模块必须同批复查**。
 *
 * 只接受调用方从服务端自己算出来的路径（DATA_DIR 等），
 * **MUST NOT 接受请求体里传进来的任意路径**——那等于给本机开一个任意目录打开器。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type RevealResult = { ok: true } | { ok: false; reason: string };

/** 返回本平台的调起命令；平台不认识时给 null，由调用方退化为「显示路径 + 复制」。 */
function revealCommand(dir: string): { cmd: string; args: string[] } | null {
  if (process.platform === "win32") return { cmd: "explorer.exe", args: [dir] };
  if (process.platform === "darwin") return { cmd: "open", args: [dir] };
  if (process.platform === "linux") return { cmd: "xdg-open", args: [dir] };
  return null;
}

export function revealInFileManager(dir: string): RevealResult {
  if (!existsSync(dir)) return { ok: false, reason: "目录不存在" };
  const c = revealCommand(dir);
  if (!c) return { ok: false, reason: `当前平台（${process.platform}）没有已知的文件管理器调起方式` };
  try {
    // detached + unref：文件管理器是长活进程，不能挂在服务进程下面，
    // 否则服务退出会把它带走、或反过来让服务等它。
    const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true };
  } catch (e) {
    // explorer.exe 对某些路径会以非零码退出但窗口照开，所以这里只捕获「压根起不来」
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
