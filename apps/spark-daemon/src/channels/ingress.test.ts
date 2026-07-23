import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeChannelTransport,
  channelAdapterAccountIdentity,
  parseChannelsConfig,
  type ChannelReplyStream,
  type ChannelTransport,
} from "@zendev-lab/spark-channels";
import { defaultSparkSessionRegistryRoot, SparkSessionRegistry } from "@zendev-lab/spark-session";
import {
  CHANNEL_INGRESS_FAILURE_REPLY,
  channelIngressIdempotencyKey,
  createChannelIngressController,
  createDaemonChannelIngressRuntime,
  enrichInboundMessageReferenceFromSession,
  findChannelMessagePreviewById,
  loadDaemonChannelsConfig,
  migrateLegacyChannelsConfig,
  workspaceChannelsConfigPath,
  type ChannelIngressAssignment,
  type ChannelIngressRejectedReply,
} from "./ingress.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("channel ingress", () => {
  it("settles Infoflow text asks before ordinary turn admission", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-text-ask-"));
    roots.push(sparkHome);
    const onAssignment = vi.fn(async () => undefined);
    const onTextAskReply = vi.fn(async () => "settled" as const);
    let inbound: ((raw: unknown) => void) | undefined;
    const transport: ChannelTransport = {
      start: async (handler) => {
        inbound = handler;
      },
      stop: async () => undefined,
      send: async () => undefined,
    };
    const controller = createChannelIngressController({
      sparkHome,
      config: parseChannelsConfig({
        adapters: { infoflow: { type: "infoflow" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: {
        onAssignment,
        onTextAskReply,
      },
      sessionRegistry: {
        resolveBinding: async () => ({ sessionId: "sess_text_ask" }) as never,
      },
      workspaceId: "ws_text_ask",
      createTransport: () => transport,
    });

    await controller.start();
    inbound?.({
      user_id: "alice",
      text: "1",
      chat_type: "private",
      message_id: "msg_text_ask",
    });
    await controller.stop();

    expect(onTextAskReply).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_text_ask",
        recipient: "alice",
        message: expect.objectContaining({
          adapter: "infoflow",
          senderId: "alice",
          text: "1",
        }),
      }),
    );
    expect(onAssignment).not.toHaveBeenCalled();
  });

  it("reports admission failures without changing the session turn state", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-rejected-"));
    roots.push(sparkHome);
    const recordTurnQueued = vi.fn(async () => undefined);
    const recordTurnSettled = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    let inbound: ((raw: unknown) => void) | undefined;
    const transport: ChannelTransport = {
      start: async (handler) => {
        inbound = handler;
      },
      stop: async () => undefined,
      send: async () => undefined,
      reply: {
        openReplyStream: async () => undefined,
        sendReply,
      },
    };
    const controller = createChannelIngressController({
      sparkHome,
      config: parseChannelsConfig({
        adapters: { infoflow: { type: "infoflow" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: {
        onAssignment: async () => {
          throw new Error("provider login expired");
        },
      },
      sessionRegistry: {
        resolveBinding: async () => ({ sessionId: "sess_rejected" }) as never,
        recordTurnQueued: recordTurnQueued as never,
        recordTurnSettled: recordTurnSettled as never,
      },
      workspaceId: "ws_rejected",
      createTransport: () => transport,
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await controller.start();
      inbound?.({
        user_id: "user-1",
        text: "请处理",
        message_id: "message-1",
      });
      await controller.stop();

      expect(recordTurnQueued).not.toHaveBeenCalled();
      expect(recordTurnSettled).not.toHaveBeenCalled();
      expect(sendReply).toHaveBeenCalledWith({
        recipient: "user-1",
        senderId: "user-1",
        messageId: "message-1",
        preview: "请处理",
        text: CHANNEL_INGRESS_FAILURE_REPLY,
        deliveryId: expect.stringMatching(/^channel-ingress-failure:/),
      });
    } finally {
      log.mockRestore();
    }
  });

  it("persists one stable admission-failure intent without sending inline", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-rejected-outbox-"));
    roots.push(sparkHome);
    const sendReply = vi.fn(async () => undefined);
    const onRejectedReply = vi.fn(async (_input: ChannelIngressRejectedReply) => undefined);
    const transport: ChannelTransport = {
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
      reply: {
        openReplyStream: async () => undefined,
        sendReply,
      },
    };
    const controller = createChannelIngressController({
      sparkHome,
      config: parseChannelsConfig({
        adapters: { infoflow: { type: "infoflow" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: {
        onAssignment: async () => {
          throw new Error("admission unavailable");
        },
        onRejectedReply,
      },
      sessionRegistry: {
        resolveBinding: async () => ({ sessionId: "sess_rejected_outbox" }) as never,
      },
      workspaceId: "ws_rejected_outbox",
      createTransport: () => transport,
    });
    const inbound = {
      adapter: "infoflow" as const,
      externalKey: "infoflow:user:user-1",
      senderId: "user-1",
      text: "请处理",
      messageId: "message-1",
    };

    await expect(controller.admitInbound(inbound)).resolves.toBeUndefined();
    await expect(controller.admitInbound(inbound)).resolves.toBeUndefined();

    expect(sendReply).not.toHaveBeenCalled();
    expect(onRejectedReply).toHaveBeenCalledTimes(2);
    const first = onRejectedReply.mock.calls[0]![0];
    const second = onRejectedReply.mock.calls[1]![0];
    expect(first).toMatchObject({
      sessionId: "sess_rejected_outbox",
      workspaceId: "ws_rejected_outbox",
      externalKey: "infoflow:user:user-1",
      adapterId: "infoflow",
      adapterAccountIdentity: channelAdapterAccountIdentity({ type: "infoflow" }),
      text: CHANNEL_INGRESS_FAILURE_REPLY,
      deliveryFacts: { replaySafety: "unsafe" },
    });
    expect(first.deliveryIdentity).toBe(second.deliveryIdentity);
  });

  it("forwards reply-stream creation callbacks through ingress", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-stream-created-"));
    roots.push(sparkHome);
    const stream: ChannelReplyStream = {
      appendText: vi.fn(),
      notifyToolStart: vi.fn(),
      notifyToolResult: vi.fn(),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    const openReplyStream = vi.fn(async () => stream);
    const transport: ChannelTransport = {
      start: async () => undefined,
      stop: async () => undefined,
      send: async () => undefined,
      reply: {
        openReplyStream,
        sendReply: async () => undefined,
      },
    };
    const onCreated = vi.fn(async () => undefined);
    const controller = createChannelIngressController({
      sparkHome,
      config: parseChannelsConfig({
        adapters: { infoflow: { type: "infoflow" } },
        routes: {},
      }),
      hooks: { onAssignment: async () => undefined },
      workspaceId: "ws_stream_created",
      createTransport: () => transport,
    });

    await expect(
      controller.openReplyStream("infoflow", { recipient: "user-1" }, { onCreated }),
    ).resolves.toBe(stream);
    expect(openReplyStream).toHaveBeenCalledWith({ recipient: "user-1" });
    expect(onCreated).toHaveBeenCalledWith(stream);
  });

  it("derives durable deduplication only from platform message identity", () => {
    const assignment: ChannelIngressAssignment = {
      sessionId: "sess_channel",
      goal: "same text",
      assignment: {
        goal: "same text",
        target: { sessionId: "sess_channel", workspaceId: "workspace-1" },
        constraints: [],
        evidence: [],
        source: { kind: "channel", channel: "infoflow", externalRef: "message-1" },
      },
      source: { kind: "channel", channel: "infoflow", externalRef: "message-1" },
      externalKey: "infoflow:user:user-1",
      adapterAccountIdentity: "channel-account:infoflow:account-a",
      channelReply: {
        workspaceId: "workspace-1",
        adapter: "infoflow",
        adapterId: "infoflow",
        externalKey: "infoflow:user:user-1",
        recipient: "user-1",
      },
      channelContext: {
        externalKey: "infoflow:user:user-1",
        messageId: "message-1",
      },
    };

    expect(channelIngressIdempotencyKey(assignment)).toBe(
      channelIngressIdempotencyKey({ ...assignment, goal: "changed after redelivery" }),
    );
    expect(
      channelIngressIdempotencyKey({
        ...assignment,
        source: { ...assignment.source, externalRef: "message-2" },
        channelContext: { externalKey: assignment.externalKey, messageId: "message-2" },
      }),
    ).not.toBe(channelIngressIdempotencyKey(assignment));
    expect(
      channelIngressIdempotencyKey({
        ...assignment,
        source: { kind: "channel", channel: "infoflow" },
        channelContext: { externalKey: assignment.externalKey },
      }),
    ).toBeUndefined();
  });

  it("leaves the real turn state unchanged for a durable platform redelivery", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-duplicate-"));
    roots.push(sparkHome);
    const recordTurnQueued = vi.fn(async () => undefined);
    const recordTurnSettled = vi.fn(async () => undefined);
    const transport = new FakeChannelTransport();
    const controller = createChannelIngressController({
      sparkHome,
      config: parseChannelsConfig({
        adapters: { infoflow: { type: "infoflow" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: { onAssignment: async () => "duplicate" },
      sessionRegistry: {
        resolveBinding: async () => ({ sessionId: "sess_duplicate" }) as never,
        recordTurnQueued: recordTurnQueued as never,
        recordTurnSettled: recordTurnSettled as never,
      },
      workspaceId: "ws_duplicate",
      createTransport: () => transport,
    });

    await controller.start();
    transport.emitInbound({
      user_id: "user-1",
      text: "same delivery",
      message_id: "message-1",
    });
    await controller.stop();

    expect(recordTurnQueued).not.toHaveBeenCalled();
    expect(recordTurnSettled).not.toHaveBeenCalled();
  });

  it("passes workspace identity to daemon-owned transport creation", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-transport-context-"));
    roots.push(sparkHome);
    const transport = new FakeChannelTransport();
    const createWorkspaceTransport = vi.fn(() => transport);
    const runtime = createDaemonChannelIngressRuntime({
      sparkHome,
      hooks: { onAssignment: async () => undefined },
      createWorkspaceTransport,
    });

    await runtime.configure(
      "ws_transport",
      parseChannelsConfig({
        adapters: { "qq-main": { type: "qqbot", app_id: "app", client_secret: "secret" } },
        routes: {},
      }),
    );

    expect(createWorkspaceTransport).toHaveBeenCalledWith({
      workspaceId: "ws_transport",
      adapterId: "qq-main",
      config: { type: "qqbot", app_id: "app", client_secret: "secret" },
    });
    await runtime.stop();
  });

  it("resolves binding and emits assignment for feishu inbound", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-ingress-"));
    roots.push(sparkHome);
    const registry = new SparkSessionRegistry({
      rootDir: defaultSparkSessionRegistryRoot(sparkHome),
    });
    const session = await registry.create({
      workspaceId: "ws_demo",
      title: "Ops",
    });
    await registry.bind({
      sessionId: session.sessionId,
      externalKey: "feishu:chat:oc_demo",
    });

    const assignments: ChannelIngressAssignment[] = [];
    const feishuTransport = new FakeChannelTransport();
    const controller = createChannelIngressController({
      sparkHome,
      config: parseChannelsConfig({
        adapters: {
          feishu: { type: "feishu" },
        },
        routes: {},
        ingress: { enabled: true, on_unbound: "reject" },
      }),
      hooks: {
        onAssignment: async (input) => {
          assignments.push(input);
        },
      },
      workspaceId: "ws_demo",
      createTransport: () => feishuTransport,
    });

    await controller.start();
    feishuTransport.emitInbound({
      chat_id: "oc_demo",
      text: "ship the assign panel",
      message_id: "m1",
    });
    await vi.waitFor(() => expect(assignments).toHaveLength(1));
    await controller.stop();

    expect(assignments).toEqual([
      {
        sessionId: session.sessionId,
        goal: "ship the assign panel",
        assignment: {
          goal: "ship the assign panel",
          target: { sessionId: session.sessionId, workspaceId: "ws_demo" },
          constraints: [],
          evidence: [],
          source: { kind: "channel", channel: "feishu", externalRef: "m1" },
        },
        source: { kind: "channel", channel: "feishu", externalRef: "m1" },
        externalKey: "feishu:chat:oc_demo",
        adapterAccountIdentity: channelAdapterAccountIdentity({ type: "feishu" }),
        channelReply: {
          workspaceId: "ws_demo",
          adapter: "feishu",
          adapterId: "feishu",
          externalKey: "feishu:chat:oc_demo",
          recipient: "oc_demo",
        },
        channelContext: {
          externalKey: "feishu:chat:oc_demo",
          chatId: "oc_demo",
          messageId: "m1",
        },
      },
    ]);
    await expect(registry.get(session.sessionId)).resolves.toMatchObject({ status: "running" });
    expect(controller.status().configured).toBe(true);
  });

  it("waits for already-received inbound admission before stopping", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-drain-"));
    roots.push(sparkHome);
    const registry = new SparkSessionRegistry({
      rootDir: defaultSparkSessionRegistryRoot(sparkHome),
    });
    const session = await registry.create({ workspaceId: "ws_drain", title: "Drain" });
    await registry.bind({
      sessionId: session.sessionId,
      externalKey: "feishu:chat:oc_drain",
    });
    const assignmentStarted = deferred<void>();
    const finishAssignment = deferred<void>();
    const transport = new FakeChannelTransport();
    const controller = createChannelIngressController({
      sparkHome,
      config: parseChannelsConfig({
        adapters: { feishu: { type: "feishu" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "reject" },
      }),
      hooks: {
        onAssignment: async () => {
          assignmentStarted.resolve(undefined);
          await finishAssignment.promise;
        },
      },
      workspaceId: "ws_drain",
      createTransport: () => transport,
    });

    await controller.start();
    transport.emitInbound({ chat_id: "oc_drain", text: "queue before restart" });
    await assignmentStarted.promise;
    let stopped = false;
    const stopping = controller.stop().then(() => {
      stopped = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    finishAssignment.resolve(undefined);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("resolves binding and emits assignment for qqbot c2c inbound", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-qqbot-"));
    roots.push(sparkHome);
    const assignments: ChannelIngressAssignment[] = [];
    const qqbotTransport = new FakeChannelTransport();
    const controller = createChannelIngressController({
      sparkHome,
      config: parseChannelsConfig({
        adapters: {
          qqbot: { type: "qqbot", app_id: "app", client_secret: "secret" },
        },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: {
        onAssignment: async (input) => {
          assignments.push(input);
        },
      },
      workspaceId: "ws_qq",
      createTransport: () => qqbotTransport,
    });

    await controller.start();
    qqbotTransport.emitInbound({
      event_type: "C2C_MESSAGE_CREATE",
      d: {
        id: "qm1",
        content: "hello from qq",
        author: { user_openid: "openid_u1" },
      },
    });
    await vi.waitFor(() => expect(assignments).toHaveLength(1));
    await controller.stop();

    expect(assignments[0]).toMatchObject({
      goal: "hello from qq",
      externalKey: "qqbot:c2c:openid_u1",
      source: { kind: "channel", channel: "qqbot", externalRef: "qm1" },
      channelReply: {
        workspaceId: "ws_qq",
        adapterId: "qqbot",
        externalKey: "qqbot:c2c:openid_u1",
        recipient: "c2c:openid_u1",
      },
      channelContext: {
        externalKey: "qqbot:c2c:openid_u1",
        senderId: "openid_u1",
        messageId: "qm1",
      },
    });
  });

  it("resolves inbound messages through the injected daemon session owner", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-session-owner-"));
    roots.push(sparkHome);
    const assignments: ChannelIngressAssignment[] = [];
    const resolveBinding = vi.fn(async () => ({
      sessionId: "session_owned",
      scope: { kind: "workspace" as const, workspaceId: "ws_owned" },
      workspaceId: "ws_owned",
      status: "ready" as const,
      bindings: [],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }));
    const transport = new FakeChannelTransport();
    const controller = createChannelIngressController({
      sparkHome,
      config: parseChannelsConfig({
        adapters: { infoflow: { type: "infoflow" } },
        routes: {},
        ingress: { enabled: true, on_unbound: "create" },
      }),
      hooks: {
        onAssignment: async (input) => {
          assignments.push(input);
        },
      },
      sessionRegistry: { resolveBinding },
      workspaceId: "ws_owned",
      createTransport: () => transport,
    });

    await controller.start();
    transport.emitInbound({
      user_id: "u_owned",
      sender_name: "Owned User",
      text: "owned mutation\n[文件: plan.pdf]",
      message_id: "infoflow-message-1",
      content_type: "mixed",
      attachments: [{ kind: "file", name: "plan.pdf", reference: "fid-plan" }],
    });
    await vi.waitFor(() => expect(assignments).toHaveLength(1));
    await controller.stop();

    expect(resolveBinding).toHaveBeenCalledWith({
      externalKey: "infoflow:user:u_owned",
      adapterId: "infoflow",
      adapterAccountIdentity: channelAdapterAccountIdentity({ type: "infoflow" }),
      allowLegacyAccountClaim: true,
      onUnbound: "create",
      create: { workspaceId: "ws_owned", title: "channel infoflow:user:u_owned" },
    });
    await expect(
      readFile(join(defaultSparkSessionRegistryRoot(sparkHome), "registry.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(assignments[0]).toMatchObject({
      goal: "owned mutation\n[文件: plan.pdf]",
      assignment: { goal: "owned mutation\n[文件: plan.pdf]" },
      channelContext: {
        externalKey: "infoflow:user:u_owned",
        senderId: "u_owned",
        senderName: "Owned User",
        messageId: "infoflow-message-1",
        contentType: "mixed",
        attachments: [{ kind: "file", name: "plan.pdf", reference: "fid-plan" }],
      },
    });
    expect(assignments[0]?.goal).not.toContain("You are handling an Infoflow");
  });

  it("loads missing workspace config as null", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-config-"));
    roots.push(sparkHome);
    const loaded = await loadDaemonChannelsConfig(sparkHome, "ws_missing");
    expect(loaded.config).toBeNull();
    expect(loaded.path).toBe(workspaceChannelsConfigPath(sparkHome, "ws_missing"));
  });

  it("migrates legacy global config into a workspace path", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-migrate-"));
    roots.push(sparkHome);
    await mkdir(join(sparkHome, "channels"), { recursive: true });
    const legacy = {
      adapters: { infoflow: { type: "infoflow" } },
      routes: { ops: { adapter: "infoflow", recipient: "u1" } },
      ingress: { enabled: true },
    };
    await writeFile(join(sparkHome, "channels", "config.json"), JSON.stringify(legacy));
    expect(await migrateLegacyChannelsConfig(sparkHome, "ws_spore")).toBe(true);
    const loaded = await loadDaemonChannelsConfig(sparkHome, "ws_spore");
    expect(loaded.config?.adapters.infoflow?.type).toBe("infoflow");
    expect(await migrateLegacyChannelsConfig(sparkHome, "ws_spore")).toBe(false);
  });

  it("configures channel ingress per workspace and stores credentials privately", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-runtime-"));
    roots.push(sparkHome);
    const stableTransport = new FakeChannelTransport();
    let failNextStart = false;
    const runtime = createDaemonChannelIngressRuntime({
      sparkHome,
      hooks: { onAssignment: async () => {} },
      createTransport: () => {
        if (!failNextStart) return stableTransport;
        return {
          async start() {
            throw new Error("replacement transport failed");
          },
          async stop() {},
          async send() {},
        } satisfies ChannelTransport;
      },
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });
    await runtime.start();

    const config = parseChannelsConfig({
      adapters: {
        feishu: {
          type: "feishu",
          event_mode: "websocket",
          app_id: "cli_demo",
          app_secret: "secret_demo",
        },
      },
      routes: { ops: { adapter: "feishu", recipient: "oc_ops" } },
      ingress: { enabled: true, on_unbound: "reject" },
    });
    const configured = await runtime.configure("ws_demo", config);
    expect(configured).toMatchObject({
      workspaceId: "ws_demo",
      configured: true,
      state: "running",
      adapters: [{ id: "feishu", running: true, state: "connected" }],
      routes: [{ name: "ops", adapter: "feishu", recipient: "oc_ops" }],
    });
    expect(stableTransport.isRunning).toBe(true);
    stableTransport.status = () => ({ state: "reconnecting" });
    expect(runtime.status("ws_demo")).toMatchObject({
      state: "degraded",
      adapters: [{ id: "feishu", running: true, state: "reconnecting" }],
    });
    const configPath = workspaceChannelsConfigPath(sparkHome, "ws_demo");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(config);
    if (process.platform !== "win32") {
      expect((await stat(join(sparkHome, "workspaces", "ws_demo", "channels"))).mode & 0o777).toBe(
        0o700,
      );
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }

    failNextStart = true;
    await expect(runtime.configure("ws_demo", config)).rejects.toThrow(
      "replacement transport failed",
    );
    expect(stableTransport.isRunning).toBe(true);
    expect(runtime.status("ws_demo")).toMatchObject({
      workspaceId: "ws_demo",
      configured: true,
      state: "degraded",
      adapters: [{ id: "feishu", running: true }],
      error: "replacement transport failed",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(config);
    await runtime.stop();
  });

  it("routes native interactions through a daemon handler installed after runtime creation", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-channel-interaction-runtime-"));
    roots.push(sparkHome);
    const transport = new FakeChannelTransport();
    const runtime = createDaemonChannelIngressRuntime({
      sparkHome,
      hooks: { onAssignment: async () => undefined },
      createTransport: () => transport,
    });
    await runtime.configure(
      "ws_qq",
      parseChannelsConfig({
        adapters: { qq: { type: "qqbot", app_id: "app", client_secret: "secret" } },
        routes: {},
        ingress: { enabled: true },
      }),
    );
    const interactions: unknown[] = [];
    runtime.setInteractionHandler?.(async (input) => {
      interactions.push(input);
    });

    await transport.emitInteraction({
      adapter: "qqbot",
      interactionId: "interaction_1",
      actorId: "user_1",
      scene: "c2c",
      recipient: "c2c:user_1",
      buttonData: "opaque_token",
    });

    await vi.waitFor(() => expect(interactions).toHaveLength(1));
    expect(interactions).toEqual([
      {
        workspaceId: "ws_qq",
        event: {
          adapter: "qqbot",
          adapterId: "qq",
          interactionId: "interaction_1",
          actorId: "user_1",
          scene: "c2c",
          recipient: "c2c:user_1",
          buttonData: "opaque_token",
        },
      },
    ]);
    runtime.setInteractionHandler?.(async () => {
      throw new Error("durable settlement unavailable");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        transport.emitInteraction({
          adapter: "qqbot",
          interactionId: "interaction_2",
          actorId: "user_1",
          scene: "c2c",
          recipient: "c2c:user_1",
          buttonData: "opaque_token_2",
        }),
      ).rejects.toThrow("durable settlement unavailable");
    } finally {
      log.mockRestore();
    }
    await runtime.stop();
  });
});

describe("channel quote enrichment", () => {
  it("finds prior channel message text by platform messageId", () => {
    expect(
      findChannelMessagePreviewById(
        [
          {
            version: 1,
            id: "1",
            role: "user",
            text: "先说一声",
            status: "done",
            createdAt: "2026-01-01T00:00:00.000Z",
            metadata: { channel: { messageId: "m-old" } },
          },
          {
            version: 1,
            id: "2",
            role: "assistant",
            text: "收到",
            status: "done",
            createdAt: "2026-01-01T00:00:01.000Z",
            metadata: { channel: { messageId: "m-bot" } },
          },
        ],
        "m-bot",
      ),
    ).toBe("收到");
  });

  it("enriches inbound messageReference preview from session history", async () => {
    const session = {
      sessionId: "sess_quote",
      status: "ready" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scope: { kind: "workspace" as const, workspaceId: "ws" },
      workspaceId: "ws",
      bindings: [],
      sessionPath: "/tmp/does-not-exist-for-enrich.jsonl",
    };
    const enriched = await enrichInboundMessageReferenceFromSession({
      message: {
        adapter: "qqbot",
        externalKey: "qqbot:c2c:u1",
        text: "继续",
        messageId: "m-new",
        messageReference: { messageId: "m-bot", source: "unknown" },
      },
      session,
      sparkHome: "/tmp/spark-quote-enrich",
      getSession: async () => session,
    });
    // Missing transcript leaves the reference intact without inventing preview.
    expect(enriched.messageReference).toEqual({ messageId: "m-bot", source: "unknown" });
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
