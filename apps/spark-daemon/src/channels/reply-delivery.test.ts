import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { SparkInvocationScheduler } from "../core/invocation-scheduler.ts";
import {
  CHANNEL_REPLY_TERMINAL_PRESENTED_ERROR_CODE,
  createChannelAwareTaskExecutor,
} from "../spark/session-run.ts";
import { SparkChannelDeliveryStore } from "../store/channel-deliveries.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { completeInvocationWithChannelDelivery } from "./delivery-outbox.ts";
import {
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
  it("keeps an inline empty-reply notice as the only user-visible failure", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const outbox = new SparkChannelDeliveryStore(db);
    const fail = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    const task = {
      type: "session.run" as const,
      sessionId: "sess_empty_inline",
      prompt: "finish silently",
      channelReply: {
        workspaceId: "workspace-1",
        adapter: "qqbot" as const,
        adapterId: "qqbot",
        externalKey: "qqbot:c2c:user-1",
        recipient: "c2c:user-1",
      },
    };
    const scheduler = new SparkInvocationScheduler({
      store: invocations,
      executeTask: createChannelAwareTaskExecutor({
        paths,
        createSparkHeadlessSessionExecutor: () => async () => ({}),
        channelIngress: {
          openReplyStream: vi.fn(async () => ({
            appendText: vi.fn(),
            notifyToolStart: vi.fn(),
            notifyToolResult: vi.fn(),
            complete: vi.fn(async () => undefined),
            fail,
          })),
          sendReply,
        },
      }),
      completeInvocation: (invocation, completedTask, completion) =>
        completeInvocationWithChannelDelivery(
          { db, invocations, deliveries: outbox },
          invocation,
          completedTask,
          completion,
        ),
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
        errorCode: CHANNEL_REPLY_TERMINAL_PRESENTED_ERROR_CODE,
      });
      expect(fail).toHaveBeenCalledOnce();
      expect(sendReply).not.toHaveBeenCalled();
      expect(
        outbox.findByIdempotencyKey(`channel.reply:failure:${invocation.invocationId}`),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("keeps a failed inline completion in the recovery outbox without rerunning the model", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const recovery = {
      kind: "infoflow.streaming-card.v1",
      data: { modifyToken: "token-1" },
    } as const;
    let submittedInvocationId = "";
    const executeSession = vi.fn(async () => {
      expect(deliveries.require(channelReplyDeliveryId(submittedInvocationId))).toMatchObject({
        status: "sending",
        text: "处理因服务重启而中断，请重新发送",
        deliveryMode: "inline-stream",
        recovery,
      });
      return { assistantText: "最终答案" };
    });
    const sendReply = vi.fn(async () => undefined);
    const recoverReply = vi.fn(async () => undefined);
    const task = {
      type: "session.run" as const,
      sessionId: "sess_channel_delivery",
      prompt: "请处理",
      workspaceId: "workspace-1",
      channelReply: {
        workspaceId: "workspace-1",
        adapter: "infoflow" as const,
        adapterId: "infoflow",
        externalKey: "infoflow:group:10838226",
        recipient: "group:10838226",
      },
      channelContext: {
        externalKey: "infoflow:group:10838226",
        senderId: "user-1",
        messageId: "message-1",
      },
    };
    const channelIngress = {
      openReplyStream: vi.fn(async () => ({
        deliveryRecovery: recovery,
        appendText: vi.fn(),
        notifyToolStart: vi.fn(),
        notifyToolResult: vi.fn(),
        complete: vi.fn(async () => {
          throw new Error("card update failed");
        }),
        fail: vi.fn(async () => undefined),
      })),
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
    submittedInvocationId = invocation.invocationId;

    try {
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();

      expect(invocations.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: {
          assistantText: "最终答案",
          channelReplyDeliveryPending: true,
        },
      });
      expect(executeSession).toHaveBeenCalledTimes(1);
      expect(deliveries.require(channelReplyDeliveryId(invocation.invocationId))).toMatchObject({
        status: "pending",
        attemptCount: 1,
        deliveryMode: "inline-stream",
        recovery,
        text: "最终答案",
        lastError: "card update failed",
      });

      await expect(
        reconcileChannelReplyDeliveries({
          store: deliveries,
          channelIngress: { sendReply, recoverReply },
          now: () => "2099-01-01T00:00:00.000Z",
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, pending: 0, uncertain: 0 });

      expect(executeSession).toHaveBeenCalledTimes(1);
      expect(sendReply).not.toHaveBeenCalled();
      expect(recoverReply).toHaveBeenCalledTimes(1);
      expect(deliveries.require(channelReplyDeliveryId(invocation.invocationId))).toMatchObject({
        status: "acked",
        attemptCount: 2,
        deliveredAt: expect.any(String),
      });
      expect(invocations.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
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

  it("quarantines an interrupted legacy ordinary reply after restart", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const invocation = invocations.submit({
      sessionId: "sess_interrupted",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess_interrupted", prompt: "run" },
    });
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    expect(() =>
      deliveries.stage({
        invocationId: invocation.invocationId,
        sessionId: "sess_interrupted",
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        target: { recipient: "c2c:user-1", messageId: "message-1" },
        text: "answer",
      }),
    ).toThrow(/unified channel delivery outbox/u);
    const deliveryId = insertLegacyReplyDelivery(db, {
      invocationId: invocation.invocationId,
      sessionId: "sess_interrupted",
      workspaceId: "workspace-1",
      adapterId: "qqbot",
      target: { recipient: "c2c:user-1", messageId: "message-1" },
      text: "answer",
    });

    try {
      expect(deliveries.recoverInterrupted("2026-07-15T00:00:00.000Z")).toBe(1);
      expect(deliveries.require(deliveryId)).toMatchObject({
        status: "uncertain",
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
      ).resolves.toEqual({ attempted: 1, delivered: 1, pending: 0, uncertain: 0 });

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

  it("quarantines a historical unrecoverable stream without sending a fresh message", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const invocation = invocations.submit({
      sessionId: "sess_stream_unknown",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess_stream_unknown", prompt: "run" },
    });
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const deliveryId = insertLegacyReplyDelivery(db, {
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
      expect(deliveries.recoverInterrupted("2026-07-15T00:00:00.000Z")).toBe(1);

      expect(sendReply).not.toHaveBeenCalled();
      expect(recoverReply).not.toHaveBeenCalled();
      expect(deliveries.require(deliveryId)).toMatchObject({
        status: "uncertain",
        deliveryMode: "inline-stream",
        lastError: expect.stringContaining("restarted"),
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
      ).resolves.toEqual({ attempted: 1, delivered: 0, pending: 1, uncertain: 0 });

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

  it("retries a historical ordinary reply only when the adapter can deduplicate its delivery id", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const invocation = invocations.submit({
      sessionId: "sess_legacy_deduplicated",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess_legacy_deduplicated", prompt: "run" },
    });
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const deliveryId = insertLegacyReplyDelivery(
      db,
      {
        invocationId: invocation.invocationId,
        sessionId: "sess_legacy_deduplicated",
        workspaceId: "workspace-1",
        adapterId: "qqbot",
        target: { recipient: "c2c:user-1", messageId: "message-1" },
        text: "answer",
      },
      "pending",
    );
    const sendReply = vi.fn(async () => ({ replaySafety: "deduplicated" as const }));

    try {
      await expect(
        reconcileChannelReplyDeliveries({
          store: deliveries,
          channelIngress: {
            sendReply,
            recoverReply: vi.fn(),
            replyDeliveryFacts: vi.fn(() => ({ replaySafety: "deduplicated" as const })),
          },
          now: () => "2026-07-15T00:00:00.000Z",
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 1, pending: 0, uncertain: 0 });
      expect(sendReply).toHaveBeenCalledWith("workspace-1", "qqbot", {
        recipient: "c2c:user-1",
        messageId: "message-1",
        text: "answer",
        deliveryId,
      });
      expect(deliveries.require(deliveryId)).toMatchObject({ status: "acked" });
    } finally {
      db.close();
    }
  });

  it("quarantines a historical pending ordinary reply when replay safety is unknown", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const invocation = invocations.submit({
      sessionId: "sess_legacy_unsafe",
      prompt: "run",
      task: { type: "session.run", sessionId: "sess_legacy_unsafe", prompt: "run" },
    });
    const deliveries = new ChannelReplyDeliveryStore(db, invocations);
    const deliveryId = insertLegacyReplyDelivery(
      db,
      {
        invocationId: invocation.invocationId,
        sessionId: "sess_legacy_unsafe",
        workspaceId: "workspace-1",
        adapterId: "infoflow",
        target: { recipient: "user-1" },
        text: "answer",
      },
      "pending",
    );
    const sendReply = vi.fn();

    try {
      await expect(
        reconcileChannelReplyDeliveries({
          store: deliveries,
          channelIngress: { sendReply, recoverReply: vi.fn() },
          now: () => "2026-07-15T00:00:00.000Z",
        }),
      ).resolves.toEqual({ attempted: 1, delivered: 0, pending: 0, uncertain: 1 });
      expect(sendReply).not.toHaveBeenCalled();
      expect(deliveries.require(deliveryId)).toMatchObject({
        status: "uncertain",
        lastError: expect.stringContaining("automatic retry stopped"),
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
        deliveryMode: "inline-stream",
        recovery: {
          kind: "infoflow.streaming-card.v1",
          data: { modifyToken: "token-backoff" },
        },
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

function insertLegacyReplyDelivery(
  db: DatabaseSync,
  input: {
    invocationId: string;
    sessionId: string;
    workspaceId: string;
    adapterId: string;
    target: { recipient: string; messageId?: string };
    text: string;
    deliveryMode?: "message" | "inline-stream";
  },
  status: "sending" | "pending" = "sending",
): string {
  const deliveryId = channelReplyDeliveryId(input.invocationId);
  const now = "2026-07-14T23:59:59.000Z";
  db.prepare(
    `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
     VALUES (?, 'channel.reply', ?, ?, ?, ?)`,
  ).run(
    deliveryId,
    JSON.stringify({
      version: 1,
      ...input,
      deliveryMode: input.deliveryMode ?? "message",
      attemptCount: 0,
    }),
    status,
    now,
    now,
  );
  return deliveryId;
}
