import { createInterface } from "node:readline/promises";

export function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

export async function confirmOrThrow(args: string[], prompt: string): Promise<void> {
  if (hasFlag(args, "--yes")) return;
  if (!process.stdin.isTTY) throw new Error("破坏性操作需要 --yes，或在交互终端中确认");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${prompt} 输入 yes 继续：`);
    if (answer.trim().toLowerCase() !== "yes") throw new Error("操作已取消");
  } finally {
    rl.close();
  }
}

