import { describe, expect, it, vi } from "vitest";
import { QqbotAdapter } from "./qqbot-adapter.ts";
import {
  isQqbotGroupAllowed,
  isQqbotGroupTriggered,
  isQqbotInboundAllowed,
  isQqbotPrivateAllowed,
} from "./qqbot-policy.ts";
import { formatQqbotRecipient, parseQqbotRecipient } from "./qqbot-types.ts";
import { FakeChannelTransport } from "./transport.ts";
import type { QqbotAdapterConfig } from "./types.ts";

const baseConfig: QqbotAdapterConfig = {
  type: "qqbot",
  app_id: "app",
  client_secret: "secret",
};

describe("qqbot recipients", () => {
  it("parses and formats c2c/group/channel recipients", () => {
    expect(parseQqbotRecipient("c2c:u1")).toEqual({ kind: "c2c", openid: "u1" });
    expect(parseQqbotRecipient("group:g1")).toEqual({ kind: "group", groupOpenid: "g1" });
    expect(parseQqbotRecipient("channel:c1")).toEqual({ kind: "channel", channelId: "c1" });
    expect(formatQqbotRecipient({ kind: "c2c", openid: "u1" })).toBe("c2c:u1");
  });
});

describe("qqbot policy", () => {
  it("allows all private senders when allowlist is empty", () => {
    expect(isQqbotPrivateAllowed(baseConfig, "u1")).toBe(true);
  });

  it("enforces private allowlist", () => {
    const config: QqbotAdapterConfig = { ...baseConfig, allowed_user_ids: ["u1"] };
    expect(isQqbotPrivateAllowed(config, "u1")).toBe(true);
    expect(isQqbotPrivateAllowed(config, "u2")).toBe(false);
  });

  it("defaults group policy to disabled", () => {
    expect(isQqbotGroupAllowed(baseConfig, "g1")).toBe(false);
  });

  it("triggers on GROUP_AT_MESSAGE_CREATE for mention mode", () => {
    expect(
      isQqbotGroupTriggered(baseConfig, {
        text: "hello",
        eventType: "GROUP_AT_MESSAGE_CREATE",
      }),
    ).toBe(true);
    expect(
      isQqbotGroupTriggered(baseConfig, {
        text: "hello",
        eventType: "GROUP_MESSAGE_CREATE",
        mentionedSelf: false,
      }),
    ).toBe(false);
  });

  it("combines group allowlist + trigger", () => {
    const config: QqbotAdapterConfig = {
      ...baseConfig,
      group_policy: "allowlist",
      allowed_group_ids: ["g1"],
      group_trigger: "mention",
    };
    expect(
      isQqbotInboundAllowed(config, {
        chatType: "group",
        senderId: "u1",
        groupId: "g1",
        text: "hi",
        eventType: "GROUP_AT_MESSAGE_CREATE",
      }),
    ).toBe(true);
    expect(
      isQqbotInboundAllowed(config, {
        chatType: "group",
        senderId: "u1",
        groupId: "g2",
        text: "hi",
        eventType: "GROUP_AT_MESSAGE_CREATE",
      }),
    ).toBe(false);
  });
});

describe("QqbotAdapter", () => {
  it("parses C2C inbound into qqbot:c2c external keys", () => {
    const adapter = new QqbotAdapter({
      id: "qqbot",
      config: baseConfig,
      transport: new FakeChannelTransport(),
    });
    const message = adapter.parseInbound({
      event_type: "C2C_MESSAGE_CREATE",
      d: {
        id: "m1",
        content: "hello",
        author: { user_openid: "u1" },
      },
    });
    expect(message).toMatchObject({
      adapter: "qqbot",
      externalKey: "qqbot:c2c:u1",
      senderId: "u1",
      text: "hello",
      messageId: "m1",
    });
  });

  it("parses message_reference into structured messageReference", () => {
    const adapter = new QqbotAdapter({
      id: "qqbot",
      config: baseConfig,
      transport: new FakeChannelTransport(),
    });
    const message = adapter.parseInbound({
      event_type: "C2C_MESSAGE_CREATE",
      d: {
        id: "m-reply",
        content: "继续",
        author: { user_openid: "u1" },
        message_reference: {
          message_id: "m-source",
          content: "被引用正文",
          author: { user_openid: "bot", username: "Spark" },
        },
      },
    });
    expect(message?.text).toBe("继续");
    expect(message?.messageReference).toEqual({
      messageId: "m-source",
      preview: "被引用正文",
      senderId: "bot",
      senderName: "Spark",
      source: "embedded",
    });
  });

  it("keeps image-only C2C messages visible and passes materialized bytes", () => {
    const adapter = new QqbotAdapter({
      id: "qqbot",
      config: baseConfig,
      transport: new FakeChannelTransport(),
    });
    const data = Buffer.from("image").toString("base64");
    const message = adapter.parseInbound({
      event_type: "C2C_MESSAGE_CREATE",
      d: {
        id: "image-1",
        content: "",
        author: { user_openid: "u1" },
        attachments: [
          {
            content_type: "image/png",
            url: "https://temporary.qq/image",
            filename: "photo.png",
            size: 5,
          },
        ],
        spark_images: [{ data, mediaType: "image/png", name: "photo.png" }],
      },
    });

    expect(message).toMatchObject({
      text: "[图片]",
      contentType: "image",
      attachments: [{ kind: "image", name: "photo.png", mediaType: "image/png", size: 5 }],
      images: [{ data, mediaType: "image/png", name: "photo.png" }],
    });
    expect(JSON.stringify(message?.attachments)).not.toContain("temporary.qq");
  });

  it("parses group AT inbound into qqbot:group keys", () => {
    const adapter = new QqbotAdapter({
      id: "qqbot",
      config: { ...baseConfig, group_policy: "open", group_trigger: "mention" },
      transport: new FakeChannelTransport(),
    });
    const message = adapter.parseInbound({
      event_type: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "m2",
        content: "<@!12345> ping",
        group_openid: "g1",
        author: { member_openid: "u2", username: "bob" },
      },
    });
    expect(message).toMatchObject({
      adapter: "qqbot",
      externalKey: "qqbot:group:g1",
      senderId: "u2",
      chatId: "g1",
      text: "ping",
      mentionedSelf: true,
    });
  });

  it("drops group messages when policy is disabled", () => {
    const adapter = new QqbotAdapter({
      id: "qqbot",
      config: baseConfig,
      transport: new FakeChannelTransport(),
    });
    expect(
      adapter.parseInbound({
        event_type: "GROUP_AT_MESSAGE_CREATE",
        d: {
          id: "m3",
          content: "hi",
          group_openid: "g1",
          author: { member_openid: "u2" },
        },
      }),
    ).toBeUndefined();
  });

  it("dedupes repeated message ids only after successful receipt", async () => {
    const transport = new FakeChannelTransport();
    const onMessage = vi.fn();
    const adapter = new QqbotAdapter({
      id: "qqbot",
      config: baseConfig,
      transport,
      onMessage,
    });
    const raw = {
      event_type: "C2C_MESSAGE_CREATE",
      d: { id: "dup", content: "once", author: { user_openid: "u1" } },
    };
    await adapter.start();
    transport.emitInbound(raw);
    transport.emitInbound(raw);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ text: "once", messageId: "dup" });
    await adapter.stop();
  });

  it("redelivers when the durable receipt callback fails", async () => {
    const transport = new FakeChannelTransport();
    let attempts = 0;
    const adapter = new QqbotAdapter({
      id: "qqbot",
      config: baseConfig,
      transport,
      onMessage: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("receipt unavailable");
      },
    });
    const raw = {
      event_type: "C2C_MESSAGE_CREATE",
      d: { id: "retry", content: "again", author: { user_openid: "u1" } },
    };
    await adapter.start();

    expect(() => transport.emitInbound(raw)).toThrow("receipt unavailable");
    expect(() => transport.emitInbound(raw)).not.toThrow();
    transport.emitInbound(raw);
    expect(attempts).toBe(2);
    await adapter.stop();
  });

  it("exposes reply capability from transport", async () => {
    const transport = new FakeChannelTransport();
    const adapter = new QqbotAdapter({
      id: "qqbot",
      config: baseConfig,
      transport,
    });
    expect(adapter.reply).toBeUndefined();
    await adapter.send({ recipient: "c2c:u1", text: "hi" });
    expect(transport.sent).toEqual([{ recipient: "c2c:u1", text: "hi" }]);
  });

  it("delivers native interactions separately from text ingress", async () => {
    const transport = new FakeChannelTransport();
    const onMessage = vi.fn();
    const onInteraction = vi.fn();
    const adapter = new QqbotAdapter({
      id: "qq-main",
      config: baseConfig,
      transport,
      onMessage,
      onInteraction,
    });
    await adapter.start();

    const event = {
      adapter: "qqbot" as const,
      interactionId: "interaction-1",
      actorId: "u1",
      scene: "c2c" as const,
      recipient: "c2c:u1",
      buttonData: "opaque-token",
    };
    await transport.emitInteraction(event);

    expect(onMessage).not.toHaveBeenCalled();
    expect(onInteraction).toHaveBeenCalledWith({ ...event, adapterId: "qq-main" });
    expect(
      adapter.parseInbound({ event_type: "INTERACTION_CREATE", d: { id: "interaction-1" } }),
    ).toBeUndefined();

    await adapter.stop();
  });

  it("propagates native interaction settlement failures to the transport", async () => {
    const transport = new FakeChannelTransport();
    const adapter = new QqbotAdapter({
      id: "qq-main",
      config: baseConfig,
      transport,
      onInteraction: async () => {
        throw new Error("settlement unavailable");
      },
    });
    await adapter.start();

    await expect(
      transport.emitInteraction({
        adapter: "qqbot",
        interactionId: "interaction-failed",
        actorId: "u1",
        scene: "c2c",
        recipient: "c2c:u1",
        buttonData: "opaque-token",
      }),
    ).rejects.toThrow("settlement unavailable");

    await adapter.stop();
  });
});
