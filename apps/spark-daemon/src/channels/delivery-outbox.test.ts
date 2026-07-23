import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { FakeChannelTransport, parseChannelsConfig } from "@zendev-lab/spark-channels";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { validateSparkDaemonTask } from "../core/types.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { createDaemonSessionRegistry } from "../session-registry.ts";
import { executeSparkDaemonSessionControl } from "../session-control.ts";
import { registerWorkspace } from "../store/workspaces.ts";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkChannelDeliveryStore } from "../store/channel-deliveries.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import {
  completeInvocationWithChannelDelivery,
  createDaemonChannelDeliveryOutbox,
  reconcileDaemonChannelDeliveries,
} from "./delivery-outbox.ts";
import { createChannelIngressController, type ChannelIngressAssignment } from "./ingress.ts";
import {
  CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
  channelDeliveryNotSent,
} from "@zendev-lab/spark-channels";
import { legacyChannelInboundMessageIdempotencyKey } from "./admission.ts";
import { CHANNEL_REPLY_DELIVERY_PENDING_ERROR_CODE } from "./reply-delivery.ts";

describe("daemon channel delivery outbox", () => {
  it("routes QQ ingress through a persistent child despite current binding drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-origin-binding-e2e-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const registry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "origin-binding-e2e",
      daemonCwd: root,
    });
    const workspace = registerWorkspace(db, {
      serverUrl: "https://cockpit.example",
      serverBindingId: "workspace-qq-origin",
      workspaceName: "qq-origin",
      localPath: root,
    });
    await registry.create({
      sessionId: "session-persistent-child",
      scope: { kind: "workspace", workspaceId: workspace.id },
      workspaceId: workspace.id,
      cwd: root,
    });
    const deliveries = new SparkChannelDeliveryStore(db);
    const sendReply = vi.fn(async () => ({ replaySafety: "deduplicated" as const }));
    const channelIngress = {
      sendReply,
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
      resolveAdapterId: vi.fn(
        (_workspaceId: string, adapterId: string) =>
          ({ "qq-main": "qq-main", "info-main": "info-main" })[adapterId],
      ),
    };
    try {
      const assignments: ChannelIngressAssignment[] = [];
      const qqTransport = new FakeChannelTransport();
      const ingress = createChannelIngressController({
        sparkHome: join(root, ".spark"),
        config: parseChannelsConfig({
          adapters: {
            "qq-main": { type: "qqbot", app_id: "app", client_secret: "secret" },
          },
          routes: {},
          ingress: { enabled: true, on_unbound: "reject" },
        }),
        hooks: {
          onAssignment: async (assignment) => {
            assignments.push(assignment);
          },
        },
        sessionRegistry: {
          resolveBinding: async () =>
            ({
              sessionId: "session-qq-origin",
              scope: { kind: "workspace" as const, workspaceId: "workspace-qq-origin" },
            }) as never,
        },
        workspaceId: "workspace-qq-origin",
        createTransport: () => qqTransport,
      });
      await ingress.start();
      qqTransport.emitInbound({
        event_type: "C2C_MESSAGE_CREATE",
        d: {
          id: "qq-origin-message",
          content: "delegated QQ work",
          author: { user_openid: "qq-user" },
        },
      });
      await vi.waitFor(() => expect(assignments).toHaveLength(1));
      await ingress.stop();
      const ingressAssignment = assignments[0]!;
      const ingressBinding = {
        ...ingressAssignment.channelReply,
        adapterAccountIdentity: ingressAssignment.adapterAccountIdentity,
      };
      expect(ingressBinding).toMatchObject({
        workspaceId: "workspace-qq-origin",
        adapter: "qqbot",
        adapterId: "qq-main",
        externalKey: "qqbot:c2c:qq-user",
        recipient: "c2c:qq-user",
      });
      const mailStore = new SparkSessionMailStore({ sparkHome: join(root, ".spark") });
      const sentMail = await mailStore.send({
        toSessionId: "session-persistent-child",
        fromSessionId: "session-qq-origin",
        kind: "request",
        intent: "work.request",
        body: "delegated QQ work",
        originBinding: ingressBinding,
      });
      const persistedBinding = (
        await mailStore.get("session-persistent-child", sentMail.message.id)
      ).originBinding;
      expect(persistedBinding).toEqual(ingressBinding);
      const accepted = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry: registry, actor: "spark-daemon-local-rpc" },
        {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: "session-persistent-child",
          payload: {
            sessionId: "session-persistent-child",
            prompt: "delegated QQ work",
            idempotencyKey: "qq-origin-e2e",
            originBinding: persistedBinding,
          },
        },
      );
      const invocations = new SparkInvocationStore(db);
      const invocation = invocations.require(accepted.invocationId!);
      expect(invocation.task).toMatchObject({
        channelReply: {
          workspaceId: ingressBinding.workspaceId,
          adapter: "qqbot" as const,
          adapterId: "qq-main",
          adapterAccountIdentity: ingressBinding.adapterAccountIdentity,
          recipient: ingressBinding.recipient,
          externalKey: ingressBinding.externalKey,
        },
        channelContext: { externalKey: ingressBinding.externalKey },
      });

      // The executor's current channel drifts after admission; the durable task remains authoritative.
      const currentBinding = {
        workspaceId: "workspace-drifted",
        adapter: "infoflow" as const,
        adapterId: "info-main",
        externalKey: "infoflow:user:drifted",
        recipient: "drifted",
      };
      expect(invocation.task).not.toMatchObject({
        channelReply: {
          adapter: "infoflow" as const,
          workspaceId: currentBinding.workspaceId,
          adapterId: currentBinding.adapterId,
          recipient: currentBinding.recipient,
          externalKey: currentBinding.externalKey,
        },
      });
      const task = validateSparkDaemonTask(invocation.task);
      invocations.claimNext("worker");
      completeInvocationWithChannelDelivery({ db, invocations, deliveries }, invocation, task, {
        status: "succeeded",
        result: { assistantText: "QQ child final" },
      });
      await expect(
        reconcileDaemonChannelDeliveries({
          store: deliveries,
          channelIngress: channelIngress as never,
          workerId: "delivery-worker",
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0, uncertain: 0 });
      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledWith("workspace-qq-origin", "qq-main", {
        recipient: "c2c:qq-user",
        text: "QQ child final",
        deliveryId: expect.any(String),
        preview: "delegated QQ work",
      });
      expect(sendReply).not.toHaveBeenCalledWith(
        currentBinding.workspaceId,
        currentBinding.adapterId,
        expect.anything(),
      );
      expect(sendReply).not.toHaveBeenCalledWith(expect.anything(), "info-main", expect.anything());
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete or inconsistent frozen bindings without creating an outbox entry", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const deliveries = new SparkChannelDeliveryStore(db);
    const invalidTasks = [
      {
        type: "session.run" as const,
        sessionId: "session-incomplete-binding",
        prompt: "do not route by fallback",
        channelReply: {
          workspaceId: "workspace-qq-origin",
          adapterId: "qq-main",
          recipient: "c2c:qq-user",
        },
        channelContext: { externalKey: "qqbot:c2c:qq-user" },
      },
      {
        type: "session.run" as const,
        sessionId: "session-inconsistent-binding",
        prompt: "do not route a mismatched origin",
        channelReply: {
          workspaceId: "workspace-qq-origin",
          adapter: "qqbot" as const,
          adapterId: "qq-main",
          externalKey: "qqbot:c2c:qq-user",
          recipient: "c2c:qq-user",
        },
        channelContext: { externalKey: "qqbot:c2c:other-user" },
      },
    ];

    try {
      for (const task of invalidTasks) {
        const invocation = invocations.submit({
          sessionId: task.sessionId,
          prompt: task.prompt,
          task,
        });
        invocations.claimNext("worker");

        expect(() =>
          completeInvocationWithChannelDelivery(
            { db, invocations, deliveries },
            invocation,
            task as never,
            { status: "succeeded", result: { assistantText: "must not send" } },
          ),
        ).toThrow(/channel-origin task .*frozen binding/u);
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM channel_deliveries").get()).toMatchObject({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it("delivers a persistent child final only through its frozen QQ origin", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const deliveries = new SparkChannelDeliveryStore(db);
    const task = {
      type: "session.run" as const,
      sessionId: "session-persistent-child",
      prompt: "delegated QQ work",
      channelReply: {
        workspaceId: "workspace-qq-origin",
        adapter: "qqbot" as const,
        adapterId: "qq-main",
        recipient: "c2c:qq-user",
        externalKey: "qqbot:c2c:qq-user",
      },
      channelContext: { externalKey: "qqbot:c2c:qq-user" },
    };
    const sendReply = vi.fn(async () => ({ replaySafety: "deduplicated" as const }));
    const channelIngress = {
      sendReply,
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
      resolveAdapterId: vi.fn(
        (_workspaceId: string, adapterId: string) =>
          ({ "qq-main": "qq-main", "info-main": "info-main" })[adapterId],
      ),
    };
    try {
      const invocation = invocations.submit({
        sessionId: task.sessionId,
        prompt: task.prompt,
        task,
      });
      invocations.claimNext("worker");
      completeInvocationWithChannelDelivery({ db, invocations, deliveries }, invocation, task, {
        status: "succeeded",
        result: { assistantText: "QQ child final" },
      });

      await expect(
        reconcileDaemonChannelDeliveries({
          store: deliveries,
          channelIngress: channelIngress as never,
          workerId: "delivery-worker",
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0, uncertain: 0 });
      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledWith("workspace-qq-origin", "qq-main", {
        recipient: "c2c:qq-user",
        text: "QQ child final",
        deliveryId: expect.any(String),
        preview: "delegated QQ work",
      });
      expect(sendReply).not.toHaveBeenCalledWith(expect.anything(), "info-main", expect.anything());
    } finally {
      db.close();
    }
  });

  it("persists replies before delivery and retries the same QQ source identity until success", async () => {
    let now = "2026-07-15T00:00:00.000Z";
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db, { now: () => now, random: () => 1 });
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const sendReply = vi
      .fn()
      .mockRejectedValueOnce(new Error("QQ Bot request timed out"))
      .mockResolvedValueOnce({ replaySafety: "deduplicated" as const });
    const ingress = {
      sendReply,
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
      replyDeliveryFacts: () => ({ replaySafety: "deduplicated" as const }),
    };
    try {
      await outbox.enqueueReply({
        kind: "final",
        idempotencyKey: "channel.reply:final:invocation-1",
        invocationId: "invocation-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        externalKey: "qqbot:c2c:user-1",
        target: {
          recipient: "c2c:user-1",
          senderId: "user-1",
          messageId: "source-message-1",
        },
        text: "done",
      });

      const persisted = store.findByIdempotencyKey("channel.reply:final:invocation-1");
      expect(persisted).toBeDefined();
      expect(sendReply).not.toHaveBeenCalled();
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
        ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 1, uncertain: 0 });
      } finally {
        log.mockRestore();
      }
      expect(store.findByIdempotencyKey("channel.reply:final:invocation-1")).toMatchObject({
        status: "retry_wait",
        attemptCount: 1,
        lastError: "QQ Bot request timed out",
        nextAttemptAt: "2026-07-15T00:00:01.000Z",
      });

      now = "2026-07-15T00:00:01.000Z";
      await expect(
        reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0, uncertain: 0 });
      expect(sendReply).toHaveBeenNthCalledWith(1, "workspace-1", "qqbot", {
        recipient: "c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
        text: "done",
        deliveryId: persisted!.deliveryId,
      });
      expect(sendReply).toHaveBeenNthCalledWith(2, "workspace-1", "qqbot", {
        recipient: "c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
        text: "done",
        deliveryId: persisted!.deliveryId,
      });
      expect(store.findByIdempotencyKey("channel.reply:final:invocation-1")).toMatchObject({
        status: "delivered",
        attemptCount: 2,
      });
    } finally {
      db.close();
    }
  });

  it("retries an unsafe adapter only when the failure is confirmed not sent", async () => {
    let now = "2026-07-15T00:00:00.000Z";
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db, { now: () => now, random: () => 1 });
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const sendReply = vi
      .fn()
      .mockRejectedValueOnce(channelDeliveryNotSent(new Error("adapter unavailable")))
      .mockResolvedValueOnce({ replaySafety: "unsafe" as const });
    const ingress = {
      sendReply,
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
    };
    try {
      await outbox.enqueueReply({
        kind: "final",
        idempotencyKey: "channel.reply:final:not-sent",
        invocationId: "not-sent",
        sessionId: "session-not-sent",
        workspaceId: "workspace-1",
        adapterId: "plain-adapter",
        externalKey: "plain-adapter:user:user-1",
        target: { recipient: "user-1" },
        text: "retry me",
      });

      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
        ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 1, uncertain: 0 });
      } finally {
        log.mockRestore();
      }
      expect(store.findByIdempotencyKey("channel.reply:final:not-sent")).toMatchObject({
        status: "retry_wait",
        attemptCount: 1,
        nextAttemptAt: "2026-07-15T00:00:01.000Z",
      });

      now = "2026-07-15T00:00:01.000Z";
      await expect(
        reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0, uncertain: 0 });
      expect(sendReply).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it("recovers an expired unsafe dispatch marker as uncertain without sending again", async () => {
    let now = "2026-07-15T00:00:00.000Z";
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db, { now: () => now });
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const ingress = {
      sendReply: vi.fn(),
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
    };
    try {
      await outbox.enqueueReply({
        kind: "final",
        idempotencyKey: "channel.reply:final:crashed-dispatch",
        invocationId: "crashed-dispatch",
        sessionId: "session-crashed-dispatch",
        workspaceId: "workspace-1",
        adapterId: "plain-adapter",
        externalKey: "plain-adapter:user:user-1",
        target: { recipient: "user-1" },
        text: "possibly sent",
      });
      const crashed = store.claimDue("crashed-worker", { leaseMs: 1_000 });
      store.markDispatchStarted(crashed!.deliveryId, crashed!.leaseToken!);

      now = "2026-07-15T00:00:01.000Z";
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          reconcileDaemonChannelDeliveries(
            { store, channelIngress: ingress, workerId: "recovery-worker" },
            { leaseMs: 1_000, heartbeatIntervalMs: 250 },
          ),
        ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 0, uncertain: 1 });
      } finally {
        log.mockRestore();
      }

      expect(ingress.sendReply).not.toHaveBeenCalled();
      expect(store.findByIdempotencyKey("channel.reply:final:crashed-dispatch")).toMatchObject({
        status: "uncertain",
        attemptCount: 2,
        dispatchedAt: "2026-07-15T00:00:00.000Z",
        lastError: expect.stringContaining("interrupted after dispatch started"),
      });
      expect(store.claimDue("third-worker")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("keeps an expired unsafe dispatch uncertain when adapter preflight is unavailable", async () => {
    let now = "2026-07-15T00:00:00.000Z";
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db, { now: () => now });
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const sendReply = vi.fn();
    const ingress = {
      sendReply,
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
      replyDeliveryFacts: vi.fn(() => {
        throw channelDeliveryNotSent(new Error("adapter temporarily unavailable"));
      }),
    };
    try {
      await outbox.enqueueReply({
        kind: "final",
        idempotencyKey: "channel.reply:final:crashed-preflight",
        invocationId: "crashed-preflight",
        sessionId: "session-crashed-preflight",
        workspaceId: "workspace-1",
        adapterId: "plain-adapter",
        externalKey: "plain-adapter:user:user-1",
        target: { recipient: "user-1" },
        text: "possibly sent before restart",
      });
      const crashed = store.claimDue("crashed-worker", { leaseMs: 1_000 });
      store.markDispatchStarted(crashed!.deliveryId, crashed!.leaseToken!);

      now = "2026-07-15T00:00:01.000Z";
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          reconcileDaemonChannelDeliveries(
            { store, channelIngress: ingress, workerId: "recovery-worker" },
            { leaseMs: 1_000, heartbeatIntervalMs: 250 },
          ),
        ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 0, uncertain: 1 });
      } finally {
        log.mockRestore();
      }

      expect(sendReply).not.toHaveBeenCalled();
      expect(store.findByIdempotencyKey("channel.reply:final:crashed-preflight")).toMatchObject({
        status: "uncertain",
        attemptCount: 2,
        dispatchedAt: "2026-07-15T00:00:00.000Z",
        lastError: expect.stringContaining("adapter temporarily unavailable"),
      });
      expect(store.claimDue("third-worker")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("quarantines an ambiguous ordinary notification without automatically resending it", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db);
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const notify = vi.fn().mockRejectedValue(new Error("provider response timed out"));
    const ingress = {
      sendReply: vi.fn(),
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
      notify,
      messageDeliveryFacts: () => ({ replaySafety: "unsafe" as const }),
    };
    try {
      await outbox.enqueueNotification({
        idempotencyKey: "session.notification:unsafe-timeout",
        sessionId: "session-notification",
        messageId: "mail-notification",
        workspaceId: "workspace-1",
        adapterId: "infoflow",
        externalKey: "infoflow:user:user-1",
        recipient: "user-1",
        text: "ordinary notification",
      });

      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
        ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 0, uncertain: 1 });
      } finally {
        log.mockRestore();
      }
      expect(store.findByIdempotencyKey("session.notification:unsafe-timeout")).toMatchObject({
        status: "uncertain",
        attemptCount: 1,
        lastError: "provider response timed out",
      });

      await expect(
        reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker-2" }),
      ).resolves.toEqual({ attempted: 0, delivered: 0, failed: 0, uncertain: 0 });
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("uses the same durable worker for native asks and interaction acknowledgements", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db);
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const ingress = {
      sendReply: vi.fn(),
      sendAsk: vi.fn(async () => ({ messageId: "ask-message-1" })),
      ackInteraction: vi.fn(async () => undefined),
    };
    try {
      await outbox.enqueueAsk({
        idempotencyKey: "channel.ask:human-request-1",
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        recipient: "c2c:user-1",
        request: {
          prompt: "Continue?",
          options: [{ id: "1", label: "Yes", data: "opaque" }],
          audience: { kind: "users", userIds: ["user-1"] },
          messageId: "source-message-1",
        },
      });
      await outbox.enqueueInteractionAck({
        idempotencyKey: "channel.interaction-ack:qqbot:interaction-1",
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        interactionId: "interaction-1",
        status: "success",
      });
      const askDelivery = store.findByIdempotencyKey("channel.ask:human-request-1");
      expect(askDelivery).toBeDefined();

      await expect(
        reconcileDaemonChannelDeliveries(
          { store, channelIngress: ingress, workerId: "worker" },
          { limit: 10 },
        ),
      ).resolves.toEqual({ attempted: 2, delivered: 2, failed: 0, uncertain: 0 });
      expect(ingress.sendAsk).toHaveBeenCalledTimes(1);
      expect(ingress.sendAsk).toHaveBeenCalledWith(
        "workspace-1",
        "qqbot",
        "c2c:user-1",
        expect.objectContaining({
          idempotencyKey: askDelivery!.deliveryId,
          messageId: "source-message-1",
        }),
      );
      expect(ingress.ackInteraction).toHaveBeenCalledWith(
        "workspace-1",
        "qqbot",
        "interaction-1",
        "success",
      );
    } finally {
      db.close();
    }
  });

  it("renews the lease while a platform call is still running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db);
    const competingStore = new SparkChannelDeliveryStore(db);
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const ingress = {
      sendReply: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        return { replaySafety: "unsafe" as const };
      }),
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
    };
    try {
      await outbox.enqueueReply({
        kind: "final",
        idempotencyKey: "channel.reply:final:slow-invocation",
        invocationId: "slow-invocation",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        target: { recipient: "c2c:user-1", messageId: "source-message-1" },
        text: "slow done",
      });

      const reconciliation = reconcileDaemonChannelDeliveries(
        { store, channelIngress: ingress, workerId: "worker-a" },
        { leaseMs: 100, heartbeatIntervalMs: 25 },
      );
      await vi.advanceTimersByTimeAsync(150);

      const inFlight = store.findByIdempotencyKey("channel.reply:final:slow-invocation");
      expect(Date.parse(inFlight!.leaseExpiresAt!)).toBeGreaterThan(Date.now());
      expect(competingStore.claimDue("worker-b", { leaseMs: 100 })).toBeUndefined();

      await vi.advanceTimersByTimeAsync(100);
      await expect(reconciliation).resolves.toEqual({
        attempted: 1,
        delivered: 1,
        failed: 0,
        uncertain: 0,
      });
      expect(ingress.sendReply).toHaveBeenCalledTimes(1);
      expect(store.findByIdempotencyKey("channel.reply:final:slow-invocation")).toMatchObject({
        status: "delivered",
        attemptCount: 1,
      });
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("quarantines a timed-out unsafe attempt and continues with other deliveries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db, { random: () => 1 });
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const sendReply = vi.fn(async (_workspaceId, _adapterId, target: { text: string }) => {
      if (target.text === "stuck") {
        await new Promise<never>(() => undefined);
      }
      return { replaySafety: "unsafe" as const };
    });
    const ingress = {
      sendReply,
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
    };
    try {
      await outbox.enqueueReply({
        kind: "final",
        idempotencyKey: "channel.reply:final:stuck",
        invocationId: "stuck",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        target: { recipient: "c2c:user-1", messageId: "source-message-1" },
        text: "stuck",
      });
      await outbox.enqueueReply({
        kind: "final",
        idempotencyKey: "channel.reply:final:healthy",
        invocationId: "healthy",
        sessionId: "session-2",
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        target: { recipient: "c2c:user-2", messageId: "source-message-2" },
        text: "healthy",
      });

      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const reconciliation = reconcileDaemonChannelDeliveries(
          { store, channelIngress: ingress, workerId: "worker" },
          { limit: 2, leaseMs: 100, heartbeatIntervalMs: 20, attemptTimeoutMs: 50 },
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(store.findByIdempotencyKey("channel.reply:final:healthy")).toMatchObject({
          status: "delivered",
        });
        await vi.advanceTimersByTimeAsync(50);
        await expect(reconciliation).resolves.toEqual({
          attempted: 2,
          delivered: 1,
          failed: 0,
          uncertain: 1,
        });
      } finally {
        log.mockRestore();
      }

      expect(store.findByIdempotencyKey("channel.reply:final:stuck")).toMatchObject({
        status: "uncertain",
        attemptCount: 1,
        lastError: expect.stringContaining("attempt timed out after 50ms"),
      });
      expect(store.claimDue("worker-retry", { leaseMs: 100 })).toBeUndefined();
      expect(store.findByIdempotencyKey("channel.reply:final:healthy")).toMatchObject({
        status: "delivered",
        attemptCount: 1,
      });
      expect(sendReply).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("persists normalized inbound messages and retries admission without raw platform payloads", async () => {
    let now = "2026-07-15T00:00:00.000Z";
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db, { now: () => now, random: () => 1 });
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const admitInbound = vi
      .fn()
      .mockRejectedValueOnce(new Error("session registry temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const ingress = {
      sendReply: vi.fn(),
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
      admitInbound,
    };
    try {
      outbox.enqueueInbound({
        workspaceId: "workspace-1",
        message: {
          adapter: "infoflow" as const,
          adapterId: "infoflow-account-a",
          adapterAccountIdentity: "channel-account:infoflow:account-a",
          externalKey: "infoflow:user:alice",
          senderId: "alice",
          text: "continue",
          messageId: "source-message-1",
          raw: { secret: "must-not-persist" },
        },
      });
      const persisted = db
        .prepare("SELECT idempotency_key AS key, payload_json AS payload FROM channel_deliveries")
        .get() as { key: string; payload: string };
      expect(persisted.key).toMatch(/^channel\.inbound:v2:[a-f0-9]{64}$/u);
      expect(persisted.payload).not.toContain("must-not-persist");

      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
        ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 1, uncertain: 0 });
      } finally {
        log.mockRestore();
      }
      now = "2026-07-15T00:00:01.000Z";
      await expect(
        reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0, uncertain: 0 });
      expect(admitInbound).toHaveBeenCalledTimes(2);
      expect(admitInbound).toHaveBeenLastCalledWith(
        "workspace-1",
        expect.objectContaining({
          adapter: "infoflow" as const,
          externalKey: "infoflow:user:alice",
          messageId: "source-message-1",
          text: "continue",
        }),
      );
    } finally {
      db.close();
    }
  });

  it("honors matching v1 inbound rows without colliding across provider accounts", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db);
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const accountA = {
      adapter: "infoflow" as const,
      adapterId: "infoflow-account-a",
      adapterAccountIdentity: "channel-account:infoflow:account-a",
      externalKey: "infoflow:user:shared-user",
      senderId: "shared-user",
      text: "shared message",
      messageId: "shared-message-id",
    };
    try {
      const legacyKey = legacyChannelInboundMessageIdempotencyKey("workspace-1", accountA);
      expect(legacyKey).toMatch(/^channel\.inbound:v1:[a-f0-9]{64}$/u);
      const { adapterAccountIdentity: _legacyIdentity, ...legacyMessage } = accountA;
      store.enqueue({
        kind: "inbound",
        idempotencyKey: legacyKey!,
        payload: { workspaceId: "workspace-1", message: legacyMessage },
      });

      outbox.enqueueInbound({ workspaceId: "workspace-1", message: accountA });
      expect(db.prepare("SELECT COUNT(*) AS count FROM channel_deliveries").get()).toMatchObject({
        count: 1,
      });

      outbox.enqueueInbound({
        workspaceId: "workspace-1",
        message: {
          ...accountA,
          adapterId: "infoflow-account-b",
          adapterAccountIdentity: "channel-account:infoflow:account-b",
        },
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM channel_deliveries").get()).toMatchObject({
        count: 2,
      });
      const keys = db
        .prepare("SELECT idempotency_key AS key FROM channel_deliveries ORDER BY created_at, id")
        .all() as Array<{ key: string }>;
      expect(keys.map(({ key }) => key)).toEqual(
        expect.arrayContaining([
          legacyKey,
          expect.stringMatching(/^channel\.inbound:v2:[a-f0-9]{64}$/u),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("atomically commits a terminal invocation with its channel reply intent", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const deliveries = new SparkChannelDeliveryStore(db);
    const task = {
      type: "session.run" as const,
      sessionId: "session-atomic",
      prompt: "finish atomically",
      channelReply: {
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        adapter: "qqbot" as const,
        recipient: "c2c:user-1",
        externalKey: "qqbot:c2c:user-1",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
      },
    };
    try {
      const invocation = invocations.submit({
        sessionId: task.sessionId,
        prompt: task.prompt,
        task,
      });
      invocations.claimNext("worker");

      completeInvocationWithChannelDelivery({ db, invocations, deliveries }, invocation, task, {
        status: "succeeded",
        result: { assistantText: "done" },
      });

      expect(invocations.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: { assistantText: "done" },
      });
      expect(
        deliveries.findByIdempotencyKey(`channel.reply:final:${invocation.invocationId}`),
      ).toMatchObject({
        status: "pending",
        payload: expect.objectContaining({ text: "done", invocationId: invocation.invocationId }),
      });
    } finally {
      db.close();
    }
  });

  function completeOwnedFailureWithoutCompetingReply(errorCode: string) {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const deliveries = new SparkChannelDeliveryStore(db);
    const task = {
      type: "session.run" as const,
      sessionId: `session-owned-delivery-${errorCode}`,
      prompt: "finish once",
      channelReply: {
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        adapter: "qqbot" as const,
        recipient: "c2c:user-1",
        externalKey: "qqbot:c2c:user-1",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-1",
        messageId: "source-message-1",
      },
    };
    try {
      const invocation = invocations.submit({
        sessionId: task.sessionId,
        prompt: task.prompt,
        task,
      });
      invocations.claimNext("worker");

      completeInvocationWithChannelDelivery({ db, invocations, deliveries }, invocation, task, {
        status: "failed",
        errorCode,
        errorMessage: "delivery remains owned by the original attempt",
      });

      expect(invocations.require(invocation.invocationId)).toMatchObject({
        status: "failed",
        errorCode,
      });
      expect(
        deliveries.findByIdempotencyKey(`channel.reply:failure:${invocation.invocationId}`),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  }

  it("does not compete with a durable reply retry", () => {
    completeOwnedFailureWithoutCompetingReply(CHANNEL_REPLY_DELIVERY_PENDING_ERROR_CODE);
  });

  it("does not guess after an ambiguous platform send", () => {
    completeOwnedFailureWithoutCompetingReply(CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE);
  });

  it("rolls back terminal status when the delivery intent cannot be inserted", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const deliveries = new SparkChannelDeliveryStore(db);
    const task = {
      type: "session.run" as const,
      sessionId: "session-rollback",
      prompt: "do not split the commit",
      channelReply: {
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        adapter: "qqbot" as const,
        recipient: "c2c:user-1",
        externalKey: "qqbot:c2c:user-1",
      },
      channelContext: { externalKey: "qqbot:c2c:user-1", messageId: "source-message-1" },
    };
    try {
      const invocation = invocations.submit({
        sessionId: task.sessionId,
        prompt: task.prompt,
        task,
      });
      invocations.claimNext("worker");
      deliveries.enqueue({
        kind: "reply",
        idempotencyKey: `channel.reply:final:${invocation.invocationId}`,
        payload: { conflicting: true },
      });

      expect(() =>
        completeInvocationWithChannelDelivery({ db, invocations, deliveries }, invocation, task, {
          status: "succeeded",
          result: { assistantText: "done" },
        }),
      ).toThrow(/CHANNEL_DELIVERY_IDEMPOTENCY_CONFLICT/u);
      expect(invocations.require(invocation.invocationId).status).toBe("running");
    } finally {
      db.close();
    }
  });
});
