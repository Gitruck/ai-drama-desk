# ComfyUI workflow 模板槽

工作台不猜你的 ComfyUI 装了什么节点——**你在 ComfyUI 里把 workflow 调通，「工作流 → 导出(API)」存成 JSON 放进本目录**，再到工作台「设置」里登记模板文件名和节点映射。范式来自 dseditor/AI-storyboard-generator（前端只填节点 ID，不碰节点图）。

## 需要两个模板

| 槽 | 用途 | 推荐底模（2026-07） |
|---|---|---|
| `comfyImage` | 分镜 keyframe：参考图（角色/画风锚图）+ 提示词 → 单帧图 | Qwen-Image-Edit-2511（Apache-2.0，1–3 参考图，一致性事实标准）或 Flux |
| `comfyVideo` | 首帧 + 运动提示词 → I2V 视频片段（540p 抽卡档） | Wan2.2 I2V + lightning 4/8 步蒸馏（4090 上 540p 数分钟/条） |

## 设置示例（data/config.json）

```jsonc
{
  "comfyUrl": "http://127.0.0.1:8188",
  "comfyImage": {
    "template": "qwen-edit-keyframe.json",
    "nodeMap": {
      "prompt":   { "id": "6",  "field": "text" },      // CLIPTextEncode 正向
      "negative": { "id": "7",  "field": "text" },
      "imageInputs": [                                     // LoadImage × N（按序喂参考图）
        { "id": "10", "field": "image" },
        { "id": "11", "field": "image" },
        { "id": "12", "field": "image" }
      ],
      "seed":   { "id": "3", "field": "seed" },
      "width":  { "id": "5", "field": "width" },
      "height": { "id": "5", "field": "height" }
    }
  },
  "comfyVideo": {
    "template": "wan22-i2v-540p.json",
    "nodeMap": {
      "prompt":     { "id": "6",  "field": "text" },
      "negative":   { "id": "7",  "field": "text" },
      "startImage": { "id": "52", "field": "image" },      // 首帧 LoadImage
      "seed":       { "id": "3",  "field": "seed" },
      "frames":     { "id": "50", "field": "length" }      // Wan 帧数节点（自动 4n+1 量化）
    }
  }
}
```

注意：

- 节点 ID 看导出 JSON 的顶层 key（`"6": {...}`），或 ComfyUI 里开「Badge: ID」。
- `imageInputs` 槽位数量 = 模板里 LoadImage 数量；参考图少于槽位时，多余槽位保留模板默认值——**给模板里的 LoadImage 预置一张中性占位图**，或做一个只有 1–2 个槽位的变体模板。
- 视频模板输出节点用能落 mp4/webm 的（VHS SaveVideo 等）；图像用 SaveImage。工作台从 history 的 outputs 里抓 `images/gifs/videos` 三类。
- GPL 边界：只走 ComfyUI HTTP API，不派生其代码。
