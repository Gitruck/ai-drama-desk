# 风格 LoRA 固化 · 运行手册（路径B）

> 目标：把你的画风烤进 LoRA，推理时参考图槽位全留给角色一致性、画风由 LoRA 扛。
> **老实说：这条是实验路径，多小时、结果不保证。** 而且如果你的角色定妆图本身就是目标画风，
> 风格 LoRA 的边际价值主要在「想喂非目标画风参考图（真人照）→ 渲成目标画风」或「更强跨镜风格锁」。
> 想清楚值不值再投时间；路径 A（参考图）/ C（Seedream）已经能出好图。
>
> 下文命令中的路径占位：`<你的训练器目录>` = musubi-tuner 克隆目录、`<你的模型目录>` = ComfyUI 的 models 目录、
> `<你的仓库目录>` = 本仓库克隆目录、`<你的锚图目录>` = 风格锚定参考图目录。触发词示例用 `example style`，
> 请换成你自己的（建议不成词的生造词，防底模先验污染）。

## 结论依据（调研 + 实测）

- musubi 训 Qwen-Image-Edit **要 control→target 配对**，不能单图硬训（否则报 `Item must have control content`）。
- 「锚图换主体造 target」实测**失败**：编辑模型死保锚图构图，出四不像 → 已弃用。
- 「把成品图去风格化造 control」实测**太弱**：只渲细了点、没变照片、内容还漂 → 已弃用。
- **v1 采用**：真实风格成品图当 target + **纯黑 control**（社区 issue #682 实测黑控能出触发词风格 LoRA，
  等价于在 edit 模型上做 T2I 风格训练，最省事最稳）。

## 数据集

```bash
python lora/dataset_assemble.py --anchors <你的锚图目录> --trigger "example style"
# 锚图+工作台keyframe ×翻转，黑control，触发词caption
# 想更大：用工作台路径A/Seedream 多出几十张不同场景的同风格图，--extra <dir> 纳入再重跑
```
产物：`lora/dataset/img/`（target+caption）、`lora/dataset/control/`（黑图）。**三四十张偏少、易过拟合**，
想要泛化好建议攒到 60–80 张真图。

数据集配置：复制 `lora/dataset.example.toml` 为 `lora/dataset.toml`，把占位路径换成实际绝对路径。

## 训练三步（musubi-tuner，24G 显存档）

### 前置一次性

1. **装 musubi 包**（uv 装进已有 venv，保留已装的 torch）：
   ```bash
   uv pip install --python <你的训练器目录>/venv/Scripts/python.exe -e <你的训练器目录>
   ```
2. **训练权重**（推理用的是 lightning 融合 fp8，训练必须用非融合 bf16）：
   - DiT `<你的模型目录>/diffusion_models/qwen_image_edit_2511_bf16.safetensors`（40.9GB）
   - 文本编码器 `<你的模型目录>/text_encoders/qwen_2.5_vl_7b.safetensors`（16.6GB）
   - VAE `<你的模型目录>/vae/qwen_image_vae.safetensors`

### 第 1 步 · 预缓存（latent + 文本编码器输出）

```bash
cd <你的训练器目录>
./venv/Scripts/python.exe src/musubi_tuner/qwen_image_cache_latents.py \
  --dataset_config <你的仓库目录>/lora/dataset.toml \
  --vae <你的模型目录>/vae/qwen_image_vae.safetensors \
  --model_version edit-2511

./venv/Scripts/python.exe src/musubi_tuner/qwen_image_cache_text_encoder_outputs.py \
  --dataset_config <你的仓库目录>/lora/dataset.toml \
  --text_encoder <你的模型目录>/text_encoders/qwen_2.5_vl_7b.safetensors \
  --batch_size 1 --model_version edit-2511 --fp8_vl
```

### 第 2 步 · 训练（24G 显存红线：fp8_base + fp8_scaled + blocks_to_swap）

```bash
cd <你的训练器目录>
./venv/Scripts/accelerate.exe launch --num_cpu_threads_per_process 1 --mixed_precision bf16 \
  src/musubi_tuner/qwen_image_train_network.py \
  --dit <你的模型目录>/diffusion_models/qwen_image_edit_2511_bf16.safetensors \
  --vae <你的模型目录>/vae/qwen_image_vae.safetensors \
  --text_encoder <你的模型目录>/text_encoders/qwen_2.5_vl_7b.safetensors \
  --model_version edit-2511 \
  --dataset_config <你的仓库目录>/lora/dataset.toml \
  --sdpa --mixed_precision bf16 \
  --fp8_base --fp8_scaled --blocks_to_swap 24 \
  --timestep_sampling shift --weighting_scheme none --discrete_flow_shift 2.2 \
  --optimizer_type adamw8bit --learning_rate 1e-4 --gradient_checkpointing \
  --max_data_loader_n_workers 2 --persistent_data_loader_workers \
  --network_module networks.lora_qwen_image --network_dim 32 --network_alpha 16 \
  --max_train_epochs 16 --save_every_n_steps 100 --save_state --seed 42 \
  --output_dir <你的仓库目录>/lora/output --output_name example_style_v1
```

- 24G 卡上 `--fp8_base --fp8_scaled --blocks_to_swap 24` 留出更稳妥的 WDDM 显存余量；20 blocks 实测会在大 bucket 上触发显存换页抖动。
- 参数是社区区间起点，非圣旨（musubi 官方原话「最优值未知」）：风格太弱升 lr 到 1.5e-4 或 dim 到 64；记住内容（出图老带同一场景）就降 epoch / 加数据。
- 36 张 ×4 repeats ×16 epoch = 2304 步，4090 级单卡实测约 12–15 小时。
- 每 100 步同时保存 LoRA 和 optimizer state。当前 musubi 的 Qwen trainer 恢复 optimizer/dataloader 后，
  用于命名的 `global_step` 仍会从 0 计数；续训时必须同时：①把 `--max_train_steps` 改成剩余步数；
  ②换一个不会覆盖旧权重的 `--output_name`。例如从 step 300 恢复：
  `--max_train_steps 2004 --output_name example_style_v1-r300 --resume <output>/example_style_v1-step00000300-state`。
  此时 `r300-step00000100` 代表总训练步数 400。

### 第 3 步 · 接回工作台 A/B/C 对比

1. 选择 `lora/output/example_style_v1-stepXXXXXXXX.safetensors` → 复制到 `<你的模型目录>/loras/`
2. 复制 `templates/qwen-edit-keyframe.json` 为 `qwen-edit-keyframe-lora.json`，加一个
   `LoraLoaderModelOnly` 节点（接在 UNETLoader 之后、喂给 ModelSamplingAuraFlow），
   lora_name 指向上面文件、strength 0.8–1.0（仓内已带一份该模板，改 lora_name 即可用）。
3. 工作台「设置」把 `comfyImage2` 指向该模板、`promptPrefix` 填你的触发词；
   出图时 comfyui-image2 provider 会自动在业务 prompt 前追加触发词。
4. 同一镜三档各出 3 张，按你的画风自检清单比：①画风贴合 ②角色像不像 ③听不听分镜稿。
   账：路径A/B 本地 ≈0；路径C Seedream ≈¥0.3/张。

## 判断 LoRA 值不值

看 B 相对 A 有没有肉眼可见的增益：跨镜风格更稳？能吃非目标画风参考图？若没明显好处，
说明你的定妆图 + 路径A 已经够用，LoRA 可以搁置。
