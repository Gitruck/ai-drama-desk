# ai-drama-desk · Agent Playbook

给 **agent** 看的操作手册：把用户「把这份分镜稿做成 AI 再现片段」的自然语言需求，落成对工作台
HTTP API / CLI 的一串调用，再把回轨包位置 + manifest 结论回给用户。任何 agent（Claude / Codex /
Cursor / …）读完这一份就能驱动整条闭环；`skills/gitruck-ai-drama-desk/` 里的 skill 只是这份
playbook 的薄壳。

> 这个工作台做的事：**分镜稿 md → 解析成分镜卡片 → 每镜 keyframe（参考图/LoRA 锁角色与画风）
> → I2V 出片抽卡 → 导出 return-v1 命名的回轨包（`<slug>-<beatId>-s<n>.mp4` + manifest）**。
> 本地 GPU（ComfyUI）做重活，云端出口（fal / 火山方舟）做备选，mock 引擎零模型演练全链路。
> 所有数据都是本地文件（`data/`），密钥不回显、媒体不外发。

---

## 0. 一句话流程

```
bun run start                                  # 起服务（构建前端 + API），http://127.0.0.1:7799
POST /api/v1/projects {storyboardMd,...}       # 投分镜稿建项目
POST /api/v1/projects/<id>/auto                # 全自动补齐（无图先出图，再接力出片）
GET  /api/v1/jobs?project=<id>                 # 轮询到全 done
POST /api/v1/projects/<id>/export              # 导出回轨包 + manifest
```

产物落在项目目录 `exports/aidrama/`，用户把满意的片段拖回自己的 NLE 按 beat 区间对齐。

---

## 1. 一次性准备（只做一次）

1. **装 bun**（运行时）：https://bun.sh ；mock 演练与导出实测另需本地 `ffmpeg`（PATH 可见）。
2. **拿到仓库**：`git clone https://github.com/Gitruck/ai-drama-desk.git && cd ai-drama-desk && bun install`。
3. **起服务**：`bun run start`；健康检查 `GET http://127.0.0.1:7799/api/v1/health`。
   服务地址非默认时设 `GITRUCK_AI_DRAMA_DESK_URL=http://<host>:<port>/api/v1`（CLI 读它）。
4. **首跑走 mock**：出图/出片引擎都用 `mock-image` / `mock-video`，零 GPU 零 Key 跑通全链路，再逐步接真引擎。
5. **（可选）本地引擎**：部署 ComfyUI（端口 8188）+ 按 README 模型清单落位权重 + `templates/` 模板登记；
   就绪度用只读诊断 `GET /api/v1/diagnostics/comfyui` 判断（五层：service/runtime/workflow/nodes/models）。
6. **（可选）云端出口**：`data/config.json` 填 `falKey`（fal.ai 出片）/ `arkApiKey`（火山方舟 Seedream 出图），
   字段模板见仓根 `config.example.json`；配置读写走 `GET/PUT /api/v1/config`（密钥只回「已配置」布尔值）。
7. **（可选）把 skill 装进本机 Agent**：`bun run cli -- skills install`（统一正本 `~/.agents/skills` →
   链接到检测出的各 Agent 兼容目录；`--agents codex,cursor` 指定宿主、`--copy` 回退复制）。

> agent 自检：任何有状态动作前先打 `/health`；服务没起就引导用户 `bun run start`，别自己猜端口。

---

## 2. 命令面

### 2.1 CLI（服务的瘦客户端，机器调用一律带 `--json`）

```bash
bun run cli -- health --json
bun run cli -- style <list|create|edit|delete|import|export>   # 画风资产
bun run cli -- lora  <train|status|resume|cancel|publish>      # LoRA 训练
bun run cli -- skills install [--agents ...] [--copy]          # 装 skill 到本机 Agent
```

| 命令 | 关键参数 | 说明 |
|---|---|---|
| `style list` | — | 列画风档案（带 LoRA 标记） |
| `style create` | `--file profile.json` | 自建画风（id 小写字母数字连字符） |
| `style edit <id>` | `--file patch.json` | 局部改档案 |
| `style delete <id>` | `--yes` 必带；`--replace-with <id>` 或 `--force` | 被项目引用时默认拒删 |
| `style export <id>` | `--out pack.json`；含参考图加 `--include-refs --license-confirmed` | 导风格包（默认不含图与权重） |
| `style import <pack>` | `--conflict error\|overwrite\|rename` | 导入风格包 |
| `lora train` | `--file training.json` | 先服务端提交前检查，缺项逐条报因后拒 |
| `lora status [id]` | `--json` | 全部/单个任务状态与进度 |
| `lora cancel <id>` | `--yes` | 先优雅中断、超时强停 |
| `lora resume <id>` | — | 从最新 checkpoint 建新任务 |
| `lora publish <id>` | `--style <style-id>` | 把权重 manifest（带 SHA-256）绑定到画风 |

### 2.2 HTTP API（`http://127.0.0.1:7799/api/v1`）

| 方法 · 路径 | 做什么 |
|---|---|
| `GET /health` | 存活检查 |
| `GET/PUT /config` | 读/改配置（脱敏；未显式提交密钥时保留旧值） |
| `GET /diagnostics/comfyui` | ComfyUI 五层只读诊断（不碰 `/prompt`、不加载大模型） |
| `GET/POST /styles`、`GET/PUT/DELETE /styles/<id>` | 画风档案 CRUD |
| `POST /styles/import`、`GET /styles/<id>/pack` | 风格包导入/导出 |
| `POST /projects` | 建项目：body `{storyboardMd, styleId?, slug?, name?}`（或预解析 `doc`）；返回 `{project, warnings}` |
| `GET /projects`、`GET /projects/<id>` | 项目列表/详情 |
| `POST /projects/<id>/characters/<名>/refs` | 上传角色源图（png/jpg/webp，≤20MB，按魔数校验） |
| `POST /projects/<id>/shots/<n>/keyframe` | 单镜出图：body `{provider?}`，默认 `comfyui-image` |
| `POST /projects/<id>/shots/<n>/video` | 单镜出片：body `{provider?}`，默认 `comfyui-video` |
| `POST /projects/<id>/shots/<n>/choose` | 选用某张图/某条片：body `{kind, file}` |
| `GET/DELETE /projects/<id>/shots/<n>/outputs/<kind>/<file>` | 删除前预览影响 / 永久删除（body 须 `confirmed:true`） |
| `POST /projects/<id>/auto` | 全自动补齐：body `{keyframeProvider?, videoProvider?}` |
| `GET /jobs?project=<id>` | 生成任务队列状态（轮询用） |
| `POST /projects/<id>/export` | 导出回轨包，返回 manifest |
| `GET/POST /lora/jobs`、`/lora/jobs/<id>/(cancel|resume|publish|log)`、`POST /lora/validate` | LoRA 训练面（同 CLI） |

**引擎取值（provider）**：出图 `mock-image` / `comfyui-image`（A 档参考图）/ `comfyui-image2`（B 档
LoRA，画风须绑定 manifest）/ `seedream-image`（需 `arkApiKey`）；出片 `mock-video` / `comfyui-video`
（Wan2.2 540p）/ `hunyuan-video`（HunyuanVideo 1.5 480p 蒸馏）/ `fal-video`（需 `falKey`）。
本地车道串行、云车道小并发、LoRA 训练与本地生成共享 GPU 租约（训练在跑时本地生成排队）。

---

## 3. 产物结构与取回

导出后（`POST /projects/<id>/export` 的返回即 manifest，同时落盘）：

```
data/projects/<id>/exports/aidrama/
├── <slug>-<beatId>-s1.mp4        # return-v1 命名：小写 slug + beat id + 镜序号
├── <slug>-<beatId>-s2.mp4
├── manifest.json                 # 机读：每镜 suggestedSec/measuredSec/deltaSec、skipped、totalCost
└── manifest.md                   # 人读同款
```

manifest 关键字段：`items[]`（每镜文件名、建议秒数 vs ffprobe 实测、差值 deltaSec、分辨率/fps）、
`skipped[]`（没有可导出视频的镜序号）、`totalSuggestedSec/totalMeasuredSec`、`totalCost`（云生成成本台账）、
`trackSt/trackEd`（分镜稿声明的回轨区间）。**回轨是手工环节**：由用户把片段拖进自己的 NLE 按区间对齐，
agent 只负责把差值大、被 skip 的镜明确点名。

---

## 4. Agent 决策清单（自然语言 → 调用）

1. **分镜稿在哪**：用户给 md 文件/文本 → `storyboardMd` 投稿；给的是结构化 `shots.json` → 走 `doc` 字段。
   都没有 → 先让用户产一份（格式见 README「输入契约」），别硬编。
2. **画风**：`style list` 看用户画风库；有就带 `styleId`，没有就引导「导入风格包或自建画风」，不擅自杜撰画风。
3. **引擎选择**：没配 ComfyUI/Key → mock 演练并明说这是占位产物；本地就绪 → comfyui 系；用户赶工或
   某镜动作复杂 → 该镜单发 `fal-video` 重 roll。B 档（`comfyui-image2`）只在当前画风绑了 LoRA 时可用。
4. **检查点留给用户**：传参考图、挑 keyframe、挑视频、删除确认——都是用户动作；agent 只驱动批次、
   报状态、转告 warnings（缺秒数/缺角色/超预算裁减点名等），不替用户拍审美。
5. **轮询与交代**：`/jobs` 轮询到全 done；失败逐条报错因（模板未配 / 模型缺失 / 服务离线），
   引导对应修复（`/diagnostics/comfyui`、README 模型清单、`data/config.json`）。
6. **导出后读 manifest 再说话**：deltaSec 偏差大的镜、skipped 的镜、totalCost——如实转告；
   不要只说「导出成功」。

---

## 5. 典型调用

```bash
# 起服务与体检
bun run start
curl http://127.0.0.1:7799/api/v1/health

# 投稿建项目（读本地分镜稿文件塞进 storyboardMd）
curl -X POST http://127.0.0.1:7799/api/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"storyboardMd":"<md 全文>","styleId":"my-style","slug":"lighthouse","name":"灯塔与机械信鸽"}'

# mock 全链路演练（零 GPU 零 Key）
curl -X POST http://127.0.0.1:7799/api/v1/projects/<id>/auto \
  -H "Content-Type: application/json" \
  -d '{"keyframeProvider":"mock-image","videoProvider":"mock-video"}'

# 单镜换云端重 roll
curl -X POST http://127.0.0.1:7799/api/v1/projects/<id>/shots/3/video \
  -H "Content-Type: application/json" -d '{"provider":"fal-video"}'

# 轮询 → 导出
curl "http://127.0.0.1:7799/api/v1/jobs?project=<id>"
curl -X POST http://127.0.0.1:7799/api/v1/projects/<id>/export
```

---

## 6. 排错

| 现象 | 处置 |
|---|---|
| CLI/API 连不上 | 服务没起 → `bun run start`；非默认地址 → 设 `GITRUCK_AI_DRAMA_DESK_URL` |
| ComfyUI 引擎报未配置/离线 | `GET /diagnostics/comfyui` 看五层哪层红：缺节点装插件重启、缺模型按 README 清单落位、模板未登记看 `templates/README.md` |
| B 档置灰 / 拒绝提交 | 当前画风没绑 LoRA manifest → `lora publish` 或手填画风 manifest 的 `weightsPath` |
| 云引擎报缺 Key | `data/config.json` 填 `falKey` / `arkApiKey`（或 `PUT /config`），密钥不会回显 |
| mock 出图/出片失败 | 本地 `ffmpeg` 不在 PATH → 装上或加进 PATH |
| 出场角色被裁减告警 | 引擎参考预算所限（A/B 档 3 张、Seedream 10 张）→ 转告用户被点名的角色，让用户调整参考集 |
| LoRA 一直 `blocked` | 本地生成队列占着 GPU 租约 / ComfyUI `/queue` 有任务 / 外部进程占显存 → 排空再跑 |
| 服务重启后训练任务变 `recoverable` | 不假定还在跑；`lora resume <id>` 从最新 checkpoint 续 |
| 导出 manifest 有 `skipped` | 对应镜没有任何视频产物 → 先补出片再重新导出 |

---

## 7. 扩展（给改仓库的 agent）

服务入口 `server/index.ts`（Bun HTTP，路由平铺）；解析器 `server/lib/parse.ts`（分镜稿 md → StoryboardDoc，
容错优先）；生成队列与车道并发 `server/lib/queue.ts`；引擎适配 `server/lib/providers/`（comfyui / fal /
seedream / mock，一引擎一文件）；导出 `server/lib/export.ts`（return-v1 命名 + ffprobe 实测）；LoRA 训练
`server/lib/lora/`。CLI 是 `cli/`（薄客户端，只打 HTTP API）；共享契约在 `shared/contracts/`。
新引擎 = providers 加一文件 + queue 分派一行 + `refPolicies`/`prices` 注册。
