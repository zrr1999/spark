import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { SparkInvocationScheduler } from "../core/invocation-scheduler.ts";
import { createChannelAwareTaskExecutor } from "../spark/session-run.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import {
  CHANNEL_REPLY_DELIVERY_PENDING_ERROR_CODE,
  ChannelReplyDeliveryStore,
  channelReplyDeliveryId,
  channelReplyRetryDelayMs,
  reconcileChannelReplyDeliveries,
} from "./reply-delivery.ts";

const paths = resolveSparkPaths({
  app: "daemon",
  env: { HOME: "/tmp/spark-channel-reply-delivery-test" },
});

describe("channel reply delivery", () => {
  it("fails the invocation on first send failure, then retries only the durable reply", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const executeSession = vi.fn(async () => ({ assistantText: "最终答案" }));
    const sendReply = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("platform unavailable"))
      .mockResolvedValueOnce(undefined);
    const task = {
      type: "session.run" as const,
      sessionId: "sess_channel_delivery",
      prompt: "请处理",
      workspaceId: "workspace-1",
      channelReply: {
        workspaceId: "workspace-1",
        adapterId: "infoflow",
        recipient: "group:10838226",
      },
      channelContext: {
        externalKey: "infoflow:group:10838226",
        senderId: "user-1",
        messageId: "message-1",
      },
    };
    const channelIngress = {
      openReplyStream: vi.fn(async () => undefined),
      sendReply,
    };
    const scheduler = new SparkInvocationScheduler({
      store: invocations,
      executeTask: createChannelAwareTaskExecutor({
        paths,
        createSparkHeadlessSessionExecutor: () => executeSession,
        channelIngress,
        channelReplyDelivery: deliveries,
      }),
    });
    const invocation = invocations.submit({
      sessionId: task.sessionId,
      prompt: task.prompt,
      task,
    });

    try {
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();

      expect(invocations.require(invocation.invocationId)).toMatchObject({
        status: "failed",
        errorCode: CHANNEL_REPLY_DELIVERY_PENDING_ERROR_CODE,
        errorMessage: expect.stringContaining("platform unavailable"),
      });
      expect(executeSession).toHaveBeenCalledTimes(1);
      expect(deliveries.require(channelReplyDeliveryId(invocation.invocationId))).toMatchObject({
        status: "pending",
        attemptCount: 1,
        lastError: "platform unavailable",
      });

      await expect(
        reconcileChannelReplyDeliveries({
          store: deliveries,
          channelIngress: { ...channelIngress, recoverReply: vi.fn(async () => undefined) },
          now: () => "2099-01-01T00:00:00.000Z",
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, pending: 0 });

      expect(executeSession).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledTimes(2);
      expect(deliveries.require(channelReplyDeliveryId(invocation.invocationId))).toMatchObject({
        status: "acked",
        attemptCount: 2,
        deliveredAt: expect.any(String),
      });
      expect(invocations.require(invocation.invocationId)).toMatchObject({
        status: "failed",
        errorCode: CHANNEL_REPLY_DELIVERY_PENDING_ERROR_CODE,
      });
      expect(
        invocations
          .eventPage(invocation.invocationId)
          .events.filter((event) => event.kind === "channel.reply.delivery")
          .map((event) => event.payload.status),
      ).toEqual(["sending", "pending", "sending", "acked"]);
    } finally {
      db.close();
    }
  });

  it("returns an interrupted send to the pending queue after restart", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const invocation = invocations.submit({
      sessionId: "sess_interrupted",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess_interrupted", prompt: "run" },
    });
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const staged = deliveries.stage({
      invocationId: invocation.invocationId,
      sessionId: "sess_interrupted",
      workspaceId: "workspace-1",
      adapterId: "qqbot",
      target: { recipient: "c2c:user-1", messageId: "message-1" },
      text: "answer",
    });

    try {
      expect(staged.status).toBe("sending");
      expect(deliveries.recoverInterrupted("2026-07-15T00:00:00.000Z")).toBe(1);
      expect(deliveries.require(staged.deliveryId)).toMatchObject({
        status: "pending",
        attemptCount: 0,
        lastError: expect.stringContaining("restarted"),
      });
    } finally {
      db.close();
    }
  });

  it("recovers the same inline stream after a crash between complete and acknowledge", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const invocation = invocations.submit({
      sessionId: "sess_stream_crash",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess_stream_crash", prompt: "run" },
    });
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const recovery = {
      kind: "infoflow.streaming-card.v1",
      data: { to: "group:10838226", modifyToken: "token-1" },
    };
    const staged = deliveries.stage({
      invocationId: invocation.invocationId,
      sessionId: "sess_stream_crash",
      workspaceId: "workspace-1",
      adapterId: "infoflow",
      target: { recipient: "group:10838226" },
      text: "answer",
      deliveryMode: "inline-stream",
      recovery,
    });
    const sendReply = vi.fn(async () => undefined);
    const recoverReply = vi.fn(async () => undefined);

    try {
      // A successful stream.complete followed by a process crash leaves the
      // pre-staged row in `sending`; startup must resume that card, not send a
      // second ordinary message.
      expect(deliveries.recoverInterrupted("2026-07-15T00:00:00.000Z")).toBe(1);
      await expect(
        reconcileChannelReplyDeliveries({
          store: deliveries,
          channelIngress: { sendReply, recoverReply },
          now: () => "2026-07-15T00:00:00.000Z",
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, pending: 0 });

      expect(sendReply).not.toHaveBeenCalled();
      expect(recoverReply).toHaveBeenCalledWith("workspace-1", "infoflow", {
        recipient: "group:10838226",
        text: "answer",
        deliveryId: staged.deliveryId,
        recovery,
      });
      expect(deliveries.require(staged.deliveryId)).toMatchObject({
        status: "acked",
        deliveryMode: "inline-stream",
        attemptCount: 1,
      });
    } finally {
      db.close();
    }
  });

  it("never converts an unrecoverable interrupted stream into a fresh message", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const invocation = invocations.submit({
      sessionId: "sess_stream_unknown",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess_stream_unknown", prompt: "run" },
    });
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const staged = deliveries.stage({
      invocationId: invocation.invocationId,
      sessionId: "sess_stream_unknown",
      workspaceId: "workspace-1",
      adapterId: "infoflow",
      target: { recipient: "user-1" },
      text: "answer",
      deliveryMode: "inline-stream",
    });
    const sendReply = vi.fn(async () => undefined);
    const recoverReply = vi.fn(async () => undefined);

    try {
      deliveries.recoverInterrupted("2026-07-15T00:00:00.000Z");
      await expect(
        reconcileChannelReplyDeliveries({
          store: deliveries,
          channelIngress: { sendReply, recoverReply },
          now: () => "2026-07-15T00:00:00.000Z",
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 0, pending: 1 });

      expect(sendReply).not.toHaveBeenCalled();
      expect(recoverReply).not.toHaveBeenCalled();
      expect(deliveries.require(staged.deliveryId)).toMatchObject({
        status: "pending",
        deliveryMode: "inline-stream",
        lastError: expect.stringContaining("no platform recovery handle"),
      });
    } finally {
      db.close();
    }
  });

  it("keeps a refused same-stream recovery pending without sending a fresh message", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const invocation = invocations.submit({
      sessionId: "sess_stream_recovery_failure",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess_stream_recovery_failure", prompt: "run" },
    });
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const recovery = {
      kind: "infoflow.streaming-card.v1",
      data: { to: "group:10838226", modifyToken: "token-1" },
    };
    const staged = deliveries.stage({
      invocationId: invocation.invocationId,
      sessionId: "sess_stream_recovery_failure",
      workspaceId: "workspace-1",
      adapterId: "infoflow",
      target: { recipient: "group:10838226" },
      text: "answer",
      deliveryMode: "inline-stream",
      recovery,
    });
    const sendReply = vi.fn(async () => undefined);
    const recoverReply = vi.fn(async () => {
      throw new Error("platform rejected card update");
    });

    try {
      deliveries.recoverInterrupted("2026-07-15T00:00:00.000Z");
      await expect(
        reconcileChannelReplyDeliveries({
          store: deliveries,
          channelIngress: { sendReply, recoverReply },
          now: () => "2026-07-15T00:00:00.000Z",
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 0, pending: 1 });

      expect(recoverReply).toHaveBeenCalledOnce();
      expect(sendReply).not.toHaveBeenCalled();
      expect(deliveries.require(staged.deliveryId)).toMatchObject({
        status: "pending",
        deliveryMode: "inline-stream",
        recovery,
        attemptCount: 1,
        lastError: "platform rejected card update",
      });
    } finally {
      db.close();
    }
  });

  it("backs off persistent platform failures instead of retrying every daemon tick", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const invocation = invocations.submit({
      sessionId: "sess_backoff",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess_backoff", prompt: "run" },
    });
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const staged = deliveries.stage(
      {
        invocationId: invocation.invocationId,
        sessionId: "sess_backoff",
        workspaceId: "workspace-1",
        adapterId: "infoflow",
        target: { recipient: "user-1" },
        text: "answer",
      },
      "2026-07-15T00:00:00.000Z",
    );

    try {
      const deferred = deliveries.defer(
        staged.deliveryId,
        new Error("offline"),
        "2026-07-15T00:00:00.000Z",
      );
      expect(deferred.nextAttemptAt).toBe("2026-07-15T00:00:01.000Z");
      expect(deliveries.claimNext("2026-07-15T00:00:00.999Z")).toBeUndefined();
      expect(deliveries.claimNext("2026-07-15T00:00:01.000Z")?.deliveryId).toBe(staged.deliveryId);
      expect(channelReplyRetryDelayMs(1)).toBe(1_000);
      expect(channelReplyRetryDelayMs(20)).toBe(300_000);
    } finally {
      db.close();
    }
  });
});
