import { EDITION_NOTICE } from "../../shared/contracts/index.ts";
import { DeskApiError } from "./api-client.ts";

export interface CliContext {
  json: boolean;
}

export function renderResult(ctx: CliContext, value: unknown, human?: string): string {
  if (ctx.json) return JSON.stringify(value);
  return human ?? JSON.stringify(value, null, 2);
}

export function printResult(ctx: CliContext, value: unknown, human?: string): void {
  console.log(renderResult(ctx, value, human));
}

export function printEditionNotice(ctx: CliContext): void {
  if (!ctx.json) console.error(`[${EDITION_NOTICE}]`);
}

export function fail(error: unknown, ctx: CliContext): never {
  const api = error instanceof DeskApiError ? error : undefined;
  const payload = { ok: false, error: error instanceof Error ? error.message : String(error), code: api?.code, status: api?.status };
  if (ctx.json) console.log(JSON.stringify(payload));
  else console.error(`错误：${payload.error}`);
  process.exit(api?.status === 0 ? 3 : api?.status === 409 ? 4 : 2);
}
