import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelNotifyInput, ChannelNotifyResult } from "@zendev-lab/spark-channels";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type {
  DaemonChannelIngressRuntime,
  DaemonChannelIngressStatus,
} from "./channels/ingress.ts";
import { reconcileSessionNotificationDeliveries } from "./session-notification-delivery.ts";

describe("daemon session notification delivery reconciliation", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("retries due failed targets and permanently skips delivered targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-notification-reconcile-"));
    roots.push(root);
    let now = Date.parse("2026-07-15T05:00:00.000Z");
    const mailStore = new SparkSessionMailStore({ sparkHome: root, now: () => now });
    const session: SparkSessionRegistryRecord = {
      sessionId: "sess_reconcile",
      scope: { kind: "workspace", workspaceId: "ws_reconcile" },
      workspaceId: "ws_reconcile",
      status: "ready",
      bindings: [
        {
          kind: "channel",
          adapter: "infoflow",
          externalKey: "infoflow:group:group-1",
        },
      ],
      createdAt: "2026-07-15T04:00:00.000Z",
      updatedAt: "2026-07-15T04:00:00.000Z",
    };
    const status = channelStatus("ws_reconcile");
    let shouldFail = true;
    const notify = vi.fn(
      async (_workspaceId: string, input: ChannelNotifyInput): Promise<ChannelNotifyResult> => {
        if (shouldFail) throw new Error("gateway unavailable");
        if (!input.adapter || !input.recipient) throw new Error("missing delivery target");
        return {
          action: "send",
          adapter: input.adapter,
          recipient: input.recipient,
          text: input.text ?? "",
        };
      },
    );
    const deps = {
      mailStore,
      sessionRegistry: { get: vi.fn(async () => session) },
      channelIngress: { status: vi.fn(() => status), notify },
    } satisfies {
      mailStore: SparkSessionMailStore;
      sessionRegistry: { get(sessionId: string): Promise<SparkSessionRegistryRecord | undefined> };
      channelIngress: Pick<DaemonChannelIngressRuntime, "status" | "notify">;
    };
    const sent = await mailStore.send({
      toSessionId: session.sessionId,
      fromSessionId: "sess_sender",
      kind: "notification",
      visibility: "user",
      delivery: "channel",
      deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:group:group-1" }],
      body: "Build finished",
      source: "tool",
    });

    await expect(reconcileSessionNotificationDeliveries(deps)).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
    });
    expect(await mailStore.get(session.sessionId, sent.message.id)).toMatchObject({
      deliveries: [
        {
          status: "failed",
          attemptCount: 1,
          lastError: "gateway unavailable",
        },
      ],
    });

    shouldFail = false;
    await expect(reconcileSessionNotificationDeliveries(deps)).resolves.toEqual({
      attempted: 0,
      delivered: 0,
      failed: 0,
    });
    expect(notify).toHaveBeenCalledTimes(1);

    now += 2_000;
    await expect(reconcileSessionNotificationDeliveries(deps)).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(await mailStore.get(session.sessionId, sent.message.id)).toMatchObject({
      deliveries: [
        {
          status: "delivered",
          attemptCount: 2,
          lastError: null,
          receipt: { adapter: "info-main", recipient: "group:group-1" },
        },
      ],
    });

    now += 60_000;
    await expect(reconcileSessionNotificationDeliveries(deps)).resolves.toEqual({
      attempted: 0,
      delivered: 0,
      failed: 0,
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("honors each target backoff when only one target on a message is due", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-notification-target-backoff-"));
    roots.push(root);
    let now = Date.parse("2026-07-15T06:00:00.000Z");
    const mailStore = new SparkSessionMailStore({ sparkHome: root, now: () => now });
    const session: SparkSessionRegistryRecord = {
      sessionId: "sess_staggered",
      scope: { kind: "workspace", workspaceId: "ws_staggered" },
      workspaceId: "ws_staggered",
      status: "ready",
      bindings: [],
      createdAt: "2026-07-15T05:00:00.000Z",
      updatedAt: "2026-07-15T05:00:00.000Z",
    };
    const status = channelStatus("ws_staggered", [
      { id: "info-main", type: "infoflow" },
      { id: "qq-main", type: "qqbot" },
    ]);
    const notify = vi.fn(
      async (_workspaceId: string, input: ChannelNotifyInput): Promise<ChannelNotifyResult> => {
        if (!input.adapter || !input.recipient) throw new Error("missing delivery target");
        return {
          action: "send",
          adapter: input.adapter,
          recipient: input.recipient,
          text: input.text ?? "",
        };
      },
    );
    const deps = {
      mailStore,
      sessionRegistry: { get: vi.fn(async () => session) },
      channelIngress: { status: vi.fn(() => status), notify },
    } satisfies {
      mailStore: SparkSessionMailStore;
      sessionRegistry: { get(sessionId: string): Promise<SparkSessionRegistryRecord | undefined> };
      channelIngress: Pick<DaemonChannelIngressRuntime, "status" | "notify">;
    };
    const sent = await mailStore.send({
      toSessionId: session.sessionId,
      fromSessionId: "sess_sender",
      kind: "notification",
      visibility: "user",
      delivery: "channel",
      deliveryTargets: [
        { adapter: "infoflow", externalKey: "infoflow:user:user-1" },
        { adapter: "qqbot", externalKey: "qqbot:c2c:user-2" },
      ],
      body: "Staggered delivery",
      source: "tool",
    });
    await mailStore.recordChannelDelivery(
      session.sessionId,
      sent.message.id,
      { adapter: "qqbot", externalKey: "qqbot:c2c:user-2" },
      { ok: false, error: "qq unavailable" },
    );

    now += 1_000;
    await expect(reconcileSessionNotificationDeliveries(deps)).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith("ws_staggered", {
      action: "send",
      adapter: "info-main",
      recipient: "user-1",
      text: "Staggered delivery",
    });
    expect(await mailStore.get(session.sessionId, sent.message.id)).toMatchObject({
      deliveries: [
        { adapter: "infoflow", status: "delivered", attemptCount: 1 },
        { adapter: "qqbot", status: "failed", attemptCount: 1, lastError: "qq unavailable" },
      ],
    });

    now += 1_000;
    await expect(reconcileSessionNotificationDeliveries(deps)).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith("ws_staggered", {
      action: "send",
      adapter: "qq-main",
      recipient: "c2c:user-2",
      text: "Staggered delivery",
    });
  });

  it("isolates internal notification poison and still delivers later user mail", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-notification-poison-"));
    roots.push(root);
    let now = Date.parse("2026-07-15T07:00:00.000Z");
    const mailStore = new SparkSessionMailStore({ sparkHome: root, now: () => now });
    const session: SparkSessionRegistryRecord = {
      sessionId: "sess_poison",
      scope: { kind: "workspace", workspaceId: "ws_poison" },
      workspaceId: "ws_poison",
      status: "ready",
      bindings: [],
      createdAt: "2026-07-15T06:00:00.000Z",
      updatedAt: "2026-07-15T06:00:00.000Z",
    };
    const status = channelStatus("ws_poison");
    const notify = vi.fn(
      async (_workspaceId: string, input: ChannelNotifyInput): Promise<ChannelNotifyResult> => {
        if (!input.adapter || !input.recipient) throw new Error("missing delivery target");
        return {
          action: "send",
          adapter: input.adapter,
          recipient: input.recipient,
          text: input.text ?? "",
        };
      },
    );
    const deps = {
      mailStore,
      sessionRegistry: { get: vi.fn(async () => session) },
      channelIngress: { status: vi.fn(() => status), notify },
    } satisfies {
      mailStore: SparkSessionMailStore;
      sessionRegistry: { get(sessionId: string): Promise<SparkSessionRegistryRecord | undefined> };
      channelIngress: Pick<DaemonChannelIngressRuntime, "status" | "notify">;
    };
    const poison = await mailStore.send({
      toSessionId: session.sessionId,
      kind: "notification",
      visibility: "internal",
      delivery: "channel",
      deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:internal" }],
      body: "Internal only",
      source: "tool",
    });
    now += 1;
    const valid = await mailStore.send({
      toSessionId: session.sessionId,
      kind: "notification",
      visibility: "user",
      delivery: "channel",
      deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:visible" }],
      body: "Visible notification",
      source: "tool",
    });

    await expect(reconcileSessionNotificationDeliveries(deps)).resolves.toEqual({
      attempted: 2,
      delivered: 1,
      failed: 1,
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("ws_poison", {
      action: "send",
      adapter: "info-main",
      recipient: "visible",
      text: "Visible notification",
    });
    expect(await mailStore.get(session.sessionId, poison.message.id)).toMatchObject({
      deliveries: [
        {
          status: "failed",
          attemptCount: 1,
          lastError: expect.stringContaining("not user-visible"),
        },
      ],
    });
    expect(await mailStore.get(session.sessionId, valid.message.id)).toMatchObject({
      deliveries: [{ status: "delivered", attemptCount: 1 }],
    });
  });
});

function channelStatus(
  workspaceId: string,
  adapters: Array<{ id: string; type: "feishu" | "infoflow" | "qqbot" }> = [
    { id: "info-main", type: "infoflow" },
  ],
): DaemonChannelIngressStatus {
  return {
    plane: "daemon",
    resource: "channel",
    workspaceId,
    configPath: `/tmp/${workspaceId}/channels/config.json`,
    available: true,
    configured: true,
    ingressEnabled: true,
    state: "running",
    adapters: adapters.map((adapter) => ({
      ...adapter,
      running: true,
      state: "connected" as const,
    })),
    routes: [],
    observedAt: "2026-07-15T05:00:00.000Z",
    text: `channels workspace=${workspaceId} running`,
  };
}
