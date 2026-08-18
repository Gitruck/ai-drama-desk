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
GET  /api/v1/health                            # 先确认工作台 API 可达
GET  /api/v1/projects/<id>                     # 已有项目先用用户复制的 ID 校验
POST /api/v1/projects {storyboardMd,...}       # 投分镜稿建项目
POST /api/v1/projects/<id>/auto                # 全自动补齐（无图先出图，再接力出片）
GET  /api/v1/jobs?project=<id>                 # 轮询到全 done
POST /api/v1/projects/<id>/export              # 导出回轨包 + manifest
```

产物落在项目目录 `exports/aidrama/`，用户把满意的片段拖回自己的 NLE 按 beat 区间对齐。

### 0.1 已有项目的最短接管路径

已有项目的最小交接信息只有两项：

- **API Base**：默认 `http://127.0.0.1:7799/api/v1`，非默认地址由用户给出或读取
  `GITRUCK_AI_DRAMA_DESK_URL`。
- **项目 ID**：用户在项目页标题下方点击「项目 ID · 复制」取得。

Agent 按以下顺序执行：

1. `GET <API Base>/health`
2. `GET <API Base>/projects/<project-id>`
3. 项目存在后，直接调用本手册 2.2 节的 HTTP API

前两步成功时，**不需要仓库路径，也不得为了接管项目扫描磁盘寻找仓库**。项目 ID 无效就请用户从
项目页重新复制；API 不可达就先核对地址。只有服务尚未启动、需要修改仓库，或只能从源码调用 CLI 时，
才需要用户提供明确仓库路径。

---

## 1. 一次性准备（只做一次）

本节只适用于安装/启动工作台。若 0.1 节的健康检查已成功，直接跳过本节。

1. **装 bun**（运行时）：https://bun.sh ；mock 演练与导出实测另需本地 `ffmpeg`（PATH 可见）。
2. **拿到仓库**：`git clone https://github.com/Gitruck/ai-drama-desk.git && cd ai-drama-desk && bun install`。
3. **起服务**：`bun run start`；健康检查 `GET http://127.0.0.1:7799/api/v1/health`。
   服务地址非默认时设 `GITRUCK_AI_DRAMA_DESK_URL=http://<host>:<port>/api/v1`（CLI 读它）。
4. **首跑走 mock**：出图/出片引擎都用 `mock-image` / `mock-video`，零 GPU 零 Key 跑通全链路，再逐步接真引擎。
5. **（可选）本地引擎**：部署 ComfyUI（端口 8188）+ 按 README 模型清单落位权重 + `templates/` 模板登记；
   就绪度用只读诊断 `GET /api/v1/diagnostics/comfyui` 判断（五层：service/runtime/workflow/nodes/models）。
6. **（可选）云端出口**：`data/config.json` 填 `pixmindKey`（PixMind 出片+出图，无本地 GPU 时的首选）/
   `falKey`（fal.ai 出片）/ `arkApiKey`（火山方舟 Seedream 出图），字段模板见仓根 `config.example.json`；
   配置读写走 `GET/PUT /api/v1/config`（密钥只回「已配置」布尔值）。PixMind Key 取自
   `pixmind.io/api-platform/dashboard/keys`（最小权限、可配预算限流），**只在创建时显示一次**；
   拿 Key 的完整步骤见 README「PixMind API Key 怎么拿」，agent 不要代用户创建 Key。
7. **（可选）把 skill 装进本机 Agent**：`bun run cli -- skills install`（统一正本 `~/.agents/skills` →
   链接到检测出的各 Agent 兼容目录；`--agents codex,cursor` 指定宿主、`--copy` 回退复制）。

> agent 自检：任何有状态动作前先打 `/health`；服务没起时，请用户在明确的工作台仓库或已安装发行物中
> 启动服务。当前目录与仓库路径未知时，不直接运行 `bun run start`，也不做宽范围磁盘扫描。

---

## 2. 命令面

### 2.1 CLI（服务的瘦客户端，机器调用一律带 `--json`）

仅在独立 CLI 已安装、仓库路径已知，或用户明确要求 CLI 时走这一层；仅掌握 API Base + 项目 ID 时直接走
2.2 节，不把缺少仓库 cwd 当成阻塞。

```bash
bun run cli -- health --json
bun run cli -- charref <project> <角色名> --mode single|turnaround  # 角色参考图（人设锚点）
bun run cli -- refs upload <project> <角色名> <文件...>              # 外部/宿主生图产物落库
bun run cli -- style <list|create|edit|delete|import|export>   # 画风资产
bun run cli -- lora  <train|status|resume|cancel|publish>      # LoRA 训练
bun run cli -- skills install [--agents ...] [--copy]          # 装 skill 到本机 Agent
```

| 命令 | 关键参数 | 说明 |
|---|---|---|
| `charref <project> <角色名>` | `--mode single\|turnaround`；`--provider`（缺省 comfyui-image）；`--count N`；`--desc` | 生成人设锚点：single 单人立绘（完成自动设主参考）/ turnaround 三视图设定表；产物落角色源图库即刻可挑可裁；A 档零前置兜底。**注意**：这是「工作台管线」路线；用户想用 agent 宿主自带生图能力时不走本命令，宿主出图后用 `refs upload` 落库；用户未点名路线时先问 |
| `refs upload <project> <角色名> <文件...>` | — | 把本地图片（宿主/外部生图产物）经服务端校验上传进该角色源图库，即刻进双参考集 |
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
| `POST /projects/<id>/characters/<名>/generate-ref` | 生成人设锚点：body `{mode:"single"\|"turnaround", provider?, count?, desc?}`；产物落源图库、即刻进双参考集 |
| `POST /projects/<id>/shots/<n>/keyframe` | 单镜出图：body `{provider?}`，默认 `comfyui-image` |
| `POST /projects/<id>/shots/<n>/video` | 单镜出片：body `{provider?}`，默认 `comfyui-video` |
| `POST /projects/<id>/shots/<n>/choose` | 选用某张图/某条片：body `{kind, file}` |
| `GET/DELETE /projects/<id>/shots/<n>/outputs/<kind>/<file>` | 删除前预览影响 / 永久删除（body 须 `confirmed:true`） |
| `POST /projects/<id>/auto` | 全自动补齐：body `{keyframeProvider?, videoProvider?}` |
| `GET /jobs?project=<id>` | 生成任务队列状态（轮询用） |
| `POST /projects/<id>/export` | 导出回轨包，返回 manifest |
| `GET/POST /lora/jobs`、`/lora/jobs/<id>/(cancel|resume|publish|log)`、`POST /lora/validate` | LoRA 训练面（同 CLI） |

**引擎取值（provider）**：出图 `mock-image` / `comfyui-image`（A 档参考图）/ `comfyui-image2`（B 档
LoRA，画风须绑定 manifest）/ `seedream-image`（需 `arkApiKey`）/ `pixmind-image`（需 `pixmindKey`，
默认 Nano Banana 2 Eco、多图直喂预算 14）；出片 `mock-video` / `comfyui-video`
（Wan2.2 540p）/ `h3-video`（MiniMax H3 抽卡档，4 步 Turbo，出片带原生立体声、固定 24fps）/
`h3-video-final`（MiniMax H3 成片档，12 步 + SigmaShift，同带立体声；与抽卡档是两个独立出口，
切档不承诺同 seed 复现同一条，5 秒片约 2 倍耗时、15 秒长镜约 5 分钟）/
`hunyuan-video`（HunyuanVideo 1.5 480p 蒸馏）/ `fal-video`（需 `falKey`）/
`pixmind-video`（需 `pixmindKey`，默认 MiniMax H3 Eco、4–15 秒、**出片带原生立体声**、零本地依赖）。
**用户没有本地 GPU 时，首选 `pixmind-image` + `pixmind-video` 这对全云组合**（一把 Key 两条链路）。
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

manifest 关键字段：`items[]`（每镜文件名、源候选名 `sourceFile`、建议秒数 vs ffprobe 实测、差值 deltaSec、
分辨率/fps、`fallbackFrom`）、`skipped[]`（没有产出导出文件的镜序号）、`skippedDetail[]`（与 `skipped` 同序，
逐条给出中文 `reason` 与丢失的 `lostChoice`）、`totalSuggestedSec/totalMeasuredSec`、`totalCost`（云生成成本台账）、
`trackSt/trackEd`（分镜稿声明的回轨区间）。**回轨是手工环节**：由用户把片段拖进自己的 NLE 按区间对齐，
agent 只负责把差值大、被 skip 的镜明确点名。

**悬空选中**：`choices` 是 `project.json` 里的持久指针，产物被删/清盘/换机器后会指向已不在盘上的文件。
导出遇到这种镜**不会整包失败**——有其余候选就回落（该条 `fallbackFrom` 记下丢失的原选中名，`sourceFile`
是这次实际用的候选），没有候选就计入 `skipped` 并在 `skippedDetail` 里说明。工作台**不会替用户改写
`choices`**：把文件放回原处，下次导出自动恢复按原选中项走。

---

## 4. Agent 决策清单（自然语言 → 调用）

1. **先判断是已有项目还是新投稿**：用户给了项目 ID → 按 0.1 节检查 `/health` 与
   `/projects/<id>`，成功后直接走 API，不找仓库；没有项目 ID 但明确指向工作台里的项目 → 请用户从项目页复制，
   或用 `GET /projects` 列出候选后让用户确认，不能按项目名称猜。
2. **分镜稿在哪**：新投稿时，用户给 md 文件/文本 → `storyboardMd` 投稿；给的是结构化 `shots.json` → 走 `doc` 字段。
   都没有 → 先让用户产一份（格式见 README「输入契约」），别硬编。
3. **画风**：`GET /styles` 或 `style list` 看用户画风库；有就带 `styleId`，没有就引导「导入风格包或自建画风」，不擅自杜撰画风。
4. **引擎选择**：没配 ComfyUI/Key → mock 演练并明说这是占位产物；本地就绪 → comfyui 系；用户赶工或
   某镜动作复杂 → 该镜单发 `fal-video` 重 roll。B 档（`comfyui-image2`）只在当前画风绑了 LoRA 时可用。
5. **检查点留给用户**：传参考图、挑 keyframe、挑视频、删除确认——都是用户动作；agent 只驱动批次、
   报状态、转告 warnings（缺秒数/缺角色/超预算裁减点名等），不替用户拍审美。
6. **轮询与交代**：`/jobs` 轮询到全 done；失败逐条报错因（模板未配 / 模型缺失 / 服务离线），
   引导对应修复（`/diagnostics/comfyui`、README 模型清单、`data/config.json`）。
7. **导出后读 manifest 再说话**：deltaSec 偏差大的镜、`skippedDetail` 的逐条原因、`fallbackFrom`
   的回落镜、totalCost——如实转告；不要只说「导出成功」。回落的镜要点名「这不是用户挑的那条」。

---

## 5. 典型调用

```bash
# 已有项目：先体检与校验，不需要仓库 cwd
API_BASE="${GITRUCK_AI_DRAMA_DESK_URL:-http://127.0.0.1:7799/api/v1}"
PROJECT_ID="<project-id>"
curl "$API_BASE/health"
curl "$API_BASE/projects/$PROJECT_ID"

# 人设三视图：直调 API → 轮询
curl -X POST "$API_BASE/projects/$PROJECT_ID/characters/%E7%88%B6%E4%BA%B2/generate-ref" \
  -H "Content-Type: application/json" \
  -d '{"mode":"turnaround","provider":"comfyui-image","count":1}'
curl "$API_BASE/jobs?project=$PROJECT_ID"

# 投稿建项目（读本地分镜稿文件塞进 storyboardMd）
curl -X POST "$API_BASE/projects" \
  -H "Content-Type: application/json" \
  -d '{"storyboardMd":"<md 全文>","styleId":"my-style","slug":"lighthouse","name":"灯塔与机械信鸽"}'

# mock 全链路演练（零 GPU 零 Key）
curl -X POST "$API_BASE/projects/$PROJECT_ID/auto" \
  -H "Content-Type: application/json" \
  -d '{"keyframeProvider":"mock-image","videoProvider":"mock-video"}'

# 单镜换云端重 roll
curl -X POST "$API_BASE/projects/$PROJECT_ID/shots/3/video" \
  -H "Content-Type: application/json" -d '{"provider":"fal-video"}'

# 无本地 GPU 的用户：全云出片（一把 pixmindKey 走完出图 + 出片）
curl -X POST "$API_BASE/projects/$PROJECT_ID/auto" \
  -H "Content-Type: application/json" \
  -d '{"keyframeProvider":"pixmind-image","videoProvider":"pixmind-video"}'

# 轮询 → 导出
curl "$API_BASE/jobs?project=$PROJECT_ID"
curl -X POST "$API_BASE/projects/$PROJECT_ID/export"
```

---

## 6. 排错

| 现象 | 处置 |
|---|---|
| CLI/API 连不上 | 先核对实际 API Base 与 `GITRUCK_AI_DRAMA_DESK_URL`；服务确实没起时，请用户在明确的工作台仓库/发行物中启动。路径未知就询问，不盲扫磁盘、不在未知 cwd 执行 `bun run start` |
| ComfyUI 引擎报未配置/离线 | `GET /diagnostics/comfyui` 看五层哪层红：缺节点装插件重启、缺模型按 README 清单落位、模板未登记看 `templates/README.md` |
| B 档置灰 / 拒绝提交 | 当前画风没绑 LoRA manifest → `lora publish` 或手填画风 manifest 的 `weightsPath` |
| 云引擎报缺 Key | `data/config.json` 填 `pixmindKey` / `falKey` / `arkApiKey`（或 `PUT /config`），密钥不会回显 |
| PixMind 报 `不支持的模型` | 该线路未接入网关生成路由（与模型目录收录无关）→ 换 `pixmindVideoModel` / `pixmindImageModel` 为已接线线路，或找平台方接线；错误文案原样来自网关 |
| H3 成片档「像卡住了」 | 多半没卡：`h3-video-final` 是 12 步档，5 秒片约 88 秒，**15 秒长镜约 5 分钟**（帧数只涨 2.9 倍、耗时涨 3.8 倍，注意力开销超线性，别拿 5 秒片的数线性外推）。先看 `GET /jobs` 是否仍 `running`；真要快就用 `h3-video` 抽卡档 |
| 用户问「成片档是不是更好」 | 两档是**两个独立出口**，只是投入更多算力；切档不承诺同 seed 复现同一条（换配方即换采样轨迹，出来的是另一条）。如实说明差异，别替用户判优劣 |
| 本地任务没按提交顺序开跑 | **预期行为，不是 bug**。local 车道按权重亲和排序：吃同一组模型权重的任务会被凑在一起连跑，省掉整组权重反复从盘重读（实测每换一次 13–20 秒、30–34 GiB）。被插队的任务有次数上限兜底，不会饿死 |
| 任务一直显示「排队」 | 看 chip 上的根因：写「等 LoRA 训练释放 GPU」就是训练占着租约，等它或先停训练；只写「排队」则是本车道已满（local 车道恒串行），正常等即可 |
| 想看真采样进度条 | 工作台只报阶段（上传/已提交/生成中/下载产物）不报百分比——主力模板都是少步蒸馏，逐步进度只有几个 tick，而吃墙钟的模型加载与 VAE 解码不发进度事件，画出来是假精确。要看逐步进度就开自己那个 ComfyUI 网页，本工作台的任务现在会显示在里面 |
| 任务失败了想知道该干嘛 | `GET /jobs` 的 `failureKind` 直接说清该做什么：`config`=改配置/补模型（错误文案会点名缺哪个）、`resource`=显存不足，降分辨率或帧数、`content`=输入被拒，换输入、`transient`=服务抖动，可重试、`cloud-billed`=云端已建单已扣费，**别重试**、`unknown`=没分出来，按文案人工判 |
| 任务显示「等待重试」 | 本地推理服务抖了一下，系统会自动再试一次（退避 5 秒）。**只有本地 transient 失败才自动重试**——云出口一条都不重试（已建单即已扣费）、OOM 与配置错也不重试。想关掉：`data/config.json` 设 `autoRetryLimit: 0` |
| mock 出图/出片失败 | 本地 `ffmpeg` 不在 PATH → 装上或加进 PATH |
| 出场角色被裁减告警 | 引擎参考预算所限（A/B 档 3 张、Seedream 10 张、PixMind 14 张）→ 转告用户被点名的角色，让用户调整参考集 |
| LoRA 一直 `blocked` | 本地生成队列占着 GPU 租约 / ComfyUI `/queue` 有任务 / 外部进程占显存 → 排空再跑 |
| 服务重启后训练任务变 `recoverable` | 不假定还在跑；`lora resume <id>` 从最新 checkpoint 续 |
| 导出 manifest 有 `skipped` | 读 `skippedDetail[].reason`：没有任何视频产物 → 先补出片再重新导出；选中产物已丢失且无其余候选 → 该镜必须重新出片 |
| manifest 报「选中产物已丢失，已回落」 | 悬空选中（产物被删/清盘/换机器，`choices` 指针还在）。片段可用但**不是用户挑的那条**——转告后让用户回工作台重挑或重出；把原文件放回该镜目录则下次导出自动恢复。工作台不会自动改 `choices` |

---

## 7. 扩展（给改仓库的 agent）

服务入口 `server/index.ts`（Bun HTTP，路由平铺）；解析器 `server/lib/parse.ts`（分镜稿 md → StoryboardDoc，
容错优先）；生成队列与车道并发 `server/lib/queue.ts`；引擎适配 `server/lib/providers/`（comfyui / fal /
seedream / mock，一引擎一文件）；导出 `server/lib/export.ts`（return-v1 命名 + ffprobe 实测）；LoRA 训练
`server/lib/lora/`。CLI 是 `cli/`（薄客户端，只打 HTTP API）；共享契约在 `shared/contracts/`。
新引擎 = providers 加一文件 + queue 分派一行 + `refPolicies`/`prices` 注册。
