# Skill 正本位置

本仓的 Agent skill 正本在 [`skills/gitruck-ai-drama-desk/SKILL.md`](skills/gitruck-ai-drama-desk/SKILL.md)（含触发词、命令式入口 `/gitruck-ai-drama-desk style` / `lora` / `health`、检查点工作流与安全铁律）。

安装到本机 Agent（Claude Code / Codex / Cursor / Gemini CLI 等）：

```bash
bun run cli -- skills install
```

平台无关的 agent playbook（不装 skill 也能驱动工作台全链路）见 [`AGENT.md`](AGENT.md)。
