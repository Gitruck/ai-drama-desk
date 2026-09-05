import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "./config.ts";

export type LocalEnginePhase =
  | "not-installed"
  | "queued"
  | "downloading"
  | "verifying"
  | "extracting"
  | "pruning"
  | "installed"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export interface LocalEngineStatus {
  supported: boolean;
  phase: LocalEnginePhase;
  installed: boolean;
  running: boolean;
  progress?: number;
  message: string;
  version?: string;
  comfyVersion?: string;
  modelsDir: string;
  engineDir: string;
  pid?: number;
  updatedAt?: string;
}

interface EngineState extends Partial<LocalEngineStatus> {
  phase?: LocalEnginePhase;
}

const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
export const LOCAL_ENGINE_HOME = resolve(
  process.env.GITRUCK_LOCAL_ENGINE_HOME || join(localAppData, "Gitruck", "AI Drama Desk", "local-engine"),
);
export const LOCAL_ENGINE_MANIFEST_URL = process.env.GITRUCK_LOCAL_ENGINE_MANIFEST_URL
  || "https://github.com/Gitruck/ai-drama-desk/releases/latest/download/local-engine-windows-nvidia.json";

const statePath = join(LOCAL_ENGINE_HOME, "state.json");
const installedPath = join(LOCAL_ENGINE_HOME, "current", "installed.json");
const defaultModelsDir = join(LOCAL_ENGINE_HOME, "models");

/**
 * 模型可以放在任意本机绝对路径。这里只解析和校验，不搬动旧模型；切换目录是可逆的。
 */
export function resolveLocalModelsDir(configured?: string): string {
  const value = configured?.trim();
  if (!value) return defaultModelsDir;
  if (!isAbsolute(value)) throw new Error("模型目录必须是绝对路径，例如 D:\\AI-Models\\ComfyUI。");
  const normalized = resolve(value);
  if (existsSync(normalized) && !statSync(normalized).isDirectory()) {
    throw new Error("模型目录指向了文件，请选择文件夹。");
  }
  return normalized;
}

function readJson(path: string): EngineState {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as EngineState;
  } catch {
    return {};
  }
}

function writeState(state: EngineState) {
  mkdirSync(LOCAL_ENGINE_HOME, { recursive: true });
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(temporary, statePath);
}

function pidAlive(pid?: number): boolean {
  if (!pid || !Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function localEngineStatus(configuredModelsDir?: string): LocalEngineStatus {
  const supported = process.platform === "win32" && process.arch === "x64";
  const raw = readJson(statePath);
  const marker = readJson(installedPath);
  const installed = existsSync(installedPath);
  const running = pidAlive(raw.pid);
  let phase = raw.phase ?? (installed ? "installed" : "not-installed");

  // A killed process must not leave the UI permanently claiming it is running.
  if ((phase === "running" || phase === "starting" || phase === "stopping") && !running) {
    phase = installed ? "installed" : "not-installed";
  }

  return {
    supported,
    phase,
    installed,
    running,
    progress: raw.progress,
    message: raw.message || (installed ? "本地引擎已安装，当前未启动。" : "本地引擎尚未安装；云端功能不受影响。"),
    version: raw.version || marker.version,
    comfyVersion: raw.comfyVersion || marker.comfyVersion,
    modelsDir: resolveLocalModelsDir(configuredModelsDir),
    engineDir: join(LOCAL_ENGINE_HOME, "current"),
    pid: running ? raw.pid : undefined,
    updatedAt: raw.updatedAt,
  };
}

export type LocalEngineAction = "install" | "start" | "stop";

export function triggerLocalEngine(action: LocalEngineAction, configuredModelsDir?: string): LocalEngineStatus {
  const modelsDir = resolveLocalModelsDir(configuredModelsDir);
  const current = localEngineStatus(configuredModelsDir);
  if (!current.supported) throw new Error("目前的一键本地引擎只支持 Windows x64。");
  if (action === "install" && ["queued", "downloading", "verifying", "extracting", "pruning"].includes(current.phase)) {
    return current;
  }
  if (action === "install" && current.running) throw new Error("请先停止本地引擎，再更新或重装组件。");
  if (action === "start" && !current.installed) throw new Error("请先安装本地引擎。");
  if (action === "start" && current.running) return current;
  if (action === "stop" && !current.running) return current;

  const script = join(ROOT, "scripts", "local-engine.ps1");
  if (!existsSync(script)) throw new Error(`本地引擎脚本缺失：${script}`);

  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-Action", action,
    "-EngineHome", LOCAL_ENGINE_HOME,
    "-ModelsDir", modelsDir,
    "-ManifestUrl", LOCAL_ENGINE_MANIFEST_URL,
  ];
  const pending: LocalEngineStatus = {
    ...current,
    phase: action === "install" ? "queued" : action === "start" ? "starting" : "stopping",
    message: action === "install" ? "已开始下载本地引擎。" : action === "start" ? "正在启动本地引擎。" : "正在停止本地引擎。",
  };
  writeState(pending);
  const child = spawn("powershell.exe", args, { detached: true, windowsHide: true, stdio: "ignore" });
  child.on("error", (error) => writeState({ ...pending, phase: "failed", message: `无法启动本地引擎安装程序：${error.message}` }));
  child.unref();
  return pending;
}
