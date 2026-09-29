# 外部关键帧：导入、选择与审阅

用户指定宿主 Image2 等外部生图工具时，先在宿主按参考图生成，再用本接口落库。不把角色 refs 上传当成关键帧导入，也不直接写工作台 data。

仓库运行方式为 `bun run cli/index.ts`；已安装发行物可用对应工作台 CLI。以下 `<desk-cli>` 指该入口。

源码和 skill 更新不代表运行中的服务已热更新。新接口返回 404 时核对服务部署与版本；在确认无进行中的生成或训练任务后再协调重启，不直接写 data 绕过接口。

```sh
<desk-cli> keyframe import <project-id> <shot-index> <本地图片路径> --json
<desk-cli> keyframe choose <project-id> <shot-index> <返回的file> --json
<desk-cli> keyframe review <project-id> <shot-index> <审阅JSON路径> --json
<desk-cli> keyframe status <project-id> <shot-index> <返回的file> --json
```

导入支持可完整解码的单帧 PNG/JPEG/WebP，单文件不超过 20MB。返回内容哈希文件名；同一镜同一文件重复导入幂等。导入不自动选中、不自动验收、不生成视频。

逐镜实际看图后填写审阅 JSON：

```json
{
  "file": "imported-<sha256>.png",
  "status": "accepted",
  "reviewer": "本次审阅者",
  "sourceText": "当前镜头对应的原文句",
  "references": ["实际使用的角色或原作参考路径"],
  "findings": {
    "identity": "人物数量、身份、年龄与衣饰的具体结论",
    "scene": "空间、关系与剧情事件的具体结论",
    "objects": "关键道具比例、手部接触的具体结论",
    "motionReadiness": "适合下一步微动的动作与必须保持的部分"
  }
}
```

不通过填 `rejected`，不能复制空泛结论给整批镜头。纯空镜可明确写无角色参考及场景依据。服务端绑定图片哈希、分镜与本镜人物设定指纹，状态有 `unreviewed/accepted/rejected/stale`。选择图片不代表 accepted；修改图片内容、分镜、关联角色描述或 styleId 后旧审阅过期。外部导入图在视频入队与真正执行时均须 accepted。原有生成图仍兼容旧流程，但 Agent 同样应实际逐镜审阅，不把未设程序闸门当成免审阅。

API（相对 `/api/v1`）：

- `POST /projects/<id>/shots/<n>/keyframe/import`，multipart 单图片。
- `POST /projects/<id>/shots/<n>/keyframe/review`，上述 JSON。
- `GET /projects/<id>/shots/<n>/keyframe/review?file=<URL编码文件名>`。
- `POST /projects/<id>/shots/<n>/choose`，`{kind:"keyframe",file:"..."}`。

审阅闸校验的是记录完整性与文件身份，不能代替视觉判断，也不是要求每镜再向用户请示。用户已给风格与执行授权时，Agent 在授权范围内完成审阅；用户要求先看样片或逐步确认时遵守该节奏。

选择已通过图片后，按用户指定模型发起单镜 video。H3 provider 为 `h3-video` 或 `h3-video-final`，从 health 和当前模板确认可用性；不得把旧样片的分辨率、帧数当成固定接口。视频输出实际规格以探测为准。保留原母带时，回轨片段静音。

稀疏场景只生成派定的短镜头。`gtrk ai-drama pack` 产包，首次 lay、新增批次 lay --append，等规格换素材用 swap；不封缝，不拉伸填满，不覆盖用户已有手调。
