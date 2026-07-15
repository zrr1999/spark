import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import type { QqbotApiClient } from "./qqbot-api.ts";
import { createQqbotTransport } from "./qqbot-transport.ts";
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
    getAccessToken: vi.fn(async () => "token"),
    getGatewayUrl: vi.fn(async () => "wss://gateway.example"),
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
  it("sends only the original C2C final reply body", async () => {
    const { api, sendC2CMarkdownMessage, sendC2CStreamMessage } = createApiMock();
    const transport = createQqbotTransport(config, { api });
    const stream = await transport.reply?.openReplyStream({
      recipient: "c2c:user-1",
      messageId: "source-message",
    });

    expect(stream).toBeUndefined();

    await transport.reply?.sendReply({
      recipient: "c2c:user-1",
      messageId: "source-message",
      text: "\n  最终答案  \n",
    });
    expect(sendC2CStreamMessage).not.toHaveBeenCalled();
    expect(sendC2CMarkdownMessage).toHaveBeenCalledWith(
      "token",
      "user-1",
      "最终答案",
      "source-message",
      4,
    );
  });

  it("does not expose a QQ reply stream", async () => {
    const { api } = createApiMock();
    const transport = createQqbotTransport(config, { api });

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

  it("conservatively consumes an ask slot when the send outcome is ambiguous", async () => {
    const { api, sendC2CMarkdownMessage, sendC2CMarkdownKeyboardMessage } = createApiMock();
    sendC2CMarkdownKeyboardMessage.mockRejectedValueOnce(new Error("response timeout"));
    const transport = createQqbotTransport(config, { api });
    const messageId = "source-timeout";
    const request = {
      prompt: "继续吗？",
      messageId,
      options: [{ label: "继续", data: "opaque" }],
    };

    await expect(transport.interaction?.sendAsk("c2c:user-1", request)).rejects.toThrow(
      "response timeout",
    );
    await expect(transport.interaction?.sendAsk("c2c:user-1", request)).rejects.toThrow(
      "reserved for the final answer",
    );
    await transport.reply?.sendReply({
      recipient: "c2c:user-1",
      messageId,
      text: "最终答案",
    });

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

    const identify = JSON.parse(socket.sent[0] ?? "{}") as { d?: { intents?: number } };
    expect((identify.d?.intents ?? 0) & (1 << 26)).not.toBe(0);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          op: 0,
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
    expect(interactions).toHaveLength(1);
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
