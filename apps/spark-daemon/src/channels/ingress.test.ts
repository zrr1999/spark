import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeChannelTransport, type ChannelTransport } from "@zendev-lab/spark-channels";
import { parseChannelsConfig } from "@zendev-lab/spark-channels";
import { defaultSparkSessionRegistryRoot, SparkSessionRegistry } from "@zendev-lab/spark-session";
import {
  createChannelIngressController,
  createDaemonChannelIngressRuntime,
  loadDaemonChannelsConfig,
  migrateLegacyChannelsConfig,
  workspaceChannelsConfigPath,
  type ChannelIngressAssignment,
} from "./ingress.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("channel ingress", () => {
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
        channelReply: {
          workspaceId: "ws_demo",
          adapterId: "feishu",
          recipient: "oc_demo",
        },
      },
    ]);
    await expect(registry.get(session.sessionId)).resolves.toMatchObject({ status: "running" });
    expect(controller.status().configured).toBe(true);
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
});
