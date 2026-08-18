# ComfyUI workflow 模板槽

工作台不猜你的 ComfyUI 装了什么节点——**你在 ComfyUI 里把 workflow 调通，「工作流 → 导出(API)」存成 JSON 放进本目录**，再到工作台「设置」里登记模板文件名和节点映射。范式来自 dseditor/AI-storyboard-generator（前端只填节点 ID，不碰节点图）。

## 模板槽一览

出图至少要一个 `comfyImage`，出片至少要一个视频槽；其余按需登记，没登记的出口在界面上会被禁用。

| 槽 | 用途 | 推荐底模 | 分辨率来源 |
|---|---|---|---|
| `comfyImage` | 分镜 keyframe：参考图（角色/画风锚图）+ 提示词 → 单帧图 | Qwen-Image-Edit-2511（Apache-2.0，1–3 参考图，一致性事实标准）或 Flux | 全局 `keyframeWidth/Height` |
| `comfyImage2` | 同上，但走画风 LoRA 绑定档（LoRA 名与强度由画风 manifest 运行时注入） | 同上 + 自训画风 LoRA | 全局 `keyframeWidth/Height` |
| `comfyVideo` | 首帧 + 运动提示词 → I2V 视频片段（540p 抽卡档） | Wan2.2 I2V + lightning 4/8 步蒸馏（4090 上 540p 数分钟/条） | 全局 `videoWidth/Height` |
| `comfyVideoHunyuan` | 同上，混元 1.5 车道 | 混元 1.5 480p I2V 蒸馏 | **模板内固定**，不注入 |
| `comfyVideoH3` | MiniMax H3 **抽卡档**：首帧 + 提示词 → 带原生立体声的片段 | MiniMax H3 fl2va int8 + 4 步 Turbo LoRA | 全局 `videoWidth/Height` |
| `comfyVideoH3Final` | MiniMax H3 **成片档**：同上，投入更多采样步数 | 同底模 + 12 步 + SigmaShift + 加速 LoRA | **模板内固定**，不注入 |

> 成片档要额外下一个加速 LoRA（`minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors`），
> 落位与来源见 [README 的模型下载清单](../README.md)。没下这个权重时五层诊断会报缺模、
> 出口在界面上显示「（未配置）」并禁用。

### 关于两档 H3

两档是**两个独立出口**，不是「同一条的两种质量」：切换档位不承诺同 seed 复现同一条产物，
成片档只是投入更多算力。哪档的产物更合用由你自己看，工作台不替你判。

配方差异（加速 LoRA、采样步数、采样器与调度器、SigmaShift、分辨率）**全部写在模板图里**，
不通过节点映射注入——所以自带成片档模板时，要登记的映射键是抽卡档的**子集**：
`prompt`/`startImage`/`seed`/`frames` 四个，刻意不含 `width`/`height`（成片档分辨率由模板固定），
也不需要 `steps`、`sampler`、`lora` 这类新键。工作台对未登记的键是静默忽略的，
若把步数做成可注入项，自带模板的人选「成片档」会悄无声息地拿到抽卡档的采样结果。

另注：SigmaShift 不只改视频 sigma，它同时把音频支路的 `audio_scale` 从 4.0 改成 2.0，
两档音频跑的是不同 schedule——不是「同一条更精细」。

## 设置示例（data/config.json）

```jsonc
{
  "comfyUrl": "http://127.0.0.1:8188",
  "comfyImage": {
    "template": "qwen-edit-keyframe.json",
    "nodeMap": {
      "prompt":   { "id": "6",  "field": "prompt" },       // TextEncodeQwenImageEditPlus 正向
      "negative": { "id": "7",  "field": "prompt" },
      "imageInputs": [                                     // LoadImage × N（按序喂参考图）
        { "id": "10", "field": "image" },
        { "id": "11", "field": "image" },
        { "id": "12", "field": "image" }
      ],
      "seed":   { "id": "15", "field": "seed" },           // KSampler
      "width":  { "id": "14", "field": "width" },          // EmptySD3LatentImage
      "height": { "id": "14", "field": "height" }
    }
  },
  "comfyVideo": {
    "template": "wan22-i2v-540p.json",
    "nodeMap": {
      "prompt":     { "id": "6",  "field": "text" },
      "negative":   { "id": "7",  "field": "text" },
      "startImage": { "id": "71", "field": "image" },      // 首帧 LoadImage
      "seed":       { "id": "57", "field": "noise_seed" }, // KSamplerAdvanced
      "width":      { "id": "73", "field": "width" },      // WanImageToVideo
      "height":     { "id": "73", "field": "height" },
      "frames":     { "id": "73", "field": "length" }      // Wan 帧数（自动 4n+1 量化）
    }
  },
  "comfyVideoH3Final": {
    "template": "minimax-h3-i2v-final.json",
    "nodeMap": {
      "prompt":     { "id": "5",  "field": "prompt" },
      "startImage": { "id": "80", "field": "image" },
      "seed":       { "id": "7",  "field": "noise_seed" },
      "frames":     { "id": "5",  "field": "length" }      // H3 帧数（自动 17k+5 量化）
      // 刻意不登记 negative：H3 权重已 CFG 蒸馏、无负分支
      // 刻意不登记 width/height：成片档分辨率由模板固定
    }
  }
}
```

注意：

- 节点 ID 看导出 JSON 的顶层 key（`"6": {...}`），或 ComfyUI 里开「Badge: ID」。
- `imageInputs` 槽位数量 = 模板里 LoadImage 数量；参考图少于槽位时，多余槽位保留模板默认值——**给模板里的 LoadImage 预置一张中性占位图**，或做一个只有 1–2 个槽位的变体模板。
- 视频模板输出节点用能落 mp4/webm 的（VHS SaveVideo 等）；图像用 SaveImage。工作台从 history 的 outputs 里抓 `images/gifs/videos` 三类。
- GPL 边界：只走 ComfyUI HTTP API，不派生其代码。
