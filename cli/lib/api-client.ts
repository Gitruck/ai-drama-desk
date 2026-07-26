import type { ApiErrorBody } from "../../shared/contracts/index.ts";

export class DeskApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly details?: unknown) {
    super(message);
  }
}

export function serviceUnavailableMessage(baseUrl: string): string {
  return [
    `工作台服务不可达：${baseUrl}。`,
    "先检查服务地址或 GITRUCK_AI_DRAMA_DESK_URL；",
    "若服务尚未启动，请在工作台仓库或已安装发行物中启动。",
    "当前目录未知时不要直接运行 bun run start，也不要在磁盘中盲目查找仓库。",
  ].join("");
}

export class DeskApiClient {
  constructor(
    public readonly baseUrl = process.env.GITRUCK_AI_DRAMA_DESK_URL ?? "http://127.0.0.1:7799/api/v1",
    private readonly timeoutMs = 15_000,
  ) {}

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(init?.headers ?? {}) },
        signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DeskApiError(serviceUnavailableMessage(this.baseUrl), 0, "SERVICE_UNAVAILABLE", error);
    }
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody | T;
    if (!response.ok) {
      const failure = body as ApiErrorBody;
      throw new DeskApiError(failure.error || `HTTP ${response.status}`, response.status, failure.code, failure.details);
    }
    return body as T;
  }
}
