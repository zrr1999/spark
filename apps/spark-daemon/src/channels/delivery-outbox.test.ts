import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkChannelDeliveryStore } from "../store/channel-deliveries.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import {
  completeInvocationWithChannelDelivery,
  createDaemonChannelDeliveryOutbox,
  reconcileDaemonChannelDeliveries,
} from "./delivery-outbox.ts";

describe("daemon channel delivery outbox", () => {
  it("persists replies before delivery and retries the same QQ source identity until success", async () => {
    let now = "2026-07-15T00:00:00.000Z";
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkChannelDeliveryStore(db, { now: () => now, random: () => 1 });
    const outbox = createDaemonChannelDeliveryOutbox(store);
    const sendReply = vi
      .fn()
      .mockRejectedValueOnce(new Error("QQ Bot request timed out"))
      .mockResolvedValueOnce(undefined);
    const ingress = {
      sendReply,
      sendAsk: vi.fn(),
      ackInteraction: vi.fn(),
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

      expect(sendReply).not.toHaveBeenCalled();
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
        ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 1 });
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
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0 });
      expect(sendReply).toHaveBeenNthCalledWith(1, "workspace-1", "qqbot", {
        recipient: "c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
        text: "done",
      });
      expect(sendReply).toHaveBeenNthCalledWith(2, "workspace-1", "qqbot", {
        recipient: "c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
        text: "done",
      });
      expect(store.findByIdempotencyKey("channel.reply:final:invocation-1")).toMatchObject({
        status: "delivered",
        attemptCount: 2,
      });
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

      await expect(
        reconcileDaemonChannelDeliveries(
          { store, channelIngress: ingress, workerId: "worker" },
          { limit: 10 },
        ),
      ).resolves.toEqual({ attempted: 2, delivered: 2, failed: 0 });
      expect(ingress.sendAsk).toHaveBeenCalledTimes(1);
      expect(ingress.sendAsk).toHaveBeenCalledWith(
        "workspace-1",
        "qqbot",
        "c2c:user-1",
        expect.objectContaining({
          idempotencyKey: "channel.ask:human-request-1",
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
      sendReply: vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
          }),
      ),
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
      await expect(reconciliation).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0 });
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

  it("times out a stuck platform attempt, records it, and continues with other deliveries", async () => {
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
        await expect(reconciliation).resolves.toEqual({ attempted: 2, delivered: 1, failed: 1 });
      } finally {
        log.mockRestore();
      }

      expect(store.findByIdempotencyKey("channel.reply:final:stuck")).toMatchObject({
        status: "retry_wait",
        attemptCount: 1,
        lastError: expect.stringContaining("attempt timed out after 50ms"),
      });
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
          adapter: "infoflow",
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
      expect(persisted.key).toMatch(/^channel\.inbound:v1:[a-f0-9]{64}$/u);
      expect(persisted.payload).not.toContain("must-not-persist");

      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await expect(
          reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
        ).resolves.toEqual({ attempted: 1, delivered: 0, failed: 1 });
      } finally {
        log.mockRestore();
      }
      now = "2026-07-15T00:00:01.000Z";
      await expect(
        reconcileDaemonChannelDeliveries({ store, channelIngress: ingress, workerId: "worker" }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0 });
      expect(admitInbound).toHaveBeenCalledTimes(2);
      expect(admitInbound).toHaveBeenLastCalledWith(
        "workspace-1",
        expect.objectContaining({
          adapter: "infoflow",
          externalKey: "infoflow:user:alice",
          messageId: "source-message-1",
          text: "continue",
        }),
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
        recipient: "c2c:user-1",
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
        recipient: "c2c:user-1",
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
