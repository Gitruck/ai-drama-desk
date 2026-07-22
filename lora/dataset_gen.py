# -*- coding: utf-8 -*-
"""风格 LoRA · 配对数据集自举（BACKWARD 法，for Qwen-Image-Edit-2511）

社区公论：给 edit 模型训风格 LoRA 要「control→target」配对，不能单图硬训。
本脚本两段式，全走本地 ComfyUI（工作台的 comfyImage 模板 = Qwen-Edit-2511）：

  段1 造 target：风格锚图 × 主体变体 → 换主体保画风 → dataset/img/<name>.png（目标风格成品，多样主体）
  段2 造 control：把每张 target「去风格化」成写实照片版 → dataset/control/<name>.png（同名配对）
  caption：dataset/img/<name>.txt 全部写固定触发指令（--trigger，默认 example style）

推理时 control 槽喂角色图 → LoRA 把它重绘成目标风格。训练学的就是这个映射。

用法：ComfyUI 起在 8188、工作台 comfyImage 模板已配好后
    python lora/dataset_gen.py --refs <你的风格锚图目录> [--per-anchor 4] [--comfy http://127.0.0.1:8188]
锚图目录也可用环境变量 LORA_STYLE_REFS 指定；触发词/风格描述用 --trigger / --style-lock 覆盖。
产出后人工筛图（删写实化失败/风格崩/主体漏的），target 与 control 成对删，再按 lora/README.md 训练。
"""

import argparse
import json
import os
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).parent
STUDIO = HERE.parent
# 风格锚图目录：--refs > 环境变量 LORA_STYLE_REFS > lora/refs
DEFAULT_REFS = os.environ.get("LORA_STYLE_REFS", str(HERE / "refs"))
IMG_DIR = HERE / "dataset" / "img"       # target（目标风格）+ caption
CTRL_DIR = HERE / "dataset" / "control"  # control（去风格化）

# 固定触发指令（训练 caption）：trigger 建议用不成词的生造词，防底模先验污染
DEFAULT_TRIGGER = "example style"

# 以下为示例风格描述，请替换/用 --style-lock、--style-neg 覆盖成你自己的风格锁
DEFAULT_STYLE_LOCK = (
    "插画感动画画面，线条干净、色彩统一、构图完整，绝非写实摄影。"
    "（示例风格描述——把这里换成你自己的画风锁：质感、色彩倾向、留白与构图习惯等。）"
)
DEFAULT_STYLE_NEG = (
    "写实、真人、照片质感、高反差、过饱和、HDR、霓虹、3D渲染、"
    "塑料皮肤、画面文字、字幕、水印、畸形脸、多指"
)
# 去风格化：保结构去画风，把插画改成真实照片当 control
DESTYLE_PROMPT = (
    "把这张手绘插画改成真实自然的摄影照片：保持完全相同的构图、人物姿态、场景布局、"
    "物体位置和数量不变，只把画风从平涂插画换成真实光影、真实材质、写实皮肤的照片质感。"
)
DESTYLE_NEG = "插画、平涂、卡通、动漫、手绘、线稿、油画、水彩、画面文字、水印"

SUBJECTS = [
    "一位老人坐在公园长椅上喂鸽子，旁边一根木拐杖",
    "一个年轻女性在窗边的书桌前用笔记本电脑工作，桌上一杯冒热气的茶",
    "两个小学生并肩走在放学路上，一人手里一串糖葫芦",
    "一位外卖员骑手在楼下按门铃，头盔夹在腋下",
    "一家三口在客厅地毯上拼拼图，台灯暖光",
    "一个中年女性在厨房灶台前掂锅，围裙上一小块番茄红",
    "一位医生在诊室里隔着桌子与病人交谈，白大褂",
    "一个男孩蹲在巷口看蚂蚁搬家，书包放在脚边",
    "一位快递站大叔在货架间找包裹，手里一张小票",
    "一个女孩在雨后的站台等车，手里一把收起的伞",
    "一位理发师给客人围上围布，镜子里两人相视",
    "祖孙两人在阳台给多肉浇水，小喷壶",
]


def _upload(comfy, ref_path):
    import mimetypes
    boundary = uuid.uuid4().hex
    data = Path(ref_path).read_bytes()
    mime = mimetypes.guess_type(str(ref_path))[0] or "image/png"
    name = f"loragen-{Path(ref_path).name}"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{comfy}/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
    )
    up = json.load(urllib.request.urlopen(req))
    return (up.get("subfolder") and f"{up['subfolder']}/{up['name']}") or up["name"]


def comfy_edit(comfy, template, nodemap, ref_path, prompt, negative, out_path):
    """用 Qwen-Edit 模板：ref 当唯一控制图，出一张图落 out_path。返回是否成功。"""
    graph = json.loads(json.dumps(template))
    uploaded = _upload(comfy, ref_path)

    def sset(ref, value):
        if ref and ref.get("id") in graph:
            graph[ref["id"]]["inputs"][ref["field"]] = value

    sset(nodemap.get("prompt"), prompt)
    sset(nodemap.get("negative"), negative)
    # 三个参考槽都喂同一张控制图，强化条件
    for slot in (nodemap.get("imageInputs") or []):
        sset(slot, uploaded)
    sset(nodemap.get("seed"), int(time.time() * 1000) % (2**31))

    sub = urllib.request.Request(
        f"{comfy}/prompt",
        data=json.dumps({"prompt": graph, "client_id": uuid.uuid4().hex}).encode(),
        headers={"Content-Type": "application/json"},
    )
    pid = json.load(urllib.request.urlopen(sub))["prompt_id"]
    for _ in range(400):
        time.sleep(2)
        hist = json.load(urllib.request.urlopen(f"{comfy}/history/{pid}"))
        entry = hist.get(pid)
        if not entry:
            continue
        if entry.get("status", {}).get("status_str") == "error":
            print(f"    !! ComfyUI 出错: {str(entry['status'])[:200]}")
            return False
        for node_out in (entry.get("outputs") or {}).values():
            for f in node_out.get("images", []):
                if f.get("type") not in (None, "output"):
                    continue
                q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": "output"})
                Path(out_path).write_bytes(urllib.request.urlopen(f"{comfy}/view?{q}").read())
                return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-anchor", type=int, default=4, help="每张锚图出几个主体变体（如 15锚×4≈60对）")
    ap.add_argument("--comfy", default="http://127.0.0.1:8188")
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 对（0=全部，用于小测）")
    ap.add_argument("--refs", default=DEFAULT_REFS, help="风格锚图目录（也可用环境变量 LORA_STYLE_REFS）")
    ap.add_argument("--trigger", default=DEFAULT_TRIGGER, help="LoRA 触发词（训练 caption 前缀）")
    ap.add_argument("--caption", default=None, help="完整训练 caption；缺省 = 触发词")
    ap.add_argument("--style-lock", default=DEFAULT_STYLE_LOCK, help="段1 造 target 用的风格锁描述")
    ap.add_argument("--style-neg", default=DEFAULT_STYLE_NEG, help="段1 的负向描述")
    args = ap.parse_args()
    refs_dir = Path(args.refs)
    caption = args.caption or args.trigger

    cfg = json.loads((STUDIO / "data" / "config.json").read_text(encoding="utf-8"))
    wf = cfg.get("comfyImage")
    if not wf:
        raise SystemExit("config.json 里没配 comfyImage 模板")
    template = json.loads((STUDIO / "templates" / wf["template"]).read_text(encoding="utf-8"))
    nodemap = wf["nodeMap"]

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    CTRL_DIR.mkdir(parents=True, exist_ok=True)
    refs = sorted(refs_dir.glob("*.png"))
    if not refs:
        raise SystemExit(f"锚图目录为空: {refs_dir}（用 --refs 或 LORA_STYLE_REFS 指定）")

    pairs, done = 0, 0
    for ref in refs:
        for i in range(args.per_anchor):
            if args.limit and pairs >= args.limit:
                break
            subj = SUBJECTS[(pairs) % len(SUBJECTS)]
            stem = f"{ref.stem}-v{i + 1}"
            target = IMG_DIR / f"{stem}.png"
            control = CTRL_DIR / f"{stem}.png"
            pairs += 1
            if target.exists() and control.exists():
                done += 1
                continue
            print(f"[{pairs}] {ref.stem} × {subj[:16]}…")
            # 段1：锚图→目标风格 target（换主体）
            if not target.exists():
                if not comfy_edit(args.comfy, template, nodemap, ref,
                                  f"{args.style_lock}\n画面内容：{subj}\n单帧静态画面，构图完整。", args.style_neg, target):
                    print("    段1失败，跳过这对"); continue
            # 段2：target→去风格化 control（保结构去画风）
            if not comfy_edit(args.comfy, template, nodemap, target, DESTYLE_PROMPT, DESTYLE_NEG, control):
                print("    段2失败：删掉孤儿 target"); target.unlink(missing_ok=True); continue
            (IMG_DIR / f"{stem}.txt").write_text(caption, encoding="utf-8")
            done += 1
            print("    [ok] 配对成功")
        if args.limit and pairs >= args.limit:
            break
    print(f"\n完成：{done}/{pairs} 对。人工筛图（img/ 与 control/ 同名成对删翻车的），再走 lora/README.md 训练。")


if __name__ == "__main__":
    main()
