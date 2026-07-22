---
name: gitruck-ai-drama-desk
description: AI 再现制片工作台（ai-drama-desk）的驱动 skill——把一份「分镜稿 md」投进本地工作台（http://127.0.0.1:7799），驱动「keyframe（参考图/LoRA 锁角色与画风）→ I2V 出片抽卡 → 导出 return-v1 命名回轨包」闭环，并管理画风资产、LoRA 训练与 ComfyUI 诊断。当用户想「把分镜稿投进工作台出片 / 用本地开源模型出 AI 再现 / 低成本出片 / 540p 抽卡 / 管理画风档案或风格包 / 训练画风 LoRA / 诊断 ComfyUI 就绪度」时使用本 skill。支持命令式参数：`/gitruck-ai-drama-desk style` 管画风、`/gitruck-ai-drama-desk lora` 管训练、`/gitruck-ai-drama-desk health` 查服务。产物是片段包（拖回任意 NLE），审美取舍（挑图/挑片）永远留给用户。
---

# gitruck-ai-drama-desk · AI 再现制片工作台驱动

## 一句话定位

上游是一份「分镜稿 md」（谁产的都行：手写、任何 LLM、或 gtrk 生态的 `/gtrk-ai-drama`）；本 skill 驱动本地工作台把它变成可回轨的视频片段包。出片在本地开源模型（ComfyUI）或云端出口，导出后用户手动拖回自己的 NLE。

## 前置

- 工作台服务在本机运行：仓库目录下 `bun run start`，健康检查 `GET http://127.0.0.1:7799/api/v1/health`（服务地址可被 `GITRUCK_AI_DRAMA_DESK_URL` 覆盖）。
- 输入：一份符合契约的分镜稿 md（最小结构见仓库 README「输入契约」节）。没有 → 先让用户准备分镜稿，别硬解析不合契约的文本。
- 本地出图/出片需 ComfyUI（端口 8188）+ 模板与模型已配（见仓库 `templates/README.md` 与 README 模型清单）；没配时可先走 mock 或云端出口（fal / 火山方舟）。
- 完整 API 面与决策清单见仓库根 `AGENT.md`（本 skill 是它的薄壳）。

## 命令式入口（用户显式点名时）

| 用户说 | 你做 |
|---|---|
| `/gitruck-ai-drama-desk style`（或「管画风/导风格包」） | 走 CLI：`bun run cli -- style list \| create --file p.json \| edit <id> --file patch.json \| delete <id> --yes \| import <pack.json> \| export <id> --out pack.json`，机器调用一律带 `--json` |
| `/gitruck-ai-drama-desk lora`（或「训个画风 LoRA」） | 走 CLI：`bun run cli -- lora train --file training.json \| status [id] \| resume <id> \| cancel <id> --yes \| publish <id> --style <style-id>`；train 前先跑提交前检查，缺文件/缺软件逐条报给用户 |
| `/gitruck-ai-drama-desk health`（或「服务活着吗」） | `bun run cli -- health --json`，或直接 `GET /api/v1/health` |

## 工作流（agent 替用户跑，用户只在检查点出手）

1. **投稿建项目**：`POST /api/v1/projects` body `{storyboardMd, styleId, slug, name}`。styleId 用用户画风库里的档案（`style list` 先看有什么；没有就引导导入风格包或自建）。返回的 warnings 逐条转告用户（缺秒数/缺角色等）。
2. **提醒传角色参考图**（检查点）：角色一致性靠参考图 > 文字。让用户在工作台给每个角色传设定图（没有可先跑一轮 keyframe，挑最像的当参考图回填——bootstrap 起盘）。本地 A/B 档需在裁剪画布裁出单人主参考，三视图整图直喂有复制人物风险。
3. **出图批次**：`POST /api/v1/projects/<id>/shots/<n>/keyframe` 或全自动 `POST /api/v1/projects/<id>/auto`。轮询 `GET /api/v1/jobs?project=<id>` 到全 done，失败逐条报错因。
4. **用户挑图**（检查点）：抽卡与选用在工作台点击完成，别替用户拍审美。
5. **出片批次**：同 auto/逐镜。默认本地 ComfyUI；用户嫌某镜动作塌 → 换 `fal-video` 重 roll 该镜。
6. **导出**：`POST /api/v1/projects/<id>/export` → 读 manifest 转告：实测 vs 建议时长差值、未导出的镜（skipped）、累计成本（totalCost）。
7. **交棒收口**：告知用户产物位置（项目目录 `exports/aidrama/`，`<slug>-<beatId>-s<n>.mp4`），由用户把满意的片段拖回自己的 NLE 按 beat 区间对齐。本 skill 在此停（回轨是手工环节）。

## 安全与操作铁律

1. **只经服务操作**：用 Web UI、CLI 或 HTTP API；不直接改 `data/`、不直接起 Trainer Python。
2. **不动上游**：分镜稿与用户工程文件只读；时码不改。
3. **导出命名不许偏**：`<slug>-<beatId>-s<n>.mp4`（return-v1），下游按名回轨。
4. **删除要预览确认**：媒体/画风的永久删除先复述影响再执行；不推断级联删除；删源候选前确认导出副本已在。
5. **GPU 租约**：LoRA 训练在跑时不发起本地 ComfyUI 生成（云端与 mock 不受限）。
6. **ComfyUI 诊断只读**：只用 `/system_stats`、`/object_info`、`/queue`；健康检查不提交 `/prompt`。
7. **秘密与大件本地化**：密钥、模型路径、数据集、参考图、生成媒体、LoRA 权重都是本地工件，不上传不外发；API 对密钥只回「已配置」布尔值。
8. **成本要报账**：每次云生成进成本台账；导出时把 totalCost 告诉用户。
9. **别装能保一致**：参考图 + Style Lock + LoRA 是尽力锁，不是保票；漂了就重 roll 或换参考图，别替模型辩护。
10. **不谎报成功**：以任务状态与产物文件为准，报 job id、状态、阻塞原因和下一步安全动作；进程存在不等于成功。
