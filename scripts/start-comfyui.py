#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ComfyUI 启动器（本工作台推荐配置）。

为什么不直接 `python main.py`：
  1. 加速参数得有人记着。裸启动走 pytorch attention，本机 4090 实测一条 5.17 秒
     H3 片端到端 53.1s；带下面三个参数是 31.1s（快 41.5%）。参数写在这里，不靠人脑记。
     三个参数缺一不可——实测去掉 --reserve-vram 后采样一样快，但省下的时间会被
     VAE 解码时的显存争抢全部吃回去，端到端只快 3.8%。
  2. Windows 上端口 8188 可能被 Hyper-V/Docker 划进系统保留区间导致 bind 失败
     （WinError 10013），报错晦涩且不指向真因。这里先自检、直接给出修法。
  3. attention 后端是否真生效只能从日志看。这里起服后自证一次，没生效就明说。

许可边界：本脚本仅以子进程方式启动【你自行安装的】ComfyUI 并读取其标准输出，
不包含、不派生 ComfyUI（GPL-3.0）的任何代码。

用法:
    python scripts/start-comfyui.py <ComfyUI目录>          # 推荐配置起服
    python scripts/start-comfyui.py <ComfyUI目录> --baseline   # 无加速参数（对照/排障）
    COMFYUI_DIR=... python scripts/start-comfyui.py        # 目录也可走环境变量
    脚本未识别的参数原样透传给 main.py（如 --lowvram）。
"""
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROD_PORT = 8188  # 工作台 data/config.json 的 comfyUrl 默认指向这里
FALLBACK_PORTS = [8288, 8388, 8788, 9188]

# 本机 4090 实测（详见仓内 README「推荐启动参数」小节）：
# ck attention ~26% + fp16 累加 ~8% + 抬高显存预留 ~7%，端到端合计快 41.5%
ACCEL_FLAGS = ["--use-ck-attention", "--fast", "fp16_accumulation", "--reserve-vram", "2.0"]

BACKEND_MARKERS = [
    "Using pytorch attention", "Using sage attention", "Using Flash Attention",
    "Using xformers attention", "Using Comfy Kitchen attention",
    "Using split optimization for attention", "Using sub quadratic optimization for attention",
]
DEGRADE_RE = re.compile(r"Error running sage attention|using pytorch attention instead")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def can_bind(port: int) -> bool:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def port_listening(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(1.0)
        return s.connect_ex(("127.0.0.1", port)) == 0


def excluded_ranges():
    """Windows 保留端口区间；非 Windows 返回空。"""
    if os.name != "nt":
        return []
    try:
        out = subprocess.run(
            ["netsh", "interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
            capture_output=True, text=True, timeout=20,
        ).stdout
        return [(int(a), int(b)) for a, b in re.findall(r"^\s*(\d+)\s+(\d+)", out, re.M)]
    except Exception:
        return []


def resolve_port() -> int:
    if port_listening(PROD_PORT):
        print(f"[!] 端口 {PROD_PORT} 已有服务在监听——ComfyUI 可能已经起过了。")
        sys.exit(1)
    if can_bind(PROD_PORT):
        return PROD_PORT
    hit = next((r for r in excluded_ranges() if r[0] <= PROD_PORT <= r[1]), None)
    print(f"[!] 端口 {PROD_PORT} 无法绑定。")
    if hit:
        print(f"    原因：它落在 Windows 保留端口区间 {hit[0]}-{hit[1]} 内（通常是 Hyper-V / Docker / WSL 抢走的动态端口段）。")
        print("    修法二选一（都要管理员权限）：")
        print("      A. 临时释放（会短暂打断 Docker/WSL 网络）：net stop winnat && net start winnat")
        print("      B. 永久摘出（重启生效）：netsh int ipv4 set dynamicport tcp start=49152 num=16384")
    for p in FALLBACK_PORTS:
        if can_bind(p):
            print(f"\n    本次先用备用端口 {p}。注意：工作台 data/config.json 的 comfyUrl 仍指向 {PROD_PORT}，")
            print(f'    不改的话工作台连不上。临时改法："comfyUrl": "http://127.0.0.1:{p}"')
            return p
    print("[x] 备用端口也全不可用，放弃。")
    sys.exit(1)


def find_python(comfy_dir: Path) -> str:
    """优先用 ComfyUI 自己的 venv，找不到用当前解释器。"""
    for rel in ("venv/Scripts/python.exe", "venv/bin/python", ".venv/Scripts/python.exe", ".venv/bin/python"):
        p = comfy_dir / rel
        if p.exists():
            return str(p)
    return sys.executable


def main() -> int:
    args = sys.argv[1:]
    baseline = "--baseline" in args
    args = [a for a in args if a != "--baseline"]

    comfy_dir = None
    if args and not args[0].startswith("-"):
        comfy_dir = Path(args.pop(0))
    elif os.environ.get("COMFYUI_DIR"):
        comfy_dir = Path(os.environ["COMFYUI_DIR"])
    if not comfy_dir or not (comfy_dir / "main.py").exists():
        print("用法: python scripts/start-comfyui.py <ComfyUI目录> [--baseline] [透传参数...]")
        print("      或设环境变量 COMFYUI_DIR。目录下须有 main.py。")
        return 2

    port = resolve_port()
    flags = [] if baseline else list(ACCEL_FLAGS)
    cmd = [find_python(comfy_dir), "main.py", "--port", str(port)] + flags + args

    print("=" * 74)
    print(f"  ComfyUI  端口 {port}  目录 {comfy_dir}")
    print(f"  加速参数: {' '.join(flags) if flags else '(无 —— baseline 对照模式)'}")
    print("=" * 74)

    proc = subprocess.Popen(cmd, cwd=str(comfy_dir), stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace", bufsize=1)
    seen = False
    warned = False
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            print(line, flush=True)
            if "Using Comfy Kitchen attention" in line:
                seen = True
                print("    >>> 后端自证: Comfy Kitchen int8 attention（已覆盖 pytorch）", flush=True)
            elif any(m in line for m in BACKEND_MARKERS):
                seen = True
                print(f"    >>> 后端自证: {ANSI_RE.sub('', line).split('] ')[-1]}", flush=True)
            if "Enabled fp16 accumulation" in line:
                print("    >>> 后端自证: fp16 累加已开", flush=True)
            if "Starting server" in line and not seen and not baseline:
                print("    >>> [!] 没读到任何 attention 后端字样，加速可能没生效", flush=True)
            if DEGRADE_RE.search(line) and not warned:
                warned = True
                print("    >>> [!] attention 运行时回退到 pytorch——加速已失效，本次出片速度按基线算", flush=True)
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        return 130


if __name__ == "__main__":
    sys.exit(main())
