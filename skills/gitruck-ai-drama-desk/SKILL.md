---
name: gitruck-ai-drama-desk
description: AI 再现制片工作台（ai-drama-desk）的驱动 skill——把一份「分镜稿 md」投进本地工作台（http://127.0.0.1:7799），驱动「角色参考图（人设锚点）→ keyframe（参考图/LoRA 锁角色与画风）→ I2V 出片抽卡 → 导出 return-v1 命名回轨包」闭环，并管理画风资产、LoRA 训练与 ComfyUI 诊断。当用户想「把分镜稿投进工作台出片 / 用本地开源模型出 AI 再现 / 给角色出人设图或三视图 / 低成本出片 / 540p 抽卡 / 管理画风档案或风格包 / 训练画风 LoRA / 诊断 ComfyUI 就绪度」时使用本 skill。支持命令式参数：`/gitruck-ai-drama-desk charref` 出人设图、`/gitruck-ai-drama-desk style` 管画风、`/gitruck-ai-drama-desk lora` 管训练、`/gitruck-ai-drama-desk health` 查服务。产物是片段包（拖回任意 NLE），审美取舍（挑图/挑片）永远留给用户。
---

# gitruck-ai-drama-desk · AI 再现制片工作台驱动

## 一句话定位

上游是一份「分镜稿 md」（谁产的都行：手写、任何 LLM、或 gtrk 生态的 `/gtrk-ai-drama`）；本 skill 驱动本地工作台把它变成可回轨的视频片段包。出片在本地开源模型（ComfyUI）或云端出口，导出后用户手动拖回自己的 NLE。

## 前置

- **已有项目最小交接契约**：工作台 API 地址 + 项目 ID。默认 API Base 为 `http://127.0.0.1:7799/api/v1`，可被 `GITRUCK_AI_DRAMA_DESK_URL` 覆盖；项目 ID 让用户从项目页标题下方的「项目 ID · 复制」取得。
- 接管已有项目前先 `GET <base>/health`，再 `GET <base>/projects/<project-id>`。两者成功就直接走 HTTP API，**不需要知道仓库路径，也不许为此扫描磁盘找仓库**。
- API 不可达时先核对实际地址；服务确实未启动，就请用户在明确的工作台仓库/已安装发行物中启动，或提供准确路径。当前目录未知时不要直接执行 `bun run start`。
- 输入：一份符合契约的分镜稿 md（最小结构见仓库 README「输入契约」节）。没有 → 先让用户准备分镜稿，别硬解析不合契约的文本。
- 本地出图/出片需 ComfyUI（端口 8188）+ 模板与模型已配（见仓库 `templates/README.md` 与 README 模型清单）；没配时可先走 mock 或云端出口（fal / 火山方舟）。
- 完整 API 面与决策清单见仓库根 `AGENT.md`（本 skill 是它的薄壳）。

## 已有项目接管（API-first）

用户给出项目 ID 后，按这一顺序做：

1. 取 API Base：用户给出的地址 > `GITRUCK_AI_DRAMA_DESK_URL` > 默认地址。
2. `GET /health`；成功后 `GET /projects/<id>` 校验项目。
3. 直接调用目标 HTTP 端点；生成任务用 `GET /jobs?project=<id>` 轮询到终态。

核心端点：

| 目的 | HTTP API |
|---|---|
| 项目详情 | `GET /projects/<id>` |
| 生成人设锚点 | `POST /projects/<id>/characters/<URL编码角色名>/generate-ref`，body `{mode, provider?, count?, desc?}` |
| 上传宿主生图产物 | `POST /projects/<id>/characters/<URL编码角色名>/refs`，multipart 字段 `files` |
| 单镜出图/出片 | `POST /projects/<id>/shots/<n>/keyframe` / `POST /projects/<id>/shots/<n>/video` |
| 全自动补齐 | `POST /projects/<id>/auto` |
| 轮询 | `GET /jobs?project=<id>` |
| 导出 | `POST /projects/<id>/export` |

只有独立 CLI 已安装、仓库路径已经明确，或用户明确要求 CLI 时才用 `bun run cli -- ...`。CLI 是同一 API 的瘦客户端，不是已有项目接管的前置。

## 人设图的两条出图路线（歧义必问）

给角色出人设图/三视图有两条路线，**语义完全不同**：

| 路线 | 用户触发词 | 特点 | 你做 |
|---|---|---|---|
| **工作台生成（charref）** | 「用本地模型」「用工作台」「低成本出」「540p 抽卡」 | 画风锁（LoRA/Style Lock）、本地免费抽卡、产物直接落库 | API `POST .../generate-ref`；CLI 可用时也可 `charref <project> <角色名> --mode single\|turnaround` |
| **你自带的生图能力** | 「用你自己的生图能力」「用 image2」「用 GPT 画」「你来画」 | 生图质量与理解力强，适合出首套锚点 | 用宿主生图（prompt 模板见配套教程 2.7 节：角色描述从分镜稿整段抄 + 三视/单人布局词），再经 multipart refs API 落库；CLI 可用时也可 `refs upload` |

**铁律：用户只说「生成三视图/人设图」而没点名路线时，先问一句「用工作台管线（本地/云端模型），还是用我自带的生图能力？」——不许自选。** 两条路线产物最终都进该角色源图库与双参考集，后续挑图/裁剪一致。

## 调用入口（用户显式点名时，API 优先）

| 用户说 | 你做 |
|---|---|
| `/gitruck-ai-drama-desk charref`（或点名「用本地模型/工作台出三视图」） | `POST /projects/<id>/characters/<名>/generate-ref`，缺省 provider `comfyui-image`；轮询 `/jobs`。CLI 可直接调用时可用 `bun run cli -- charref ... --json`。**未点名路线时先按上节问一句** |
| `refs upload`（或宿主生图后「把图传进工作台」） | multipart `POST /projects/<id>/characters/<名>/refs`（png/jpg/webp ≤20MB，服务端魔数校验）；CLI 可用时可用 `bun run cli -- refs upload ... --json` |
| `/gitruck-ai-drama-desk style`（或「管画风/导风格包」） | 优先用 `/styles` 版本化 API；CLI 可直接调用时可用 `bun run cli -- style list \| create ...`，机器调用带 `--json` |
| `/gitruck-ai-drama-desk lora`（或「训个画风 LoRA」） | 优先用 `/lora/validate` 与 `/lora/jobs` API；CLI 可直接调用时可用 `bun run cli -- lora ... --json`；提交前检查缺项逐条报给用户 |
| `/gitruck-ai-drama-desk health`（或「服务活着吗」） | 直接 `GET <base>/health`；CLI 可用时也可 `health --json` |

## 工作流（agent 替用户跑，用户只在检查点出手）

1. **接管或投稿**：已有项目先用 `/health` + `/projects/<id>` 校验；新项目才 `POST /projects` body `{storyboardMd, styleId, slug, name}`。styleId 用用户画风库里的档案（`GET /styles` 先看有什么；没有就引导导入风格包或自建）。返回的 warnings 逐条转告用户（缺秒数/缺角色等）。
2. **备角色参考图（人设锚点）**（检查点）：角色一致性靠参考图 > 文字。三条路任选——① 用户已有设定图 → 工作台角色卡「上传」；② **工作台内生成（推荐，断档已补齐）**：调用 `/generate-ref`，`turnaround` 出三视图设定表、`single` 出单人立绘，产物直接落该角色源图库，即刻可挑可裁；缺画风/锚图/LoRA 也能出（A 档现成开源模型零前置兜底）；③ 外部工具（ChatGPT 等）出图后经 refs API 上传。本地 A/B 档挑一张在裁剪画布裁出单人主参考（三视图整图直喂给镜头有复制人物风险，故先裁）。出人设仍是检查点：挑图交用户。
3. **出图批次**：`POST /api/v1/projects/<id>/shots/<n>/keyframe` 或全自动 `POST /api/v1/projects/<id>/auto`。轮询 `GET /api/v1/jobs?project=<id>` 到全 done，失败逐条报错因。
4. **用户挑图**（检查点）：抽卡与选用在工作台点击完成，别替用户拍审美。
5. **出片批次**：同 auto/逐镜。默认本地 ComfyUI；用户嫌某镜动作塌 → 换 `fal-video` 重 roll 该镜。
6. **导出**：`POST /api/v1/projects/<id>/export` → 读 manifest 转告：实测 vs 建议时长差值、未导出的镜（skipped）、累计成本（totalCost）。
7. **交棒收口**：告知用户产物位置（项目目录 `exports/aidrama/`，`<slug>-<beatId>-s<n>.mp4`），由用户把满意的片段拖回自己的 NLE 按 beat 区间对齐。本 skill 在此停（回轨是手工环节）。

## 安全与操作铁律

1. **只经服务操作**：用 Web UI、CLI 或 HTTP API；不直接改 `data/`、不直接起 Trainer Python。
2. **不盲找仓库**：API + 项目 ID 足够时不搜索仓库；服务未启动且路径未知时向用户询问，不做宽范围磁盘扫描。
3. **不动上游**：分镜稿与用户工程文件只读；时码不改。
4. **导出命名不许偏**：`<slug>-<beatId>-s<n>.mp4`（return-v1），下游按名回轨。
5. **删除要预览确认**：媒体/画风的永久删除先复述影响再执行；不推断级联删除；删源候选前确认导出副本已在。
6. **GPU 租约**：LoRA 训练在跑时不发起本地 ComfyUI 生成（云端与 mock 不受限）。
7. **ComfyUI 诊断只读**：只用 `/system_stats`、`/object_info`、`/queue`；健康检查不提交 `/prompt`。
8. **秘密与大件本地化**：密钥、模型路径、数据集、参考图、生成媒体、LoRA 权重都是本地工件，不上传不外发；API 对密钥只回「已配置」布尔值。
9. **成本要报账**：每次云生成进成本台账；导出时把 totalCost 告诉用户。
10. **别装能保一致**：参考图 + Style Lock + LoRA 是尽力锁，不是保票；漂了就重 roll 或换参考图，别替模型辩护。
11. **不谎报成功**：以任务状态与产物文件为准，报 job id、状态、阻塞原因和下一步安全动作；进程存在不等于成功。
