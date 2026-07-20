import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelNotifyInput, ChannelNotifyResult } from "@zendev-lab/spark-channels";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type {
  DaemonChannelIngressRuntime,
  DaemonChannelIngressStatus,
} from "./channels/ingress.ts";
import {
  createDaemonChannelDeliveryOutbox,
  reconcileDaemonChannelDeliveries,
} from "./channels/delivery-outbox.ts";
import {
  deliverSessionNotification,
  reconcileSessionNotificationDeliveries,
  sessionNotificationDeliveryIdempotencyKey,
  sessionNotificationLegacyDeliveryIdempotencyKey,
} from "./session-notification-delivery.ts";
import { SparkChannelDeliveryStore } from "./store/channel-deliveries.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

describe("daemon session notification delivery reconciliation", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("persists notification intent before send and never blind-resends after receipt projection fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-notification-outbox-"));
    roots.push(root);
    const now = "2026-07-15T04:30:00.000Z";
    const mailStore = new SparkSessionMailStore({ sparkHome: root, now: () => Date.parse(now) });
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const deliveryStore = new SparkChannelDeliveryStore(db, { now: () => now, random: () => 1 });
    const deliveryOutbox = createDaemonChannelDeliveryOutbox(deliveryStore);
    const session: SparkSessionRegistryRecord = {
      sessionId: "sess_outbox",
      scope: { kind: "workspace", workspaceId: "ws_outbox" },
      workspaceId: "ws_outbox",
      status: "ready",
      bindings: [],
      createdAt: now,
      updatedAt: now,
    };
    const status = channelStatus("ws_outbox");
    const notify = vi.fn(async (_workspaceId: string, input: ChannelNotifyInput) => ({
      action: "send" as const,
      adapter: input.adapter!,
      recipient: input.recipient!,
      text: input.text ?? "",
    }));
    const baseDeps = {
      mailStore,
      sessionRegistry: { get: vi.fn(async () => session) },
      channelIngress: { status: vi.fn(() => status), notify },
      deliveryQueue: { store: deliveryStore, outbox: deliveryOutbox },
    };
    const sent = await mailStore.send({
      toSessionId: session.sessionId,
      kind: "notification",
      visibility: "user",
      delivery: "channel",
      deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:user-1" }],
      body: "Durable notice",
      source: "tool",
    });

    try {
      await expect(reconcileSessionNotificationDeliveries(baseDeps)).resolves.toEqual({
        attempted: 1,
        delivered: 0,
        failed: 0,
      });
      expect(notify).not.toHaveBeenCalled();
      const key = sessionNotificationDeliveryIdempotencyKey({
        sessionId: session.sessionId,
        messageId: sent.message.id,
        correlationId: sent.message.correlationId,
        adapter: "infoflow",
        externalKey: "infoflow:user:user-1",
      });
      expect(deliveryStore.findByIdempotencyKey(key)).toMatchObject({
        kind: "notification",
        status: "pending",
      });

      await expect(
        reconcileDaemonChannelDeliveries({
          store: deliveryStore,
          workerId: "notification-worker",
          channelIngress: {
            notify,
            sendReply: vi.fn(),
            sendAsk: vi.fn(),
            ackInteraction: vi.fn(),
          },
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0, uncertain: 0 });
      expect(notify).toHaveBeenCalledOnce();

      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          reconcileSessionNotificationDeliveries({
            ...baseDeps,
            mailStore: {
              pendingChannelDeliveries: mailStore.pendingChannelDeliveries.bind(mailStore),
              get: mailStore.get.bind(mailStore),
              recordChannelDelivery: vi.fn(async () => {
                throw new Error("mailbox readonly");
              }),
            },
          }),
        ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 1 });
      } finally {
        log.mockRestore();
      }
      expect(notify).toHaveBeenCalledOnce();

      await expect(reconcileSessionNotificationDeliveries(baseDeps)).resolves.toEqual({
        attempted: 1,
        delivered: 1,
        failed: 0,
      });
      expect(notify).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it("projects an uncertain durable outcome without attempting another platform send", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-notification-uncertain-"));
    roots.push(root);
    const now = "2026-07-15T04:45:00.000Z";
    const mailStore = new SparkSessionMailStore({ sparkHome: root, now: () => Date.parse(now) });
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const deliveryStore = new SparkChannelDeliveryStore(db, { now: () => now, random: () => 1 });
    const deliveryOutbox = createDaemonChannelDeliveryOutbox(deliveryStore);
    const session: SparkSessionRegistryRecord = {
      sessionId: "sess_uncertain",
      scope: { kind: "workspace", workspaceId: "ws_uncertain" },
      workspaceId: "ws_uncertain",
      status: "ready",
      bindings: [],
      createdAt: now,
      updatedAt: now,
    };
    const notify = vi.fn();
    const deps = {
      mailStore,
      sessionRegistry: { get: vi.fn(async () => session) },
      channelIngress: {
        status: vi.fn(() => channelStatus(session.workspaceId)),
        notify,
      },
      deliveryQueue: { store: deliveryStore, outbox: deliveryOutbox },
    };
    try {
      const sent = await mailStore.send({
        toSessionId: session.sessionId,
        kind: "notification",
        visibility: "user",
        deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:user-1" }],
        body: "Outcome may be external",
        source: "tool",
      });
      await deliverSessionNotification(
        { sessionId: session.sessionId, messageId: sent.message.id },
        deps,
      );
      const claimed = deliveryStore.claimDue("uncertain-worker");
      if (!claimed?.leaseToken) throw new Error("expected a claimed notification delivery");
      deliveryStore.markDispatchStarted(claimed.deliveryId, claimed.leaseToken);
      deliveryStore.recordFailure(
        claimed.deliveryId,
        claimed.leaseToken,
        "provider response was lost",
        { outcome: "unknown", replaySafety: "unsafe" },
      );

      await expect(reconcileSessionNotificationDeliveries(deps)).resolves.toEqual({
        attempted: 1,
        delivered: 0,
        failed: 1,
      });
      expect(notify).not.toHaveBeenCalled();
      expect(deliveryStore.require(claimed.deliveryId)).toMatchObject({
        status: "uncertain",
        lastError: "provider response was lost",
      });
      expect(await mailStore.get(session.sessionId, sent.message.id)).toMatchObject({
        deliveries: [
          {
            status: "uncertain",
            lastError: "provider response was lost",
          },
        ],
      });
      await expect(reconcileSessionNotificationDeliveries(deps)).resolves.toEqual({
        attempted: 0,
        delivered: 0,
        failed: 0,
      });
    } finally {
      db.close();
    }
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

  it("keeps internal notifications mailbox-only and still delivers later user mail", async () => {
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
    const internal = await mailStore.send({
      toSessionId: session.sessionId,
      kind: "notification",
      body: "Internal only",
      source: "tool",
    });
    await expect(
      mailStore.send({
        toSessionId: session.sessionId,
        kind: "notification",
        visibility: "internal",
        deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:internal" }],
        body: "Must not leave the mailbox",
        source: "tool",
      }),
    ).rejects.toThrow(/explicit user visibility/u);
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
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("ws_poison", {
      action: "send",
      adapter: "info-main",
      recipient: "visible",
      text: "Visible notification",
    });
    expect(await mailStore.get(session.sessionId, internal.message.id)).toMatchObject({
      visibility: "internal",
      delivery: "mailbox",
      deliveries: [],
    });
    expect(await mailStore.get(session.sessionId, valid.message.id)).toMatchObject({
      deliveries: [{ status: "delivered", attemptCount: 1 }],
    });
  });
  it("deduplicates explicit user-visible delivery by correlation and target", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-notification-correlation-"));
    roots.push(root);
    const now = "2026-07-15T08:00:00.000Z";
    const mailStore = new SparkSessionMailStore({ sparkHome: root, now: () => Date.parse(now) });
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const deliveryStore = new SparkChannelDeliveryStore(db, { now: () => now, random: () => 1 });
    const deliveryOutbox = createDaemonChannelDeliveryOutbox(deliveryStore);
    const session: SparkSessionRegistryRecord = {
      sessionId: "sess_correlation",
      scope: { kind: "workspace", workspaceId: "ws_correlation" },
      workspaceId: "ws_correlation",
      status: "ready",
      bindings: [],
      createdAt: now,
      updatedAt: now,
    };
    const deps = {
      mailStore,
      sessionRegistry: { get: vi.fn(async () => session) },
      channelIngress: {
        status: vi.fn(() => channelStatus("ws_correlation")),
        notify: vi.fn(),
      },
      deliveryQueue: { store: deliveryStore, outbox: deliveryOutbox },
    };
    try {
      const first = await mailStore.send({
        toSessionId: session.sessionId,
        kind: "notification",
        visibility: "user",
        deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:user-1" }],
        correlationId: "corr:completion-1",
        body: "Completed",
        source: "tool",
      });
      const replay = await mailStore.send({
        toSessionId: session.sessionId,
        kind: "notification",
        visibility: "user",
        deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:user-1" }],
        correlationId: "corr:completion-1",
        body: "Completed again",
        source: "tool",
      });

      await deliverSessionNotification(
        { sessionId: session.sessionId, messageId: first.message.id },
        deps,
      );
      await deliverSessionNotification(
        { sessionId: session.sessionId, messageId: replay.message.id },
        deps,
      );

      const key = sessionNotificationDeliveryIdempotencyKey({
        sessionId: session.sessionId,
        messageId: first.message.id,
        correlationId: "corr:completion-1",
        adapter: "infoflow",
        externalKey: "infoflow:user:user-1",
      });
      expect(deliveryStore.findByIdempotencyKey(key)).toBeDefined();
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM channel_deliveries WHERE kind = 'notification'")
          .get(),
      ).toMatchObject({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("queues same-recipient notifications per stable provider account", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-notification-accounts-"));
    roots.push(root);
    const now = "2026-07-15T08:15:00.000Z";
    const mailStore = new SparkSessionMailStore({ sparkHome: root, now: () => Date.parse(now) });
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const deliveryStore = new SparkChannelDeliveryStore(db, { now: () => now, random: () => 1 });
    const deliveryOutbox = createDaemonChannelDeliveryOutbox(deliveryStore);
    const session: SparkSessionRegistryRecord = {
      sessionId: "sess_accounts",
      scope: { kind: "workspace", workspaceId: "ws_accounts" },
      workspaceId: "ws_accounts",
      status: "ready",
      bindings: [],
      createdAt: now,
      updatedAt: now,
    };
    const status = channelStatus(session.workspaceId, [
      {
        id: "info-a-current",
        type: "infoflow",
        adapterAccountIdentity: "channel-account:infoflow:a",
      },
      {
        id: "info-b-current",
        type: "infoflow",
        adapterAccountIdentity: "channel-account:infoflow:b",
      },
    ]);
    try {
      const sent = await mailStore.send({
        toSessionId: session.sessionId,
        kind: "notification",
        visibility: "user",
        correlationId: "corr:multi-account",
        deliveryTargets: [
          {
            adapter: "infoflow",
            externalKey: "infoflow:user:shared",
            adapterId: "info-a-old",
            adapterAccountIdentity: "channel-account:infoflow:a",
          },
          {
            adapter: "infoflow",
            externalKey: "infoflow:user:shared",
            adapterId: "info-b-old",
            adapterAccountIdentity: "channel-account:infoflow:b",
          },
        ],
        body: "Account-scoped notification",
        source: "tool",
      });

      await deliverSessionNotification(
        { sessionId: session.sessionId, messageId: sent.message.id },
        {
          mailStore,
          sessionRegistry: { get: vi.fn(async () => session) },
          channelIngress: { status: vi.fn(() => status), notify: vi.fn() },
          deliveryQueue: { store: deliveryStore, outbox: deliveryOutbox },
        },
      );

      const keys = ["channel-account:infoflow:a", "channel-account:infoflow:b"].map(
        (adapterAccountIdentity) =>
          sessionNotificationDeliveryIdempotencyKey({
            sessionId: session.sessionId,
            messageId: sent.message.id,
            correlationId: sent.message.correlationId,
            adapter: "infoflow",
            externalKey: "infoflow:user:shared",
            adapterAccountIdentity,
          }),
      );
      expect(keys[0]).not.toBe(keys[1]);
      expect(deliveryStore.findByIdempotencyKey(keys[0]!)).toMatchObject({
        payload: {
          adapterId: "info-a-current",
          adapterAccountIdentity: "channel-account:infoflow:a",
        },
      });
      expect(deliveryStore.findByIdempotencyKey(keys[1]!)).toMatchObject({
        payload: {
          adapterId: "info-b-current",
          adapterAccountIdentity: "channel-account:infoflow:b",
        },
      });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM channel_deliveries WHERE kind = 'notification'")
          .get(),
      ).toMatchObject({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("direct-sends through the adapter selected by stable provider account identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-notification-direct-account-"));
    roots.push(root);
    const mailStore = new SparkSessionMailStore({ sparkHome: root });
    const session: SparkSessionRegistryRecord = {
      sessionId: "sess_direct_account",
      scope: { kind: "workspace", workspaceId: "ws_direct_account" },
      workspaceId: "ws_direct_account",
      status: "ready",
      bindings: [],
      createdAt: "2026-07-15T08:20:00.000Z",
      updatedAt: "2026-07-15T08:20:00.000Z",
    };
    const status = channelStatus(session.workspaceId, [
      {
        id: "info-a-current",
        type: "infoflow",
        adapterAccountIdentity: "channel-account:infoflow:a",
      },
      {
        id: "info-b-current",
        type: "infoflow",
        adapterAccountIdentity: "channel-account:infoflow:b",
      },
    ]);
    const notify = vi.fn(
      async (_workspaceId: string, input: ChannelNotifyInput): Promise<ChannelNotifyResult> => ({
        action: "send",
        adapter: input.adapter!,
        recipient: input.recipient!,
        text: input.text ?? "",
      }),
    );
    const sent = await mailStore.send({
      toSessionId: session.sessionId,
      kind: "notification",
      visibility: "user",
      deliveryTargets: [
        {
          adapter: "infoflow",
          externalKey: "infoflow:user:user-b",
          adapterId: "info-b-old",
          adapterAccountIdentity: "channel-account:infoflow:b",
        },
      ],
      body: "Direct account notice",
      source: "tool",
    });

    await deliverSessionNotification(
      { sessionId: session.sessionId, messageId: sent.message.id },
      {
        mailStore,
        sessionRegistry: { get: vi.fn(async () => session) },
        channelIngress: { status: vi.fn(() => status), notify },
      },
    );

    expect(notify).toHaveBeenCalledWith(session.workspaceId, {
      action: "send",
      adapter: "info-b-current",
      recipient: "user-b",
      text: "Direct account notice",
    });
    expect(await mailStore.get(session.sessionId, sent.message.id)).toMatchObject({
      deliveries: [
        {
          adapterAccountIdentity: "channel-account:infoflow:b",
          status: "delivered",
        },
      ],
    });
  });

  it("reuses a pre-upgrade message-keyed delivery instead of enqueuing a correlation duplicate", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-notification-legacy-key-"));
    roots.push(root);
    const now = "2026-07-15T08:30:00.000Z";
    const mailStore = new SparkSessionMailStore({ sparkHome: root, now: () => Date.parse(now) });
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const deliveryStore = new SparkChannelDeliveryStore(db, { now: () => now, random: () => 1 });
    const deliveryOutbox = createDaemonChannelDeliveryOutbox(deliveryStore);
    const session: SparkSessionRegistryRecord = {
      sessionId: "sess_legacy_key",
      scope: { kind: "workspace", workspaceId: "ws_legacy_key" },
      workspaceId: "ws_legacy_key",
      status: "ready",
      bindings: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      const sent = await mailStore.send({
        toSessionId: session.sessionId,
        kind: "notification",
        visibility: "user",
        deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:user-1" }],
        correlationId: "corr:upgraded-delivery",
        body: "Completed",
        source: "tool",
      });
      const legacyKey = sessionNotificationLegacyDeliveryIdempotencyKey({
        sessionId: session.sessionId,
        messageId: sent.message.id,
        adapter: "infoflow",
        externalKey: "infoflow:user:user-1",
      });
      await deliveryOutbox.enqueueNotification({
        idempotencyKey: legacyKey,
        sessionId: session.sessionId,
        messageId: sent.message.id,
        workspaceId: session.workspaceId,
        adapterId: "info-main",
        externalKey: "infoflow:user:user-1",
        recipient: "user-1",
        text: sent.message.body,
      });

      await deliverSessionNotification(
        { sessionId: session.sessionId, messageId: sent.message.id },
        {
          mailStore,
          sessionRegistry: { get: vi.fn(async () => session) },
          channelIngress: {
            status: vi.fn(() => channelStatus(session.workspaceId)),
            notify: vi.fn(),
          },
          deliveryQueue: { store: deliveryStore, outbox: deliveryOutbox },
        },
      );

      const correlationKey = sessionNotificationDeliveryIdempotencyKey({
        sessionId: session.sessionId,
        messageId: sent.message.id,
        correlationId: sent.message.correlationId,
        adapter: "infoflow",
        externalKey: "infoflow:user:user-1",
      });
      expect(deliveryStore.findByIdempotencyKey(legacyKey)).toBeDefined();
      expect(deliveryStore.findByIdempotencyKey(correlationKey)).toBeUndefined();
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM channel_deliveries WHERE kind = 'notification'")
          .get(),
      ).toMatchObject({ count: 1 });
    } finally {
      db.close();
    }
  });
});

function channelStatus(
  workspaceId: string,
  adapters: Array<{
    id: string;
    type: "feishu" | "infoflow" | "qqbot";
    adapterAccountIdentity?: string;
  }> = [{ id: "info-main", type: "infoflow" }],
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
