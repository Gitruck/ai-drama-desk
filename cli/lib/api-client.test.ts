import { describe, expect, test } from "bun:test";
import { serviceUnavailableMessage } from "./api-client.ts";

describe("serviceUnavailableMessage", () => {
  test("回显实际 API 地址并区分地址检查与源码启动", () => {
    const message = serviceUnavailableMessage("http://desk.local:9000/api/v1");

    expect(message).toContain("http://desk.local:9000/api/v1");
    expect(message).toContain("GITRUCK_AI_DRAMA_DESK_URL");
    expect(message).toContain("工作台仓库或已安装发行物");
    expect(message).toContain("不要在磁盘中盲目查找仓库");
    expect(message).not.toContain("先运行 bun run start");
  });
});
