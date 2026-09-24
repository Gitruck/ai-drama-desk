<div align="center">

<img src="brand/ai-animation-desk-logo.svg" width="128" alt="Gitruck AI Drama Desk logo">

# AI Drama Desk

<p><strong>Turn a storyboard into AI video clips you can review, export and lay back into an edit.</strong></p>
<p>Storyboard → Keyframe → I2V → Return package</p>

<p>
<a href="README.md">简体中文</a> ·
<a href="https://hocassian.feishu.cn/wiki/FRAKwUvBWib2vrkqZ5XcLDRqnOe">Tutorial</a> ·
<a href="https://api.ai-mcn.tv:9000/broadcast/exe/gitruck-ai-drama-desk-windows-x64.zip">Windows download</a> ·
<a href="https://github.com/Gitruck/ai-drama-desk">Source</a> ·
<a href="https://github.com/Gitruck/cli">gtrk CLI</a>
</p>

<p>
<img src="https://img.shields.io/badge/Windows-x64-2563eb?style=flat-square" alt="Windows x64">
<img src="https://img.shields.io/badge/Engine-cloud%20%7C%20ComfyUI%20%7C%20mock-111827?style=flat-square" alt="Cloud, ComfyUI and mock engines">
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-f43b48?style=flat-square" alt="MIT License"></a>
</p>

</div>

> **One-line positioning:** cloud by default, local when needed. AI Drama Desk turns <code>storyboard.md → Shot IR → keyframe → I2V → return-v1</code> into a production chain that can be checked at every step. The Windows package does not bundle Python, PyTorch, CUDA, ComfyUI or model weights; you can start with mock or cloud generation without a GPU.

**🔗 Guide:** [AI Drama Desk｜onboarding, cloud and local setup](https://hocassian.feishu.cn/wiki/FRAKwUvBWib2vrkqZ5XcLDRqnOe) · **⬇️ [Windows x64 download](https://api.ai-mcn.tv:9000/broadcast/exe/gitruck-ai-drama-desk-windows-x64.zip)**

~~~text
storyboard.md ──parse──▶ Shot IR ──per shot──▶ keyframe ──▶ I2V clip
                                                        │
        any NLE ◀── drag back and align ◀── return-v1 package + manifest
~~~

## Why AI Drama Desk

- **Storyboard in, clip package out.** Parse a Markdown storyboard into shot cards, generate candidates, pick the usable ones, and export a <code>return-v1</code> package with a manifest. File names preserve beat and shot identity: <code>&lt;slug&gt;-&lt;beatId&gt;-s&lt;n&gt;.mp4</code>.
- **Cloud first, local on demand.** Use PixMind cloud image/video generation by default. Download the standalone ComfyUI component only when local open models are required.
- **No GPU required to try it.** Mock engines need no model or cloud key. A PixMind key is enough for a fully cloud workflow, including H3 Eco video with native stereo audio.
- **Styles are reusable assets.** A style profile combines Style Lock text, negative prompts, anchor references and optional LoRA bindings. Import, export and reuse it across shows.
- **Built for agents.** The Web UI and CLI use the same HTTP API. The bundled skill can be installed into Claude Code, Codex, Cursor and other agents so an agent can drive the complete flow.

## Features

| | Capability | What it does |
|---|---|---|
| 📥 | Storyboard import | Parse Markdown into editable shot cards; repair fields in the UI when needed. |
| 🎭 | Character references | Keep reusable character references and feed either single-image or multi-image engines. |
| 🧑‍🎨 | Character sheets | Generate <code>single</code> portraits or <code>turnaround</code> reference sheets inside the desk. |
| 🖼️ | Keyframes | Generate, reroll and select a keyframe for every shot. |
| 🎞️ | I2V clips | Turn a selected keyframe into a video with ComfyUI, PixMind, fal.ai or mock engines. |
| 🤖 | Automatic completion | Generate missing references, keyframes and clips in sequence. |
| 📦 | Return package | Export clips plus <code>manifest.json</code> / <code>manifest.md</code> with measured duration and cost information. |
| 🎨 | Style assets | Create, import, export and bind style profiles and LoRAs. |
| 🧪 | LoRA training | Validate a dataset, run training jobs, recover checkpoints and publish a style binding. |
| 🩺 | ComfyUI diagnostics | Check service, runtime, workflow, node and model readiness without mutating the installation. |

## Install and quick start

### Windows portable package

The release package is cloud-first. Extract it and launch <code>Gitruck AI Drama Desk.exe</code>; local inference components are optional.

For repository development, use [Bun](https://bun.sh) and <code>ffmpeg</code> on your <code>PATH</code>:

~~~bash
git clone https://github.com/Gitruck/ai-drama-desk.git
cd ai-drama-desk
bun install
bun run start        # build the frontend and start http://127.0.0.1:7799
~~~

The first run uses <code>pixmind-image</code> and <code>pixmind-video</code>. Add <code>pixmindKey</code> in settings for cloud generation, or select mock engines for a zero-cost rehearsal.

The source CLI uses the same service:

~~~bash
bun run cli -- --help
bun run cli -- health --json
~~~

### Optional local ComfyUI

Most users do not need Python commands. Open **Settings & diagnostics → Local inference → Download local inference components**. The installer downloads and verifies the component, then switches versions atomically. Models stay outside the application package and can be moved to another local drive.

An existing ComfyUI installation can be detected at <code>http://127.0.0.1:8188</code>. AI Drama Desk communicates with it through the ComfyUI HTTP API; the cloud package remains independent from ComfyUI and its model weights.

For a fully custom development setup:

~~~bash
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
python -m venv venv
pip install -r requirements.txt
python main.py
~~~

The repository also contains a diagnostic startup helper:

~~~bash
python scripts/start-comfyui.py &lt;your-ComfyUI-directory&gt;
~~~

Model weights are not distributed by this repository. Obtain them from the original model publisher and review each license before use.

## Storyboard contract

The input is a Markdown storyboard produced by hand, an LLM or the [<code>/gtrk-ai-drama</code>](https://github.com/Gitruck/cli) skill. The parser is tolerant; fields can be repaired in the UI, or you can provide <code>shots.json</code> directly.

~~~markdown
# Lighthouse and the Mechanical Pigeon (beat B02)

- Total range: track_st 12.000 → track_ed 48.500 ≈ 36.5 seconds
- Suggested shots: 2

## Style Lock
> Hand-drawn illustration, desaturated warm grey palette, brass and misty blue accents.
> Avoid: photorealism, text and watermarks.

## Story
A lonely lighthouse keeper protects a mechanical pigeon on a stormy island.

## Characters
### The lighthouse keeper
An old keeper with a white beard and a weathered raincoat.

## Shots
### Shot 01 · Lighthouse wide ｜≈6s ｜stormy coast ｜no character
Silhouette of the lighthouse as the beam moves across the sea.

### Shot 02 · Keeper climbs the stairs ｜≈5s ｜lighthouse stairwell ｜keeper
The keeper carries a lamp up the spiral stairs.
~~~

The title carries the beat ID used by the return package. Each shot can include a duration, scene, characters and source-text reference. An optional English block can be filled by shot number.

## Production workflow

1. **Import** a storyboard Markdown file and review parser warnings.
2. **Add character references** once; the same references are reused across shots.
3. **Generate keyframes**, reroll individual cards and select the approved frame.
4. **Generate I2V clips** through ComfyUI, PixMind, fal.ai or mock.
5. **Complete missing assets** automatically when a shot has no reference or keyframe.
6. **Export the return package** to <code>exports/aidrama/</code>; drag the selected clips into any NLE and align them by beat.

## Engines

| Engine | Type | Dependency | Notes |
|---|---|---|---|
| <code>mock-image</code> / <code>mock-video</code> | Image / video | Local ffmpeg | Placeholder assets for a zero-GPU rehearsal. |
| <code>comfyui-image</code> / <code>comfyui-image2</code> | Image | Local ComfyUI | Reference-image and LoRA style lanes. |
| <code>seedream-image</code> | Image | <code>arkApiKey</code> | Multi-image reference input. |
| <code>pixmind-image</code> | Image | <code>pixmindKey</code> | Cloud image generation with no local model. |
| <code>comfyui-video</code> / <code>h3-video</code> / <code>hunyuan-video</code> | Video | Local ComfyUI | Local I2V lanes for different quality and speed targets. |
| <code>fal-video</code> | Video | <code>falKey</code> | Cloud Wan2.2 I2V lane. |
| <code>pixmind-video</code> | Video | <code>pixmindKey</code> | Cloud H3 Eco lane with native stereo audio. |

Cloud generation is recorded in the cost ledger. Keys stay in local <code>data/config.json</code>; the API only reports whether a key is configured.

## Style assets and CLI

~~~bash
bun run cli -- style create --file ./profile.json
bun run cli -- style import ./my-style.style-pack.json
bun run cli -- style export my-style --out ./pack.json
~~~

The same capabilities are available through the <code>style</code> and <code>lora</code> CLI commands. A style package does not include reference images or model weights by default.

## Use it with AI agents

The Web UI and CLI are clients of the same API at <code>http://127.0.0.1:7799/api/v1</code>. An agent can work with an existing project using its **API base and project ID**; it should query <code>/health</code> first, then <code>/projects/&lt;id&gt;</code>, instead of scanning the repository.

When a project has exported clips, <code>gtrk ai-drama lay</code> can place them back into a <code>.gtrk</code> project:

~~~bash
gtrk ai-drama lay --project ./my-video --desk-project &lt;project-id&gt;
~~~

Install the bundled skill into detected agents:

~~~bash
bun run cli -- skills install
bun run cli -- skills install --agents codex,cursor
bun run cli -- skills install --copy
~~~

See [<code>AGENT.md</code>](./AGENT.md) for the portable agent playbook and [gtrk CLI](https://github.com/Gitruck/cli) for the project-side workflow.

## Data, licensing and contributions

- <code>data/</code> contains projects, style profiles, generated artifacts and LoRA logs. It is local data and is not committed to Git.
- This repository does not distribute model weights. Obtain weights from their original publishers and check regional, commercial and redistribution terms.
- ComfyUI is GPL-3.0 and is integrated as an optional, separate process through its HTTP API.
- Source code is released under the [MIT License](LICENSE).

## Star History

<a href="https://star-history.com/#Gitruck/ai-drama-desk&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Gitruck/ai-drama-desk&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Gitruck/ai-drama-desk&type=Date" />
    <img alt="AI Drama Desk Star History" src="https://api.star-history.com/svg?repos=Gitruck/ai-drama-desk&type=Date" />
  </picture>
</a>

