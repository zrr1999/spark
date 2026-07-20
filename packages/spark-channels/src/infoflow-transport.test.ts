import assert from "node:assert/strict";
import type { WSClient } from "@core-workspace/infoflow-sdk-nodejs";
import { describe, expect, it, vi } from "vitest";
import type { InfoflowSdkOutbound } from "./infoflow-sdk-outbound.ts";
import {
  createInfoflowTransport,
  infoflowImageSources,
  normalizeInfoflowInbound,
} from "./infoflow-transport.ts";

describe("infoflow transport", () => {
  it("extracts private and mixed image sources without retaining them in descriptors", () => {
    expect(
      infoflowImageSources({
        data: {
          chatType: "group",
          raw: {
            message: {
              body: [
                { type: "TEXT", content: "see" },
                {
                  type: "IMAGE",
                  downloadurl: "https://media.example/image",
                  imageType: "image/png",
                  imageName: "photo.png",
                },
              ],
            },
          },
        },
      }),
    ).toEqual([
      {
        url: "https://media.example/image",
        mediaType: "image/png",
        name: "photo.png",
      },
    ]);
  });

  it("delegates ordinary and reply delivery to the SDK outbound boundary", async () => {
    const send = vi.fn(async () => undefined);
    const sendWithReceipt = vi.fn(async () => ({
      replaySafety: "unsafe" as const,
      receipt: { messageKey: "receipt-1" },
    }));
    const openReplyStream = vi.fn(async () => undefined);
    const recoverReply = vi.fn(async () => undefined);
    const outbound: InfoflowSdkOutbound = {
      send,
      sendWithReceipt,
      openReplyStream,
      recoverReply,
    };
    const transport = createInfoflowTransport(
      {
        type: "infoflow",
        endpoint: "https://api.im.baidu.com",
        app_key: "key",
        app_secret: "secret",
        app_agent_id: "19690",
      },
      { outbound },
    );

    await expect(
      transport.send("alice", "hello from spark", "message:infoflow:1"),
    ).resolves.toEqual({
      replaySafety: "unsafe",
      receipt: { messageKey: "receipt-1" },
    });
    await expect(
      transport.image?.sendImage({
        recipient: "alice",
        image: { data: Buffer.from("image").toString("base64"), mediaType: "image/png" },
        deliveryId: "message:infoflow:image:1",
      }),
    ).resolves.toEqual({
      replaySafety: "unsafe",
      receipt: { messageKey: "receipt-1" },
    });
    expect(sendWithReceipt).toHaveBeenLastCalledWith({
      recipient: "alice",
      content: { type: "image", base64: Buffer.from("image").toString("base64") },
      deliveryId: "message:infoflow:image:1",
    });
    expect(transport.messageDeliveryFacts?.({ recipient: "alice" })).toEqual({
      replaySafety: "unsafe",
    });
    await transport.reply?.openReplyStream({
      recipient: "group:10838226",
      senderId: "zhanrongrui",
    });
    await transport.reply?.sendReply({
      recipient: "group:10838226",
      senderId: "zhanrongrui",
      text: "**处理完成**",
      deliveryId: "reply:infoflow:1",
    });
    await transport.reply?.recoverReply?.({
      recipient: "group:10838226",
      text: "**处理完成**",
      deliveryId: "channel.reply:1",
      recovery: { kind: "infoflow.streaming-card.v1", data: { token: "one" } },
    });

    assert.deepEqual(sendWithReceipt.mock.calls, [
      [
        {
          recipient: "alice",
          content: { type: "text", text: "hello from spark" },
          deliveryId: "message:infoflow:1",
        },
      ],
      [
        {
          recipient: "alice",
          content: { type: "image", base64: Buffer.from("image").toString("base64") },
          deliveryId: "message:infoflow:image:1",
        },
      ],
      [
        {
          recipient: "group:10838226",
          content: { type: "markdown", text: "**处理完成**" },
          deliveryId: "reply:infoflow:1",
          mentionUserIds: ["zhanrongrui"],
        },
      ],
    ]);
    assert.equal(send.mock.calls.length, 0);
    assert.deepEqual(openReplyStream.mock.calls, [["group:10838226"]]);
    assert.deepEqual(recoverReply.mock.calls, [
      [
        {
          recipient: "group:10838226",
          text: "**处理完成**",
          recovery: { kind: "infoflow.streaming-card.v1", data: { token: "one" } },
        },
      ],
    ]);
  });

  it("keeps the legacy Promise<void> outbound seam source-compatible", async () => {
    const send = vi.fn(async () => undefined);
    const outbound: InfoflowSdkOutbound = {
      send,
      openReplyStream: async () => undefined,
      recoverReply: async () => undefined,
    };
    const transport = createInfoflowTransport(
      {
        type: "infoflow",
        app_key: "key",
        app_secret: "secret",
        app_agent_id: "19690",
      },
      { outbound },
    );

    await expect(transport.send("alice", "hello", "delivery:legacy")).resolves.toEqual({
      replaySafety: "unsafe",
    });
    expect(send).toHaveBeenCalledWith({
      recipient: "alice",
      content: { type: "text", text: "hello" },
      deliveryId: "delivery:legacy",
    });
  });

  it("projects asks as markdown text and ignores duplicate idempotent retries", async () => {
    const send = vi.fn(async () => undefined);
    const outbound: InfoflowSdkOutbound = {
      send,
      openReplyStream: vi.fn(async () => undefined),
      recoverReply: vi.fn(async () => undefined),
    };
    const transport = createInfoflowTransport(
      {
        type: "infoflow",
        endpoint: "https://api.im.baidu.com",
        app_key: "key",
        app_secret: "secret",
        app_agent_id: "19690",
      },
      { outbound },
    );

    const request = {
      prompt: "## Choose\n\nContinue?\n\n请回复序号或直接输入：\n1. Yes\n2. No",
      options: [
        { id: "1", label: "Yes", data: "opaque-yes" },
        { id: "2", label: "No", data: "opaque-no" },
      ],
      idempotencyKey: "channel.ask:hreq_1",
      audience: { kind: "users" as const, userIds: ["alice"] },
    };
    await expect(transport.interaction?.sendAsk("alice", request)).resolves.toEqual({});
    await expect(transport.interaction?.sendAsk("alice", request)).resolves.toEqual({});
    await transport.interaction?.ackInteraction("unused");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      recipient: "alice",
      content: { type: "markdown", text: request.prompt },
    });
  });

  it("reports live SDK websocket state and connection errors", async () => {
    let state = "connecting";
    const handlers = new Map<string, (event: unknown) => void>();
    const client = {
      on(pattern: string, handler: (event: unknown) => void) {
        handlers.set(pattern, handler);
      },
      off(pattern: string) {
        handlers.delete(pattern);
      },
      async connect() {
        state = "connected";
        handlers.get("connected")?.({ type: "connected" });
      },
      disconnect() {
        state = "disconnected";
      },
      getState() {
        return state;
      },
    } as unknown as WSClient;
    const transport = createInfoflowTransport(
      { type: "infoflow", app_key: "key", app_secret: "secret", app_agent_id: "19690" },
      { wsClientFactory: () => client },
    );

    await transport.start(() => undefined);
    assert.deepEqual(transport.status?.(), { state: "connected" });
    state = "reconnecting";
    assert.deepEqual(transport.status?.(), { state: "reconnecting" });
    handlers.get("error")?.(new Error("gateway unavailable"));
    assert.deepEqual(transport.status?.(), {
      state: "degraded",
      error: "gateway unavailable",
    });
    state = "connected";
    handlers.get("connected")?.({ type: "connected" });
    assert.deepEqual(transport.status?.(), { state: "connected" });
    await transport.stop();
    assert.deepEqual(transport.status?.(), { state: "stopped" });
  });

  it("claims established disconnects from the SDK and supervises every reconnect episode", async () => {
    vi.useFakeTimers();
    let state = "disconnected";
    let attempts = 0;
    let disconnects = 0;
    const handlers = new Map<string, (event: unknown) => void>();
    const client = {
      on(pattern: string, handler: (event: unknown) => void) {
        handlers.set(pattern, handler);
      },
      off(pattern: string) {
        handlers.delete(pattern);
      },
      async connect() {
        attempts += 1;
        state = "connected";
        handlers.get("connected")?.({ type: "connected" });
      },
      disconnect() {
        disconnects += 1;
        state = "disconnected";
      },
      getState() {
        return state;
      },
    } as unknown as WSClient;
    const reconnectRandom = vi.fn(() => 1);
    const transport = createInfoflowTransport(
      { type: "infoflow", app_key: "key", app_secret: "secret", app_agent_id: "19690" },
      { wsClientFactory: () => client, reconnectDelaysMs: [1], reconnectRandom },
    );

    try {
      await transport.start(() => undefined);
      expect(attempts).toBe(1);

      // A real WSClient publishes this event synchronously before starting its
      // finite server-configured reconnect loop. Spark claims the handoff by
      // marking it as a manual disconnect, then runs the infinite supervisor.
      state = "disconnected";
      handlers.get("disconnected")?.({ type: "disconnected" });
      expect(transport.status?.()).toEqual({ state: "reconnecting" });
      expect(disconnects).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      expect(reconnectRandom).toHaveBeenCalledOnce();
      expect(transport.status?.()).toEqual({ state: "connected" });

      state = "disconnected";
      handlers.get("disconnected")?.({ type: "disconnected" });
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(3);
      expect(disconnects).toBe(2);
      expect(reconnectRandom).toHaveBeenCalledTimes(2);
      expect(transport.status?.()).toEqual({ state: "connected" });
    } finally {
      await transport.stop();
      vi.useRealTimers();
    }
  });

  it("ignores lifecycle events from a stopped or replaced SDK client", async () => {
    function fakeClient() {
      let state = "disconnected";
      const handlers = new Map<string, (event: unknown) => void>();
      const disconnect = vi.fn(() => {
        state = "disconnected";
      });
      const client = {
        on(pattern: string, handler: (event: unknown) => void) {
          handlers.set(pattern, handler);
        },
        off(pattern: string) {
          handlers.delete(pattern);
        },
        async connect() {
          state = "connected";
          handlers.get("connected")?.({ type: "connected" });
        },
        disconnect,
        getState() {
          return state;
        },
      } as unknown as WSClient;
      return { client, disconnect, handlers };
    }

    const first = fakeClient();
    const second = fakeClient();
    const clients = [first.client, second.client];
    const reconnectRandom = vi.fn(() => 1);
    const transport = createInfoflowTransport(
      { type: "infoflow", app_key: "key", app_secret: "secret", app_agent_id: "19690" },
      {
        wsClientFactory: () => clients.shift()!,
        reconnectDelaysMs: [1],
        reconnectRandom,
      },
    );

    await transport.start(() => undefined);
    const staleConnected = first.handlers.get("connected")!;
    const staleDisconnected = first.handlers.get("disconnected")!;
    await transport.stop();
    staleConnected({ type: "connected" });
    expect(transport.status?.()).toEqual({ state: "stopped" });

    await transport.start(() => undefined);
    expect(transport.status?.()).toEqual({ state: "connected" });
    staleDisconnected({ type: "disconnected" });
    expect(second.disconnect).not.toHaveBeenCalled();
    expect(reconnectRandom).not.toHaveBeenCalled();
    expect(transport.status?.()).toEqual({ state: "connected" });

    await transport.stop();
  });

  it("keeps retrying an initial SDK connection failure until it succeeds", async () => {
    let state = "disconnected";
    let attempts = 0;
    const handlers = new Map<string, (event: unknown) => void>();
    const client = {
      on(pattern: string, handler: (event: unknown) => void) {
        handlers.set(pattern, handler);
      },
      off(pattern: string) {
        handlers.delete(pattern);
      },
      async connect() {
        attempts += 1;
        if (attempts === 1) throw new Error("endpoint unavailable");
        state = "connected";
        handlers.get("connected")?.({ type: "connected" });
      },
      disconnect() {
        state = "disconnected";
      },
      getState() {
        return state;
      },
    } as unknown as WSClient;
    const reconnectRandom = vi.fn(() => 1);
    const transport = createInfoflowTransport(
      { type: "infoflow", app_key: "key", app_secret: "secret", app_agent_id: "19690" },
      { wsClientFactory: () => client, reconnectDelaysMs: [1], reconnectRandom },
    );

    await transport.start(() => undefined);
    expect(transport.status?.()).toMatchObject({ state: "reconnecting" });
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(reconnectRandom).toHaveBeenCalled();
    expect(transport.status?.()).toEqual({ state: "connected" });
    await transport.stop();
  });

  it("does not block daemon startup on a hung SDK handshake", async () => {
    vi.useFakeTimers();
    let state = "connecting";
    let attempts = 0;
    const handlers = new Map<string, (event: unknown) => void>();
    const client = {
      on(pattern: string, handler: (event: unknown) => void) {
        handlers.set(pattern, handler);
      },
      off(pattern: string) {
        handlers.delete(pattern);
      },
      async connect() {
        attempts += 1;
        if (attempts === 1) await new Promise<never>(() => undefined);
        state = "connected";
        handlers.get("connected")?.({ type: "connected" });
      },
      disconnect() {
        state = "disconnected";
      },
      getState() {
        return state;
      },
    } as unknown as WSClient;
    const transport = createInfoflowTransport(
      { type: "infoflow", app_key: "key", app_secret: "secret", app_agent_id: "19690" },
      { wsClientFactory: () => client, connectTimeoutMs: 10, reconnectDelaysMs: [1] },
    );
    try {
      await expect(transport.start(() => undefined)).resolves.toBeUndefined();
      expect(attempts).toBe(1);
      expect(transport.status?.()).toMatchObject({ state: "connecting" });

      await vi.advanceTimersByTimeAsync(11);
      expect(attempts).toBe(2);
      expect(transport.status?.()).toEqual({ state: "connected" });
    } finally {
      await transport.stop();
      vi.useRealTimers();
    }
  });

  it("reconnects when the SDK heartbeat receives no pong", async () => {
    vi.useFakeTimers();
    let state = "connected";
    let attempts = 0;
    const handlers = new Map<string, (event: unknown) => void>();
    const client = {
      on(pattern: string, handler: (event: unknown) => void) {
        handlers.set(pattern, handler);
      },
      off(pattern: string) {
        handlers.delete(pattern);
      },
      async connect() {
        attempts += 1;
        state = "connected";
        handlers.get("connected")?.({ type: "connected" });
      },
      disconnect() {
        state = "disconnected";
      },
      getState() {
        return state;
      },
    } as unknown as WSClient;
    const transport = createInfoflowTransport(
      { type: "infoflow", app_key: "key", app_secret: "secret", app_agent_id: "19690" },
      { wsClientFactory: () => client, reconnectDelaysMs: [1], pongTimeoutMs: 10 },
    );
    try {
      await transport.start(() => undefined);
      handlers.get("heartbeat")?.({ type: "heartbeat", data: { type: "ping" } });
      await vi.advanceTimersByTimeAsync(11);
      expect(attempts).toBe(2);
      expect(transport.status?.()).toEqual({ state: "connected" });
    } finally {
      await transport.stop();
      vi.useRealTimers();
    }
  });

  it("does not swallow a durable inbound receipt failure in its handler", async () => {
    let state = "connected";
    let disconnects = 0;
    const handlers = new Map<string, (event: unknown) => void>();
    const client = {
      on(pattern: string, handler: (event: unknown) => void) {
        handlers.set(pattern, handler);
      },
      off(pattern: string) {
        handlers.delete(pattern);
      },
      async connect() {},
      disconnect() {
        disconnects += 1;
        state = "disconnected";
      },
      getState() {
        return state;
      },
    } as unknown as WSClient;
    const transport = createInfoflowTransport(
      { type: "infoflow", app_key: "key", app_secret: "secret", app_agent_id: "19690" },
      { wsClientFactory: () => client },
    );
    await transport.start(() => {
      throw new Error("receipt unavailable");
    });

    await expect(
      handlers.get("private.*")?.({
        type: "private.text",
        data: {
          raw: { FromUserId: "alice", Content: "hi", MsgId: "message-1" },
        },
      }),
    ).rejects.toThrow("receipt unavailable");
    expect(disconnects).toBe(1);
    await transport.stop();
  });

  it("awaits image materialization and durable ingress before stopping", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    const handlers = new Map<string, (event: unknown) => void | Promise<void>>();
    const client = {
      on(pattern: string, handler: (event: unknown) => void | Promise<void>) {
        handlers.set(pattern, handler);
      },
      off(pattern: string) {
        handlers.delete(pattern);
      },
      async connect() {},
      disconnect() {},
      getState() {
        return "connected";
      },
    } as unknown as WSClient;
    const received: unknown[] = [];
    const transport = createInfoflowTransport(
      { type: "infoflow", app_key: "key", app_secret: "secret", app_agent_id: "19690" },
      { fetchImpl, wsClientFactory: () => client },
    );
    await transport.start((raw) => received.push(raw));

    const receipt = handlers.get("private.*")?.({
      type: "private.image",
      data: {
        raw: {
          FromUserId: "alice",
          MsgId: "image-1",
          MsgType: "IMAGE",
          Content: JSON.stringify({
            downloadurl: "https://1.1.1.1/image-1",
            imageType: "image/png",
            fid: "image-fid-1",
          }),
        },
      },
    });
    expect(receipt).toBeInstanceOf(Promise);
    let stopped = false;
    const stopping = transport.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveFetch(
      new Response(Uint8Array.from([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    );
    await receipt;
    await stopping;

    expect(received).toEqual([
      expect.objectContaining({
        user_id: "alice",
        text: "[图片]",
        images: [
          {
            data: Buffer.from([137, 80, 78, 71]).toString("base64"),
            mediaType: "image/png",
          },
        ],
      }),
    ]);
  });

  it("normalizes private and group inbound payloads", () => {
    assert.deepEqual(
      normalizeInfoflowInbound({
        FromUserId: "alice",
        Content: "hi",
        MsgId: "1",
      }),
      {
        user_id: "alice",
        text: "hi",
        chat_type: "private",
        message_id: "1",
        content_type: "text",
      },
    );
    assert.deepEqual(
      normalizeInfoflowInbound({
        groupid: 42,
        message: {
          header: { fromuserid: "bob", msgid: "9", msgtype: "text" },
          body: [{ type: "TEXT", content: "group hi" }],
        },
      }),
      {
        user_id: "bob",
        text: "group hi",
        chat_type: "group",
        chat_id: "42",
        message_id: "9",
        content_type: "text",
      },
    );
    assert.deepEqual(
      normalizeInfoflowInbound({
        groupid: 42,
        message: {
          header: { fromuserid: "bob", msgid: "10", msgtype: "mixed" },
          body: [
            { type: "AT", name: "spark-bot" },
            { type: "TEXT", content: " 什么关系？" },
          ],
        },
      }),
      {
        user_id: "bob",
        text: "@spark-bot 什么关系？",
        chat_type: "group",
        chat_id: "42",
        message_id: "10",
        content_type: "mixed",
        mentions: ["spark-bot"],
      },
    );
  });

  it("keeps both robot and user @ mentions from real MIXED payloads", () => {
    // Captured from service.stdout.log group.mixed (2026-07-10).
    const normalized = normalizeInfoflowInbound(
      {
        eventtype: "MESSAGE_RECEIVE",
        agentid: 43163,
        groupid: 10838226,
        message: {
          header: {
            fromuserid: "xuxiaojian",
            toid: 10838226,
            totype: "GROUP",
            msgtype: "MIXED",
            messageid: "1870315656716618699",
            at: { atrobotids: [], atuserids: ["zhanrongrui"] },
          },
          body: [
            { type: "AT", robotid: 4105004371, name: "神经蛙" },
            { type: "TEXT", content: " 你和 " },
            { type: "AT", userid: "zhanrongrui", name: "詹荣瑞" },
            { type: "TEXT", content: " 什么关系？" },
          ],
        },
        targetAgentId: 43163,
      },
      { agentId: "43163" },
    );
    assert.equal(normalized?.text, "@神经蛙 你和 @詹荣瑞 什么关系？");
    assert.equal(normalized?.user_id, "xuxiaojian");
    assert.equal(normalized?.event_type, "MESSAGE_RECEIVE");
    assert.equal(normalized?.content_type, "mixed");
    assert.deepEqual(normalized?.mentions, ["神经蛙", "詹荣瑞"]);
    assert.equal(normalized?.mentioned_self, true);
    assert.match(normalized?.text ?? "", /@詹荣瑞/);
  });

  it("normalizes private media without copying binary or signed URLs", () => {
    const normalized = normalizeInfoflowInbound({
      FromUserId: "alice",
      MsgType: "IMAGE",
      Content: JSON.stringify({
        content: "A".repeat(2_000),
        downloadurl: "https://signed.invalid/image",
        fid: "image-fid-1",
      }),
    });

    assert.deepEqual(normalized, {
      user_id: "alice",
      text: "[图片]",
      chat_type: "private",
      content_type: "image",
      attachments: [{ kind: "image", reference: "image-fid-1" }],
    });
    assert.doesNotMatch(JSON.stringify(normalized), /signed\.invalid|A{100}/u);
  });

  it("uses platform message sender metadata when the group header omits it", () => {
    const normalized = normalizeInfoflowInbound({
      eventtype: "ALL_MESSAGE_FORWARD",
      groupid: 42,
      message: {
        FromUserId: "platform-user-7",
        FromUserName: "平台用户七",
        header: { messageid: "m-sender", msgtype: "TEXT" },
        body: [{ type: "TEXT", content: "hello" }],
      },
    });

    assert.deepEqual(normalized, {
      user_id: "platform-user-7",
      sender_name: "平台用户七",
      text: "hello",
      chat_type: "group",
      chat_id: "42",
      message_id: "m-sender",
      event_type: "ALL_MESSAGE_FORWARD",
      content_type: "text",
    });
  });
});
