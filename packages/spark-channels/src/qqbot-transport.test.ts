import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import type { QqbotApiClient } from "./qqbot-api.ts";
import { createQqbotTransport, type QqbotGatewayCursor } from "./qqbot-transport.ts";
import type { QqbotAdapterConfig } from "./types.ts";

const config: QqbotAdapterConfig = {
  type: "qqbot",
  app_id: "app",
  client_secret: "secret",
};

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

function createApiMock() {
  const getAccessToken = vi.fn(async () => "token");
  const getGatewayUrl = vi.fn(async () => "wss://gateway.example");
  const sendC2CMarkdownMessage = vi.fn(async () => ({ id: "reply-c2c" }));
  const sendGroupMarkdownMessage = vi.fn(async () => ({ id: "reply-group" }));
  const sendC2CMarkdownKeyboardMessage = vi.fn(async () => ({ id: "ask-c2c" }));
  const sendGroupMarkdownKeyboardMessage = vi.fn(async () => ({ id: "ask-group" }));
  const sendC2CStreamMessage = vi.fn(async () => ({ id: "stream" }));
  const sendChannelMessage = vi.fn(async () => ({ id: "text-channel" }));
  const acknowledgeInteraction = vi.fn(async () => undefined);
  let messageSequence = 0;
  const api: QqbotApiClient = {
    nextMessageSequence: vi.fn(() => {
      messageSequence += 1;
      return messageSequence;
    }),
    getAccessToken,
    getGatewayUrl,
    sendC2CMessage: vi.fn(async () => ({ id: "text-c2c" })),
    sendGroupMessage: vi.fn(async () => ({ id: "text-group" })),
    sendC2CMarkdownMessage,
    sendGroupMarkdownMessage,
    sendC2CMarkdownKeyboardMessage,
    sendGroupMarkdownKeyboardMessage,
    sendChannelMessage,
    sendC2CStreamMessage,
    acknowledgeInteraction,
  };
  return {
    api,
    getAccessToken,
    getGatewayUrl,
    sendC2CMarkdownMessage,
    sendGroupMarkdownMessage,
    sendC2CMarkdownKeyboardMessage,
    sendGroupMarkdownKeyboardMessage,
    sendC2CStreamMessage,
    sendChannelMessage,
    acknowledgeInteraction,
  };
}

describe("createQqbotTransport", () => {
  it("reconnects when the gateway stops acknowledging heartbeats", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const { api } = createApiMock();
    const transport = createQqbotTransport(config, {
      api,
      connectTimeoutMs: 100,
      reconnectDelaysMs: [1],
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    try {
      const starting = transport.start(() => undefined);
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emit(
        "message",
        Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 10 } })),
      );
      await starting;

      await vi.advanceTimersByTimeAsync(10);
      expect(JSON.parse(sockets[0]?.sent.at(-1) ?? "{}")).toMatchObject({ op: 1 });
      await vi.advanceTimersByTimeAsync(11);
      expect(sockets).toHaveLength(2);
      expect(transport.status?.()).toMatchObject({ state: "connecting" });
    } finally {
      await transport.stop();
      vi.useRealTimers();
    }
  });

  it("times out a missing Gateway Hello and retries the initial connection", async () => {
    const sockets: FakeWebSocket[] = [];
    const { api } = createApiMock();
    const reconnectRandom = vi.fn(() => 1);
    const transport = createQqbotTransport(config, {
      api,
      connectTimeoutMs: 10,
      reconnectDelaysMs: [1],
      reconnectRandom,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        if (sockets.length === 2) {
          queueMicrotask(() => {
            socket.emit(
              "message",
              Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
            );
            socket.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  op: 0,
                  s: 1,
                  t: "READY",
                  d: { session_id: "session-1" },
                }),
              ),
            );
          });
        }
        return socket as unknown as WebSocket;
      },
    });

    await transport.start(() => undefined);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(reconnectRandom).toHaveBeenCalled();
    await vi.waitFor(() => expect(transport.status?.()).toEqual({ state: "connected" }));
    await transport.stop();
  });

  it("reports a sanitized retry lifecycle across initial and supervised failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const retryConfig: QqbotAdapterConfig = {
      ...config,
      client_secret: "client-secret-value",
    };
    const { api, getAccessToken, getGatewayUrl } = createApiMock();
    getAccessToken.mockResolvedValue("access-token-value");
    getGatewayUrl
      .mockRejectedValueOnce(
        new Error("gateway refused client_secret=client-secret-value token=access-token-value"),
      )
      .mockRejectedValueOnce(new Error("gateway refused Bearer access-token-value"))
      .mockResolvedValue("wss://gateway.example");
    const transport = createQqbotTransport(retryConfig, {
      api,
      reconnectDelaysMs: [1],
      reconnectRandom: () => 1,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        queueMicrotask(() => {
          socket.emit(
            "message",
            Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
          );
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                op: 0,
                s: 1,
                t: "READY",
                d: { session_id: "session-1" },
              }),
            ),
          );
        });
        return socket as unknown as WebSocket;
      },
    });

    try {
      await transport.start(() => undefined);
      await vi.waitFor(() => expect(transport.status?.()).toEqual({ state: "connected" }));
      const logs = consoleError.mock.calls.map(([message]) => String(message));
      expect(logs).toEqual([
        expect.stringContaining("qqbot initial connect failed"),
        expect.stringContaining("qqbot supervised reconnect scheduled attempt=1 delayMs=1"),
        expect.stringContaining("qqbot supervised reconnect failed attempt=1"),
        expect.stringContaining("qqbot supervised reconnect scheduled attempt=2 delayMs=1"),
        expect.stringContaining("qqbot supervised reconnect succeeded attempt=2"),
      ]);
      expect(logs.join("\n")).not.toContain("client-secret-value");
      expect(logs.join("\n")).not.toContain("access-token-value");
    } finally {
      await transport.stop();
      consoleError.mockRestore();
    }
  });

  it("times out after Hello when Identify never reaches READY and reconnects", async () => {
    const sockets: FakeWebSocket[] = [];
    const { api } = createApiMock();
    const transport = createQqbotTransport(config, {
      api,
      connectTimeoutMs: 10,
      reconnectDelaysMs: [1],
      reconnectRandom: () => 1,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.emit(
            "message",
            Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
          );
          if (sockets.length === 2) {
            socket.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  op: 0,
                  s: 1,
                  t: "READY",
                  d: { session_id: "session-ready" },
                }),
              ),
            );
          }
        });
        return socket as unknown as WebSocket;
      },
    });

    await transport.start(() => undefined);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toMatchObject({ op: 2 });
    await vi.waitFor(() => expect(transport.status?.()).toEqual({ state: "connected" }));
    await transport.stop();
  });

  it("cancels a pending initial reconnect when stopped", async () => {
    const sockets: FakeWebSocket[] = [];
    const { api } = createApiMock();
    const transport = createQqbotTransport(config, {
      api,
      connectTimeoutMs: 5,
      reconnectDelaysMs: [100],
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    await transport.start(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transport.status?.()).toMatchObject({ state: "reconnecting" });
    await transport.stop();
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(sockets).toHaveLength(1);
    expect(transport.status?.()).toEqual({ state: "stopped" });
  });

  it("resumes before a message whose durable receipt failed", async () => {
    const sockets: FakeWebSocket[] = [];
    const { api } = createApiMock();
    let receiptAttempts = 0;
    let persistedCursor: QqbotGatewayCursor | null = null;
    const transport = createQqbotTransport(config, {
      api,
      connectTimeoutMs: 100,
      reconnectDelaysMs: [1],
      loadCursor: () => persistedCursor,
      saveCursor: (cursor) => {
        persistedCursor = cursor;
      },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const starting = transport.start(() => {
      receiptAttempts += 1;
      if (receiptAttempts === 1) throw new Error("receipt unavailable");
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
    );
    await starting;
    sockets[0]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "session-1" } })),
    );
    sockets[0]?.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          op: 0,
          s: 2,
          t: "C2C_MESSAGE_CREATE",
          d: { id: "message-2", content: "retry", author: { user_openid: "user-1" } },
        }),
      ),
    );

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(persistedCursor).toEqual({ sessionId: "session-1", lastSeq: 1 });
    sockets[1]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
    );
    const resume = JSON.parse(sockets[1]?.sent[0] ?? "{}") as { d?: { seq?: number } };
    expect(resume.d?.seq).toBe(1);
    sockets[1]?.emit("message", Buffer.from(JSON.stringify({ op: 0, s: 1, t: "RESUMED", d: {} })));
    sockets[1]?.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          op: 0,
          s: 2,
          t: "C2C_MESSAGE_CREATE",
          d: { id: "message-2", content: "retry", author: { user_openid: "user-1" } },
        }),
      ),
    );
    await vi.waitFor(() => expect(receiptAttempts).toBe(2));
    await vi.waitFor(() => expect(persistedCursor).toEqual({ sessionId: "session-1", lastSeq: 2 }));

    sockets[1]?.emit("close");
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    sockets[2]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
    );
    const nextResume = JSON.parse(sockets[2]?.sent[0] ?? "{}") as { d?: { seq?: number } };
    expect(nextResume.d?.seq).toBe(2);
    await transport.stop();
  });

  it("loads a durable cursor when a transport is recreated for planned restart", async () => {
    let persistedCursor: QqbotGatewayCursor | null = null;
    const cursorOptions = {
      loadCursor: () => persistedCursor,
      saveCursor: (cursor: QqbotGatewayCursor | null) => {
        persistedCursor = cursor;
      },
    };
    const firstSockets: FakeWebSocket[] = [];
    const firstApi = createApiMock();
    const first = createQqbotTransport(config, {
      api: firstApi.api,
      ...cursorOptions,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        firstSockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    await first.start(() => undefined);
    await vi.waitFor(() => expect(firstSockets).toHaveLength(1));
    firstSockets[0]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
    );
    expect(JSON.parse(firstSockets[0]?.sent[0] ?? "{}")).toMatchObject({ op: 2 });
    firstSockets[0]?.emit(
      "message",
      Buffer.from(
        JSON.stringify({ op: 0, s: 4, t: "READY", d: { session_id: "session-restart" } }),
      ),
    );
    firstSockets[0]?.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          op: 0,
          s: 5,
          t: "C2C_MESSAGE_CREATE",
          d: { id: "message-5", content: "durable", author: { user_openid: "user-1" } },
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(persistedCursor).toEqual({ sessionId: "session-restart", lastSeq: 5 }),
    );
    await first.stop();

    const secondSockets: FakeWebSocket[] = [];
    const secondApi = createApiMock();
    const recreated = createQqbotTransport(config, {
      api: secondApi.api,
      ...cursorOptions,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        secondSockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    await recreated.start(() => undefined);
    await vi.waitFor(() => expect(secondSockets).toHaveLength(1));
    secondSockets[0]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
    );
    expect(JSON.parse(secondSockets[0]?.sent[0] ?? "{}")).toMatchObject({
      op: 6,
      d: { session_id: "session-restart", seq: 5 },
    });
    secondSockets[0]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 0, s: 5, t: "RESUMED", d: {} })),
    );
    await vi.waitFor(() => expect(recreated.status?.()).toEqual({ state: "connected" }));
    await recreated.stop();
  });

  it("retries an interaction from the last durably settled sequence", async () => {
    const sockets: FakeWebSocket[] = [];
    const { api } = createApiMock();
    let settlementAttempts = 0;
    const transport = createQqbotTransport(config, {
      api,
      connectTimeoutMs: 100,
      reconnectDelaysMs: [1],
      reconnectRandom: () => 1,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const interaction = {
      op: 0,
      s: 2,
      t: "INTERACTION_CREATE",
      d: {
        id: "interaction-retry",
        type: 11,
        scene: "c2c",
        chat_type: 2,
        user_openid: "user-1",
        data: { resolved: { button_id: "continue", button_data: "opaque-retry" } },
        version: 1,
      },
    };

    await transport.start(
      () => undefined,
      async () => {
        settlementAttempts += 1;
        if (settlementAttempts === 1) throw new Error("settlement unavailable");
      },
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
    );
    sockets[0]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "session-1" } })),
    );
    await vi.waitFor(() => expect(transport.status?.()).toEqual({ state: "connected" }));
    sockets[0]?.emit("message", Buffer.from(JSON.stringify(interaction)));

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
    );
    expect(JSON.parse(sockets[1]?.sent[0] ?? "{}")).toMatchObject({
      op: 6,
      d: { session_id: "session-1", seq: 1 },
    });
    sockets[1]?.emit("message", Buffer.from(JSON.stringify({ op: 0, s: 1, t: "RESUMED", d: {} })));
    sockets[1]?.emit("message", Buffer.from(JSON.stringify(interaction)));
    await vi.waitFor(() => expect(settlementAttempts).toBe(2));

    sockets[1]?.emit("close");
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    sockets[2]?.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
    );
    expect(JSON.parse(sockets[2]?.sent[0] ?? "{}")).toMatchObject({
      op: 6,
      d: { session_id: "session-1", seq: 2 },
    });
    await transport.stop();
  });

  it("streams the C2C final answer in place through stream_messages", async () => {
    const { api, sendC2CMarkdownMessage, sendC2CStreamMessage } = createApiMock();
    sendC2CStreamMessage.mockResolvedValue({ id: "stream-1" });
    const transport = createQqbotTransport(config, { api });
    const stream = await transport.reply?.openReplyStream({
      recipient: "c2c:user-1",
      messageId: "source-message",
    });

    expect(stream?.answerMode).toBe("inline");
    stream?.appendText("最终");
    stream?.appendText("答案");
    await stream!.complete();

    expect(sendC2CStreamMessage).toHaveBeenCalledTimes(1);
    const streamCalls = sendC2CStreamMessage.mock.calls as unknown as Array<
      [string, string, Record<string, unknown>]
    >;
    expect(streamCalls[0]?.[2]).toMatchObject({
      input_mode: "replace",
      input_state: 10,
      content_type: "markdown",
      content_raw: "最终答案\n",
      event_id: "source-message",
      msg_id: "source-message",
      msg_seq: 4,
      index: 0,
    });
    expect(sendC2CMarkdownMessage).not.toHaveBeenCalled();
  });

  it("does not open a reply stream for QQ group or channel recipients", async () => {
    const { api } = createApiMock();
    const transport = createQqbotTransport(config, { api });

    await expect(
      transport.reply?.openReplyStream({
        recipient: "group:group-1",
        messageId: "source-group",
      }),
    ).resolves.toBeUndefined();
    await expect(
      transport.reply?.openReplyStream({
        recipient: "channel:channel-1",
        messageId: "source-channel",
      }),
    ).resolves.toBeUndefined();
    await expect(
      transport.reply?.openReplyStream({ recipient: "c2c:user-1" }),
    ).resolves.toBeUndefined();
  });

  it("sends unwrapped final replies for QQ group and channel recipients", async () => {
    const { api, sendGroupMarkdownMessage, sendChannelMessage } = createApiMock();
    const transport = createQqbotTransport(config, { api });

    await transport.reply?.sendReply({
      recipient: "group:group-1",
      messageId: "source-group",
      text: "群聊答案",
    });
    await transport.reply?.sendReply({
      recipient: "channel:channel-1",
      messageId: "source-channel",
      text: "频道答案",
    });

    expect(sendGroupMarkdownMessage).toHaveBeenCalledWith(
      "token",
      "group-1",
      "群聊答案",
      "source-group",
      5,
    );
    expect(sendChannelMessage).toHaveBeenCalledWith(
      "token",
      "channel-1",
      "频道答案",
      "source-channel",
    );
  });

  it("uses peer-scoped C2C button permission and keeps group asks sender-scoped", async () => {
    const { api, sendC2CMarkdownKeyboardMessage, sendGroupMarkdownKeyboardMessage } =
      createApiMock();
    const transport = createQqbotTransport(config, { api });
    const request = {
      prompt: "继续吗？",
      messageId: "source-permission",
      audience: { kind: "users" as const, userIds: ["user-1"] },
      options: [{ label: "继续", data: "opaque" }],
    };

    await transport.interaction?.sendAsk("c2c:user-1", request);
    await transport.interaction?.sendAsk("group:group-1", request);

    const c2cCalls = sendC2CMarkdownKeyboardMessage.mock.calls as unknown as Array<
      Parameters<QqbotApiClient["sendC2CMarkdownKeyboardMessage"]>
    >;
    const groupCalls = sendGroupMarkdownKeyboardMessage.mock.calls as unknown as Array<
      Parameters<QqbotApiClient["sendGroupMarkdownKeyboardMessage"]>
    >;
    expect(c2cCalls[0]?.[2]?.keyboard.content?.rows[0]?.buttons[0]?.action.permission).toEqual({
      type: 2,
    });
    expect(groupCalls[0]?.[2]?.keyboard.content?.rows[0]?.buttons[0]?.action.permission).toEqual({
      type: 0,
      specify_user_ids: ["user-1"],
    });
  });

  it("reserves the last C2C passive reply slot for the final answer", async () => {
    const { api, sendC2CMarkdownMessage, sendC2CMarkdownKeyboardMessage, sendC2CStreamMessage } =
      createApiMock();
    const transport = createQqbotTransport(config, { api });
    const messageId = "source-with-asks";

    const request = {
      prompt: "继续吗？",
      messageId,
      options: [{ label: "继续", data: "opaque" }],
    };
    await transport.interaction?.sendAsk("c2c:user-1", request);
    await expect(transport.interaction?.sendAsk("c2c:user-1", request)).rejects.toThrow(
      "reserved for the final answer",
    );
    await transport.reply?.sendReply({
      recipient: "c2c:user-1",
      messageId,
      text: "最终答案",
    });

    expect(sendC2CStreamMessage).not.toHaveBeenCalled();
    expect(sendC2CMarkdownKeyboardMessage).toHaveBeenCalledTimes(1);
    expect(sendC2CMarkdownMessage).toHaveBeenCalledTimes(1);
    const askCalls = sendC2CMarkdownKeyboardMessage.mock.calls as unknown as Array<
      Parameters<QqbotApiClient["sendC2CMarkdownKeyboardMessage"]>
    >;
    expect(askCalls.map((call) => call[2].msg_seq)).toEqual([2]);
    expect(sendC2CMarkdownMessage).toHaveBeenLastCalledWith(
      "token",
      "user-1",
      "最终答案",
      messageId,
      4,
    );
  });

  it("keeps the final C2C sequence stable across transport recreation", async () => {
    const first = createApiMock();
    const firstTransport = createQqbotTransport(config, { api: first.api });
    const messageId = "source-across-restart";
    await firstTransport.interaction?.sendAsk("c2c:user-1", {
      prompt: "继续吗？",
      messageId,
      options: [{ label: "继续", data: "opaque" }],
    });

    const second = createApiMock();
    const recreatedTransport = createQqbotTransport(config, { api: second.api });
    await recreatedTransport.reply?.sendReply({
      recipient: "c2c:user-1",
      messageId,
      text: "重启后的最终答案",
    });

    expect(first.sendC2CStreamMessage).not.toHaveBeenCalled();
    expect(second.sendC2CMarkdownMessage).toHaveBeenCalledWith(
      "token",
      "user-1",
      "重启后的最终答案",
      messageId,
      4,
    );
  });

  it("retries the same durable ask after an ambiguous outcome without opening another ask slot", async () => {
    const { api, sendC2CMarkdownMessage, sendC2CMarkdownKeyboardMessage } = createApiMock();
    sendC2CMarkdownKeyboardMessage.mockRejectedValueOnce(new Error("response timeout"));
    const transport = createQqbotTransport(config, { api });
    const messageId = "source-timeout";
    const request = {
      prompt: "继续吗？",
      messageId,
      idempotencyKey: "channel.ask:request-1",
      options: [{ label: "继续", data: "opaque" }],
    };

    await expect(transport.interaction?.sendAsk("c2c:user-1", request)).rejects.toThrow(
      "response timeout",
    );
    await expect(transport.interaction?.sendAsk("c2c:user-1", { ...request })).resolves.toEqual({
      messageId: "ask-c2c",
    });
    await expect(
      transport.interaction?.sendAsk("c2c:user-1", {
        ...request,
        idempotencyKey: "channel.ask:request-2",
      }),
    ).rejects.toThrow("reserved for the final answer");
    await transport.reply?.sendReply({
      recipient: "c2c:user-1",
      messageId,
      text: "最终答案",
    });

    const askCalls = sendC2CMarkdownKeyboardMessage.mock.calls as unknown as Array<
      Parameters<QqbotApiClient["sendC2CMarkdownKeyboardMessage"]>
    >;
    expect(askCalls.map((call) => ({ msgId: call[2].msg_id, msgSeq: call[2].msg_seq }))).toEqual([
      { msgId: messageId, msgSeq: 2 },
      { msgId: messageId, msgSeq: 2 },
    ]);
    expect(sendC2CMarkdownMessage).toHaveBeenLastCalledWith(
      "token",
      "user-1",
      "最终答案",
      messageId,
      4,
    );
  });

  it("forwards INTERACTION_CREATE through the interaction handler only", async () => {
    const socket = new FakeWebSocket();
    const { api } = createApiMock();
    const transport = createQqbotTransport(config, {
      api,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const messages: unknown[] = [];
    const interactions: unknown[] = [];

    const starting = transport.start(
      (message) => {
        messages.push(message);
      },
      (interaction) => {
        interactions.push(interaction);
      },
    );
    await vi.waitFor(() => expect(socket.listenerCount("message")).toBeGreaterThan(0));
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
    );
    await starting;
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "session-1" } })),
    );
    await vi.waitFor(() => expect(transport.status?.()).toEqual({ state: "connected" }));

    const identify = JSON.parse(socket.sent[0] ?? "{}") as { d?: { intents?: number } };
    expect((identify.d?.intents ?? 0) & (1 << 26)).not.toBe(0);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          op: 0,
          s: 2,
          t: "INTERACTION_CREATE",
          d: {
            id: "interaction-1",
            type: 11,
            scene: "group",
            chat_type: 1,
            group_openid: "group-1",
            group_member_openid: "member-1",
            data: {
              resolved: {
                button_id: "approve",
                button_data: "opaque-1",
              },
            },
            version: 1,
          },
        }),
      ),
    );

    expect(messages).toEqual([]);
    await vi.waitFor(() => expect(interactions).toHaveLength(1));
    expect(interactions[0]).toMatchObject({
      adapter: "qqbot",
      interactionId: "interaction-1",
      actorId: "member-1",
      scene: "group",
      recipient: "group:group-1",
      buttonData: "opaque-1",
      buttonId: "approve",
    });

    await transport.stop();
  });

  it("renders a generic ask as a QQ callback keyboard and maps ACK statuses", async () => {
    const { api, sendC2CMarkdownKeyboardMessage, acknowledgeInteraction } = createApiMock();
    const transport = createQqbotTransport(config, { api });

    await expect(
      transport.interaction?.sendAsk("c2c:user-1", {
        prompt: "**继续执行吗？**",
        audience: { kind: "users", userIds: ["user-1"] },
        messageId: "source-message",
        options: [
          { id: "yes", label: "继续", data: "ask-token:yes" },
          { id: "no", label: "停止", data: "ask-token:no" },
        ],
      }),
    ).resolves.toEqual({ messageId: "ask-c2c" });

    expect(sendC2CMarkdownKeyboardMessage).toHaveBeenCalledWith("token", "user-1", {
      markdown: { content: "**继续执行吗？**" },
      msg_id: "source-message",
      msg_seq: 2,
      keyboard: {
        content: {
          rows: [
            {
              buttons: [
                {
                  id: "yes",
                  render_data: { label: "继续", visited_label: "继续", style: 0 },
                  action: {
                    type: 1,
                    permission: { type: 2 },
                    data: "ask-token:yes",
                    unsupport_tips: "当前 QQ 版本不支持此操作，请升级后重试",
                  },
                },
                {
                  id: "no",
                  render_data: { label: "停止", visited_label: "停止", style: 0 },
                  action: {
                    type: 1,
                    permission: { type: 2 },
                    data: "ask-token:no",
                    unsupport_tips: "当前 QQ 版本不支持此操作，请升级后重试",
                  },
                },
              ],
            },
          ],
        },
      },
    });

    await transport.interaction?.ackInteraction("interaction-1", "duplicate");
    expect(acknowledgeInteraction).toHaveBeenCalledWith("token", "interaction-1", 3);
  });
});
