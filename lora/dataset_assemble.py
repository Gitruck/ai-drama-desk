# -*- coding: utf-8 -*-
"""风格 LoRA · v1 数据集组装（真图直取，零生成风险）

放弃"锚图换主体自举"（实测产劣质 anchor-locked 数据），改用**真实风格成品图**当 target：
  来源 = 你的风格锚图目录 + 工作台已出的 Qwen/Seedream keyframe（跳过 mock）
  每张 + 水平翻转 → 扩一倍
  control = 同尺寸纯黑图（社区 issue #682 实测：黑图 control 训 edit 模型能出触发词风格 LoRA，
           比无 control 好；等价于在 edit 模型上做 T2I 风格训练）
  caption = 固定触发词（--trigger，默认 example style）

想要数据集更大更杂：用工作台路径 A / Seedream 多出几十张不同场景的同风格图，
丢进 data/projects/*/keyframes/ 或额外目录 --extra 纳入，重跑本脚本即可。

用法：python lora/dataset_assemble.py --anchors <你的风格锚图目录> [--extra <dir>] [--size 1024]
锚图目录也可用环境变量 LORA_STYLE_REFS 指定。
"""

import argparse
import glob
import os
from pathlib import Path
from PIL import Image, ImageOps

HERE = Path(__file__).parent
STUDIO = HERE.parent
# 风格锚图目录：--anchors > 环境变量 LORA_STYLE_REFS > lora/refs
DEFAULT_ANCHORS = os.environ.get("LORA_STYLE_REFS", str(HERE / "refs"))
IMG_DIR = HERE / "dataset" / "img"
CTRL_DIR = HERE / "dataset" / "control"
DEFAULT_TRIGGER = "example style"


def collect_sources(anchors: Path, extra: str | None) -> list[Path]:
    srcs: list[Path] = sorted(anchors.glob("*.png"))
    # 工作台真图 keyframe（Qwen/Seedream，跳过 mock 占位）
    for pat in ("comfyui-image-*", "seedream-image-*"):
        srcs += [Path(p) for p in glob.glob(str(STUDIO / "data" / "projects" / "*" / "keyframes" / "*" / f"{pat}.png"))]
    if extra:
        for ext in ("*.png", "*.jpg", "*.jpeg", "*.webp"):
            srcs += [Path(p) for p in glob.glob(str(Path(extra) / "**" / ext), recursive=True)]
    # 去重（按解析后的绝对路径）
    seen, out = set(), []
    for s in srcs:
        k = str(s.resolve()).lower()
        if k not in seen:
            seen.add(k)
            out.append(s)
    return out


def fit(img: Image.Image, size: int) -> Image.Image:
    img = ImageOps.exif_transpose(img).convert("RGB")
    w, h = img.size
    scale = size / max(w, h)
    if scale < 1:
        img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    # 边长取 16 的倍数（Qwen latent 友好）
    w, h = img.size
    return img.crop((0, 0, w - w % 16, h - h % 16))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--anchors", default=DEFAULT_ANCHORS, help="风格锚图目录（也可用环境变量 LORA_STYLE_REFS）")
    ap.add_argument("--extra", default=None, help="额外风格图目录（递归纳入）")
    ap.add_argument("--trigger", default=DEFAULT_TRIGGER, help="LoRA 触发词（训练 caption 前缀）")
    ap.add_argument("--caption", default=None, help="完整训练 caption；缺省 = 触发词")
    ap.add_argument("--size", type=int, default=1024, help="最长边像素")
    ap.add_argument("--no-flip", action="store_true", help="不做水平翻转扩增")
    args = ap.parse_args()
    caption = args.caption or args.trigger

    for d in (IMG_DIR, CTRL_DIR):
        d.mkdir(parents=True, exist_ok=True)

    srcs = collect_sources(Path(args.anchors), args.extra)
    if not srcs:
        raise SystemExit("没找到任何风格源图（用 --anchors / LORA_STYLE_REFS 指定锚图目录）")

    n = 0
    for src in srcs:
        try:
            base = fit(Image.open(src), args.size)
        except Exception as e:
            print(f"跳过 {src.name}: {e}")
            continue
        variants = [("", base)]
        if not args.no_flip:
            variants.append(("-flip", ImageOps.mirror(base)))
        for suffix, im in variants:
            stem = f"{src.stem}{suffix}"
            im.save(IMG_DIR / f"{stem}.png")
            (IMG_DIR / f"{stem}.txt").write_text(caption, encoding="utf-8")
            Image.new("RGB", im.size, (0, 0, 0)).save(CTRL_DIR / f"{stem}.png")
            n += 1
    print(f"组装完成：{n} 张 target（+同名黑 control + caption）→ {IMG_DIR}")
    print(f"源图 {len(srcs)} 张 × {'2(含翻转)' if not args.no_flip else '1'}。")
    print("下一步：lora/README.md 第 2 步 缓存+训练。想更大数据集就多出几十张同风格图 --extra 纳入。")


if __name__ == "__main__":
    main()
