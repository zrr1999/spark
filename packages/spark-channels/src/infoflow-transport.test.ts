import assert from "node:assert/strict";
import type { WSClient } from "@core-workspace/infoflow-sdk-nodejs";
import { describe, it, vi } from "vitest";
import type { InfoflowSdkOutbound } from "./infoflow-sdk-outbound.ts";
import { createInfoflowTransport, normalizeInfoflowInbound } from "./infoflow-transport.ts";

describe("infoflow transport", () => {
  it("delegates ordinary and reply delivery to the SDK outbound boundary", async () => {
    const send = vi.fn(async () => undefined);
    const openReplyStream = vi.fn(async () => undefined);
    const outbound: InfoflowSdkOutbound = {
      send,
      openReplyStream,
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

    await transport.send("alice", "hello from spark");
    await transport.reply?.openReplyStream({
      recipient: "group:10838226",
      senderId: "zhanrongrui",
    });
    await transport.reply?.sendReply({
      recipient: "group:10838226",
      senderId: "zhanrongrui",
      text: "**处理完成**",
    });

    assert.deepEqual(send.mock.calls, [
      [{ recipient: "alice", content: { type: "text", text: "hello from spark" } }],
      [
        {
          recipient: "group:10838226",
          content: { type: "markdown", text: "**处理完成**" },
          mentionUserIds: ["zhanrongrui"],
        },
      ],
    ]);
    assert.deepEqual(openReplyStream.mock.calls, [["group:10838226"]]);
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
