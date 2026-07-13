import { describe, expect, it } from "vitest";
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

  it("dedupes repeated message ids", () => {
    const adapter = new QqbotAdapter({
      id: "qqbot",
      config: baseConfig,
      transport: new FakeChannelTransport(),
    });
    const raw = {
      event_type: "C2C_MESSAGE_CREATE",
      d: { id: "dup", content: "once", author: { user_openid: "u1" } },
    };
    expect(adapter.parseInbound(raw)?.text).toBe("once");
    expect(adapter.parseInbound(raw)).toBeUndefined();
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
});
