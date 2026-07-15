import { describe, expect, it, vi } from "vitest";
import { createQqbotApiClient } from "./qqbot-api.ts";
import type { QqbotMessageKeyboard } from "./qqbot-types.ts";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") throw new Error("expected a JSON string request body");
  return JSON.parse(init.body) as unknown;
}

describe("createQqbotApiClient", () => {
  it("caches access tokens until near expiry", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const api = createQqbotApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.getAccessToken("app", "secret")).resolves.toBe("tok");
    await expect(api.getAccessToken("app", "secret")).resolves.toBe("tok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends C2C messages with QQBot authorization", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
          status: 200,
        });
      }
      expect(url).toContain("/v2/users/u1/messages");
      expect(init?.headers).toMatchObject({
        Authorization: "QQBot tok",
      });
      expect(requestBody(init)).toMatchObject({
        content: "hello",
        msg_id: "src",
        msg_type: 0,
      });
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    const api = createQqbotApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const token = await api.getAccessToken("app", "secret");
    await expect(api.sendC2CMessage(token, "u1", "hello", "src")).resolves.toEqual({ id: "m1" });
  });

  it("sends standalone Markdown replies without a keyboard", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: requestUrl(input), init });
      return new Response(JSON.stringify({ id: `m${requests.length}` }), { status: 200 });
    });
    const api = createQqbotApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.sendC2CMarkdownMessage("tok", "u/1", "## 回复\n\n你好", "source-c2c");
    await api.sendGroupMarkdownMessage("tok", "g/1", "## 回复\n\n你好", "source-group");

    expect(requests.map((entry) => entry.url)).toEqual([
      "https://api.sgroup.qq.com/v2/users/u%2F1/messages",
      "https://api.sgroup.qq.com/v2/groups/g%2F1/messages",
    ]);
    expect(requestBody(requests[0]?.init)).toMatchObject({
      markdown: { content: "## 回复\n\n你好" },
      msg_id: "source-c2c",
      msg_type: 2,
    });
    expect(requestBody(requests[1]?.init)).toMatchObject({
      markdown: { content: "## 回复\n\n你好" },
      msg_id: "source-group",
      msg_type: 2,
    });
  });

  it("allocates monotonically increasing sequences per passive source message", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(requestBody(init));
      return new Response(JSON.stringify({ id: `m${bodies.length}` }), { status: 200 });
    });
    const api = createQqbotApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.sendC2CMessage("tok", "u1", "one", "source-1");
    await api.sendC2CMarkdownMessage("tok", "u1", "two", "source-1");
    await api.sendC2CMarkdownMessage("tok", "u1", "final", "source-1", 4);
    await api.sendC2CMessage("tok", "u1", "after", "source-1");
    await api.sendC2CMessage("tok", "u1", "other", "source-2");

    expect(bodies).toMatchObject([
      { msg_id: "source-1", msg_seq: 1 },
      { msg_id: "source-1", msg_seq: 2 },
      { msg_id: "source-1", msg_seq: 4 },
      { msg_id: "source-1", msg_seq: 5 },
      { msg_id: "source-2", msg_seq: 1 },
    ]);
  });

  it("sends anchored C2C stream frames with both event and message ids", async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: requestUrl(input), body: requestBody(init) };
      return new Response(JSON.stringify({ id: "stream-1" }), { status: 200 });
    });
    const api = createQqbotApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.sendC2CStreamMessage("tok", "u/1", {
      input_mode: "replace",
      input_state: 1,
      content_type: "markdown",
      content_raw: "## 执行过程",
      event_id: "source-message",
      msg_id: "source-message",
      msg_seq: 1,
      index: 0,
    });

    expect(captured).toEqual({
      url: "https://api.sgroup.qq.com/v2/users/u%2F1/stream_messages",
      body: {
        input_mode: "replace",
        input_state: 1,
        content_type: "markdown",
        content_raw: "## 执行过程",
        event_id: "source-message",
        msg_id: "source-message",
        msg_seq: 1,
        index: 0,
      },
    });
  });

  it("uses the sandbox OpenAPI host when configured", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
          status: 200,
        });
      }
      expect(url).toBe("https://sandbox.api.sgroup.qq.com/gateway");
      return new Response(JSON.stringify({ url: "wss://sandbox.example" }), { status: 200 });
    });
    const api = createQqbotApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: "https://sandbox.api.sgroup.qq.com",
    });
    const token = await api.getAccessToken("app", "secret");
    await expect(api.getGatewayUrl(token)).resolves.toBe("wss://sandbox.example");
  });

  it("sends Markdown keyboards to C2C and group without rewriting callback data", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: requestUrl(input), init });
      return new Response(JSON.stringify({ id: `m${requests.length}` }), { status: 200 });
    });
    const api = createQqbotApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const keyboard: QqbotMessageKeyboard = {
      content: {
        rows: [
          {
            buttons: [
              {
                id: "approve",
                render_data: {
                  label: "批准",
                  visited_label: "已批准",
                  style: 1,
                },
                action: {
                  type: 1,
                  permission: { type: 0, specify_user_ids: ["u1"] },
                  data: " opaque-token:1 ",
                  unsupport_tips: "请升级 QQ",
                },
              },
            ],
          },
        ],
      },
    };

    await api.sendC2CMarkdownKeyboardMessage("tok", "u/1", {
      markdown: { content: "**请选择**" },
      keyboard,
      event_id: "evt-1",
    });
    await api.sendGroupMarkdownKeyboardMessage("tok", "g/1", {
      markdown: { content: "**请选择**" },
      keyboard,
    });

    expect(requests.map((entry) => entry.url)).toEqual([
      "https://api.sgroup.qq.com/v2/users/u%2F1/messages",
      "https://api.sgroup.qq.com/v2/groups/g%2F1/messages",
    ]);
    expect(requestBody(requests[0]?.init)).toEqual({
      markdown: { content: "**请选择**" },
      keyboard,
      msg_type: 2,
      msg_seq: 1,
      event_id: "evt-1",
    });
    expect(requestBody(requests[1]?.init)).toEqual({
      markdown: { content: "**请选择**" },
      keyboard,
      msg_type: 2,
      msg_seq: 1,
    });
  });

  it("acknowledges interactions with PUT and supports empty success bodies", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(input)).toBe(
        "https://api.sgroup.qq.com/interactions/click%2Fwith%2Fslashes",
      );
      expect(init?.method).toBe("PUT");
      expect(requestBody(init)).toEqual({ code: 3 });
      return new Response(null, { status: 204 });
    });
    const api = createQqbotApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(api.acknowledgeInteraction("tok", "click/with/slashes", 3)).resolves.toBe(
      undefined,
    );
  });
});
