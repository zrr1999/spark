import { describe, expect, it } from "vitest";
import { createChannelExternalKey } from "./external-key.ts";
import { FeishuAdapter } from "./feishu-adapter.ts";
import { InfoflowAdapter } from "./infoflow-adapter.ts";
import { ChannelRegistry, parseChannelsConfig } from "./registry.ts";
import { FakeChannelTransport } from "./transport.ts";
import type { ChannelAdapterConfig, ChannelsConfig, IncomingMessage } from "./types.ts";

const sampleConfig: ChannelsConfig = {
  adapters: {
    feishu: { type: "feishu", event_mode: "websocket" },
    infoflow: { type: "infoflow" },
  },
  routes: {
    ops: { adapter: "feishu", recipient: "oc_ops" },
    alerts: { adapter: "infoflow", recipient: "user_alerts" },
  },
  ingress: { enabled: true, on_unbound: "reject" },
};

function createTestRegistry(
  onMessage: (message: IncomingMessage) => void,
  transports: Record<string, FakeChannelTransport>,
): ChannelRegistry {
  return new ChannelRegistry({
    config: sampleConfig,
    onMessage,
    createTransport: (adapterId, _config: ChannelAdapterConfig) => transports[adapterId],
  });
}

describe("createChannelExternalKey", () => {
  it("aligns with protocol normalizeChannelExternalKey", () => {
    expect(createChannelExternalKey("feishu", "chat", "oc_demo")).toBe("feishu:chat:oc_demo");
    expect(createChannelExternalKey("infoflow", "user", "u1")).toBe("infoflow:user:u1");
    expect(createChannelExternalKey("qqbot", "c2c", "u1")).toBe("qqbot:c2c:u1");
    expect(createChannelExternalKey("qqbot", "group", "g1")).toBe("qqbot:group:g1");
  });
});

describe("ChannelRegistry", () => {
  it("rejects unsupported feishu event modes at config parse time", () => {
    expect(() =>
      parseChannelsConfig({
        adapters: { feishu: { type: "feishu", event_mode: "polling" } },
        routes: {},
      }),
    ).toThrow(/feishu\.event_mode must be websocket/);
  });

  it("resolves routes and lists adapters", async () => {
    const registry = createTestRegistry(() => {}, {
      feishu: new FakeChannelTransport(),
      infoflow: new FakeChannelTransport(),
    });

    expect(registry.resolveRoute("ops")).toEqual({
      name: "ops",
      adapterId: "feishu",
      adapterType: "feishu",
      recipient: "oc_ops",
    });

    const listed = await registry.notify({ action: "list" });
    expect(listed.action).toBe("list");
    if (listed.action !== "list") throw new Error("expected list result");
    expect(listed.adapters.map((adapter) => adapter.id).sort()).toEqual(["feishu", "infoflow"]);
    expect(listed.routes.map((route) => route.name).sort()).toEqual(["alerts", "ops"]);
  });

  it("notify send and test deliver outbound text via route", async () => {
    const feishuTransport = new FakeChannelTransport();
    const infoflowTransport = new FakeChannelTransport();
    const registry = createTestRegistry(() => {}, {
      feishu: feishuTransport,
      infoflow: infoflowTransport,
    });

    const sent = await registry.notify({
      action: "send",
      route: "ops",
      text: "hello ops",
    });
    expect(sent).toMatchObject({
      action: "send",
      adapter: "feishu",
      recipient: "oc_ops",
      text: "hello ops",
    });
    expect(feishuTransport.sent).toEqual([{ recipient: "oc_ops", text: "hello ops" }]);

    const tested = await registry.notify({ action: "test", route: "alerts" });
    expect(tested).toMatchObject({
      action: "test",
      adapter: "infoflow",
      recipient: "user_alerts",
      text: "Spark channel test",
    });
    expect(infoflowTransport.sent).toEqual([
      { recipient: "user_alerts", text: "Spark channel test" },
    ]);
  });

  it("starts ingress listeners and normalizes feishu inbound externalKey", async () => {
    const feishuTransport = new FakeChannelTransport();
    const infoflowTransport = new FakeChannelTransport();
    const inbound: IncomingMessage[] = [];
    const registry = createTestRegistry((message) => inbound.push(message), {
      feishu: feishuTransport,
      infoflow: infoflowTransport,
    });

    await registry.startAll();
    feishuTransport.emitInbound({
      chat_id: "oc_inbound",
      sender_id: "ou_sender",
      text: "fix the build",
      message_id: "msg_feishu_1",
    });

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      adapter: "feishu",
      externalKey: "feishu:chat:oc_inbound",
      senderId: "ou_sender",
      chatId: "oc_inbound",
      text: "fix the build",
      messageId: "msg_feishu_1",
    });

    await registry.stopAll();
    expect(registry.listAdapters().every((adapter) => !adapter.running)).toBe(true);
  });

  it("normalizes infoflow inbound externalKey", async () => {
    const transport = new FakeChannelTransport();
    const inbound: IncomingMessage[] = [];
    const registry = new ChannelRegistry({
      config: {
        adapters: { infoflow: { type: "infoflow" } },
        routes: {},
        ingress: { enabled: true },
      },
      onMessage: (message) => inbound.push(message),
      createTransport: () => transport,
    });

    await registry.startAll();
    transport.emitInbound({
      user_id: "u_ops",
      text: "[文件: status.pdf]",
      message_id: "msg_if_1",
      content_type: "file",
      attachments: [
        { kind: "file", name: "status.pdf", mediaType: "application/pdf", reference: "fid-1" },
      ],
    });

    expect(inbound[0]?.externalKey).toBe("infoflow:user:u_ops");
    expect(inbound[0]?.senderId).toBe("u_ops");
    expect(inbound[0]).toMatchObject({
      contentType: "file",
      attachments: [
        { kind: "file", name: "status.pdf", mediaType: "application/pdf", reference: "fid-1" },
      ],
    });
  });

  it("keys group messages by group id under open policy", async () => {
    const transport = new FakeChannelTransport();
    const inbound: IncomingMessage[] = [];
    const registry = new ChannelRegistry({
      config: {
        adapters: {
          infoflow: {
            type: "infoflow",
            group_policy: "open",
            group_trigger: "all",
          },
        },
        routes: {},
        ingress: { enabled: true },
      },
      onMessage: (message) => inbound.push(message),
      createTransport: () => transport,
    });

    await registry.startAll();
    transport.emitInbound({
      user_id: "bob",
      text: "group hi",
      chat_type: "group",
      chat_id: "10838226",
      message_id: "g1",
      event_type: "MESSAGE_RECEIVE",
      mentioned_self: true,
    });
    transport.emitInbound({
      user_id: "bob",
      text: "group hi",
      chat_type: "group",
      chat_id: "10838226",
      message_id: "g1",
      event_type: "ALL_MESSAGE_FORWARD",
    });

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      externalKey: "infoflow:group:10838226",
      senderId: "bob",
      chatId: "10838226",
      text: "group hi",
      eventType: "MESSAGE_RECEIVE",
    });
  });

  it("parses infoflow allowlist fields", () => {
    const config = parseChannelsConfig({
      adapters: {
        infoflow: {
          type: "infoflow",
          allowed_user_ids: ["zhanrongrui"],
          group_policy: "allowlist",
          group_trigger: "command",
          allowed_group_ids: ["10838226"],
        },
      },
      routes: {},
    });
    expect(config.adapters.infoflow).toMatchObject({
      type: "infoflow",
      allowed_user_ids: ["zhanrongrui"],
      group_policy: "allowlist",
      group_trigger: "command",
      allowed_group_ids: ["10838226"],
    });
  });

  it("parses infoflow system_prompt custom overlay", () => {
    const config = parseChannelsConfig({
      adapters: {
        infoflow: {
          type: "infoflow",
          system_prompt: "  如流自定义  ",
        },
      },
      routes: {},
    });
    expect(config.adapters.infoflow).toMatchObject({
      type: "infoflow",
      system_prompt: "如流自定义",
    });
  });
});

describe("adapter parseInbound", () => {
  it("feishu and infoflow adapters expose consistent external keys", () => {
    const feishu = new FeishuAdapter({
      id: "feishu",
      config: { type: "feishu" },
      transport: new FakeChannelTransport(),
    });
    const infoflow = new InfoflowAdapter({
      id: "infoflow",
      config: { type: "infoflow" },
      transport: new FakeChannelTransport(),
    });

    expect(feishu.parseInbound({ chat_id: "oc_x", text: "hi" }).externalKey).toBe(
      "feishu:chat:oc_x",
    );
    expect(infoflow.parseInbound({ user_id: "u_x", text: "hi" }).externalKey).toBe(
      "infoflow:user:u_x",
    );
    expect(
      infoflow.parseInbound({
        user_id: "u_x",
        text: "hi",
        chat_type: "group",
        chat_id: "10838226",
      }).externalKey,
    ).toBe("infoflow:group:10838226");
    expect(
      infoflow.parseInbound({
        user_id: "u_x",
        text: "@spark hi",
        chat_type: "group",
        chat_id: "10838226",
        mentions: ["spark"],
        mentioned_self: true,
      }),
    ).toMatchObject({ mentions: ["spark"], mentionedSelf: true });
  });
});
