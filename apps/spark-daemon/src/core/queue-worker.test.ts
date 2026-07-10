import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPARK_PROTOCOL_VERSION, type SparkDaemonEvent } from "@zendev-lab/spark-protocol";
import { SparkDaemonQueue } from "./queue.js";
import {
  DEFAULT_SPARK_DAEMON_QUEUE_CONCURRENCY,
  DEFAULT_SPARK_DAEMON_QUEUE_ABORT_DRAIN_MS,
  DEFAULT_SPARK_DAEMON_QUEUE_LAUNCH_LIMIT,
  DEFAULT_SPARK_DAEMON_QUEUE_TASK_TIMEOUT_MS,
  createSparkDaemonActiveTasks,
  processSparkDaemonQueueBatch,
  waitForSparkDaemonActiveTasks,
} from "./queue-worker.js";
import { createSparkDaemonWorkerContext, runSparkDaemonWorkerIteration } from "./runtime-worker.js";
import type { SparkDaemonTaskExecutor } from "./types.js";

describe("Spark daemon executor queue fan-out", () => {
  it("defaults queue batches to bounded launch and concurrency", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-queue-fanout-"));
    const queue = new SparkDaemonQueue({ daemonRoot: root });
    const active = createSparkDaemonActiveTasks();
    const gate = deferred<void>();
    const launched: string[] = [];
    const executeTask: SparkDaemonTaskExecutor = async (task) => {
      launched.push(task.sessionId);
      await gate.promise;
      return { ok: true, sessionId: task.sessionId };
    };

    try {
      for (let index = 1; index <= 6; index += 1) {
        await queue.enqueue({
          type: "session.run",
          sessionId: `session-${index}`,
          prompt: `prompt-${index}`,
        });
      }

      await expect(processSparkDaemonQueueBatch({ queue, active, executeTask })).resolves.toBe(
        true,
      );

      expect(DEFAULT_SPARK_DAEMON_QUEUE_LAUNCH_LIMIT).toBe(4);
      expect(DEFAULT_SPARK_DAEMON_QUEUE_CONCURRENCY).toBe(4);
      expect(DEFAULT_SPARK_DAEMON_QUEUE_TASK_TIMEOUT_MS).toBe(600_000);
      expect(DEFAULT_SPARK_DAEMON_QUEUE_ABORT_DRAIN_MS).toBe(1_000);
      expect(launched.sort()).toEqual(["session-1", "session-2", "session-3", "session-4"]);
      expect(active.files.size).toBe(4);
      expect(active.invocations.snapshot()).toHaveLength(4);

      gate.resolve();
      await waitForSparkDaemonActiveTasks(active);
      await expect(queue.list("processed")).resolves.toHaveLength(4);
      await expect(queue.list("inbox")).resolves.toHaveLength(2);
    } finally {
      gate.resolve();
      await waitForSparkDaemonActiveTasks(active).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a timed-out executor fenced from its session while other sessions continue", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-queue-timeout-"));
    const queue = new SparkDaemonQueue({ daemonRoot: root });
    const active = createSparkDaemonActiveTasks();
    const emitted: SparkDaemonEvent[] = [];
    const launched: string[] = [];
    const lateSettlement = deferred<void>();
    let firstSignal: AbortSignal | undefined;
    let runningSameSession = 0;
    let maxRunningSameSession = 0;
    const executeTask: SparkDaemonTaskExecutor = async (task, context) => {
      launched.push(task.prompt);
      if (task.prompt === "hang") {
        firstSignal = context.signal;
        runningSameSession += 1;
        maxRunningSameSession = Math.max(maxRunningSameSession, runningSameSession);
        // Deliberately ignore context.signal. The daemon must retain the session
        // fence even when an executor does not cooperate with cancellation.
        await lateSettlement.promise;
        runningSameSession -= 1;
      } else if (task.sessionId === "same-session") {
        runningSameSession += 1;
        maxRunningSameSession = Math.max(maxRunningSameSession, runningSameSession);
        runningSameSession -= 1;
      }
      return { ok: true, sessionId: task.sessionId };
    };

    try {
      await queue.enqueue({ type: "session.run", sessionId: "same-session", prompt: "hang" });
      await queue.enqueue({ type: "session.run", sessionId: "same-session", prompt: "next" });
      await queue.enqueue({ type: "session.run", sessionId: "other-session", prompt: "other" });

      await expect(
        processSparkDaemonQueueBatch({
          queue,
          active,
          executeTask,
          emitEvent: (event) => {
            emitted.push(event);
          },
          taskTimeoutMs: 10,
          taskAbortDrainMs: 5,
          concurrency: 1,
        }),
      ).resolves.toBe(true);
      expect(launched).toEqual(["hang"]);

      await waitForSparkDaemonActiveTasks(active, { timeoutMs: 500 });
      expect(firstSignal?.aborted).toBe(true);
      expect(active.files.size).toBe(0);
      expect(active.invocations.snapshot()).toEqual([
        expect.objectContaining({ sessionId: "same-session" }),
      ]);
      expect(active.sessions.has("same-session")).toBe(true);
      await expect(queue.list("failed")).resolves.toHaveLength(1);
      expect(emitted).toContainEqual(
        expect.objectContaining({
          type: "daemon.task.lifecycle",
          status: "failed",
          summary: "Spark daemon queue task timed out after 10ms",
        }),
      );

      // The same-session entry is skipped while the later, unrelated entry is
      // free to consume the released worker slot.
      await expect(
        processSparkDaemonQueueBatch({
          queue,
          active,
          executeTask,
          taskTimeoutMs: 10,
          taskAbortDrainMs: 5,
          concurrency: 1,
        }),
      ).resolves.toBe(true);
      await waitForSparkDaemonActiveTasks(active, { timeoutMs: 500 });
      expect(launched).toEqual(["hang", "other"]);
      await expect(queue.list("processed")).resolves.toHaveLength(1);

      await expect(
        processSparkDaemonQueueBatch({ queue, active, executeTask, concurrency: 1 }),
      ).resolves.toBe(false);
      expect(launched).toEqual(["hang", "other"]);

      lateSettlement.resolve();
      await eventually(
        () =>
          !active.invocations.hasActiveSession("same-session") &&
          !active.sessions.has("same-session"),
      );

      await expect(
        processSparkDaemonQueueBatch({ queue, active, executeTask, concurrency: 1 }),
      ).resolves.toBe(true);
      await waitForSparkDaemonActiveTasks(active, { timeoutMs: 500 });
      expect(launched).toEqual(["hang", "other", "next"]);
      expect(maxRunningSameSession).toBe(1);
      await expect(queue.list("processed")).resolves.toHaveLength(2);
    } finally {
      lateSettlement.resolve();
      await waitForSparkDaemonActiveTasks(active).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases a cancelled worker slot promptly but retains its session fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-queue-cancel-"));
    const queue = new SparkDaemonQueue({ daemonRoot: root });
    const active = createSparkDaemonActiveTasks();
    const emitted: SparkDaemonEvent[] = [];
    let firstSignal: AbortSignal | undefined;
    const sawAbort = deferred<void>();
    const cleanupGate = deferred<void>();
    const executeTask: SparkDaemonTaskExecutor = async (_task, context) => {
      firstSignal = context.signal;
      if (context.signal.aborted) sawAbort.resolve();
      else context.signal.addEventListener("abort", () => sawAbort.resolve(), { once: true });
      await sawAbort.promise;
      await cleanupGate.promise;
      throw new Error("executor stopped after cancellation");
    };

    try {
      await queue.enqueue({ type: "session.run", sessionId: "cancel-session", prompt: "hang" });
      await expect(
        processSparkDaemonQueueBatch({
          queue,
          active,
          executeTask,
          emitEvent: (event) => {
            emitted.push(event);
          },
          taskTimeoutMs: 10_000,
          taskAbortDrainMs: 5,
        }),
      ).resolves.toBe(true);

      const invocation = active.invocations.snapshot()[0];
      expect(invocation).toBeDefined();
      expect(active.invocations.cancel(invocation!.invocationId, "test cancellation")).toBe(true);
      await sawAbort.promise;
      await waitForSparkDaemonActiveTasks(active, { timeoutMs: 500 });
      expect(active.files.size).toBe(0);
      expect(active.invocations.snapshot()).toHaveLength(1);
      expect(active.invocations.hasActiveSession("cancel-session")).toBe(true);
      expect(active.sessions.has("cancel-session")).toBe(true);

      expect(firstSignal?.aborted).toBe(true);
      await expect(queue.list("failed")).resolves.toHaveLength(1);
      expect(emitted).toContainEqual(
        expect.objectContaining({
          type: "daemon.task.lifecycle",
          status: "cancelled",
          summary: "Spark daemon queue task cancelled: test cancellation",
        }),
      );

      cleanupGate.resolve();
      await eventually(
        () =>
          !active.invocations.hasActiveSession("cancel-session") &&
          !active.sessions.has("cancel-session"),
      );
      expect(active.invocations.snapshot()).toHaveLength(0);
    } finally {
      cleanupGate.resolve();
      await waitForSparkDaemonActiveTasks(active).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits shared daemon lifecycle and view-model events from queue execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-queue-events-"));
    const queue = new SparkDaemonQueue({ daemonRoot: root });
    const active = createSparkDaemonActiveTasks();
    const emitted: SparkDaemonEvent[] = [];
    const executeTask: SparkDaemonTaskExecutor = async (task) => ({
      ok: true,
      sessionId: task.sessionId,
      jsonEvents: [
        {
          type: "view_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "session.message",
            sessionId: task.sessionId,
            message: {
              version: SPARK_PROTOCOL_VERSION,
              id: "assistant-1",
              role: "assistant",
              text: "done from daemon",
              status: "done",
              metadata: {},
            },
          },
        },
        {
          type: "daemon_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "daemon.interaction.request",
            source: "runtime",
            request: {
              version: SPARK_PROTOCOL_VERSION,
              kind: "confirmation",
              requestId: "confirm-daemon-1",
              title: "Confirm daemon action",
              prompt: "Continue?",
              severity: "info",
              confirmLabel: "Confirm",
              cancelLabel: "Cancel",
              metadata: {},
            },
            metadata: {},
          },
        },
      ],
    });

    try {
      await queue.enqueue({ type: "session.run", sessionId: "session-events", prompt: "go" });

      await expect(
        processSparkDaemonQueueBatch({
          queue,
          active,
          executeTask,
          emitEvent: (event) => {
            emitted.push(event);
          },
        }),
      ).resolves.toBe(true);
      await waitForSparkDaemonActiveTasks(active);

      expect(emitted.map((event) => event.type)).toEqual([
        "daemon.task.lifecycle",
        "daemon.task.lifecycle",
        "daemon.view_event",
        "daemon.interaction.request",
      ]);
      expect(emitted[0]).toMatchObject({
        type: "daemon.task.lifecycle",
        status: "running",
        sessionId: "session-events",
      });
      expect(emitted[1]).toMatchObject({ type: "daemon.task.lifecycle", status: "succeeded" });
      expect(emitted[2]).toMatchObject({
        type: "daemon.view_event",
        sessionId: "session-events",
        view: { type: "session.message", sessionId: "session-events" },
      });
      expect(emitted[3]).toMatchObject({
        type: "daemon.interaction.request",
        sessionId: "session-events",
        invocationId: expect.any(String),
        request: { kind: "confirmation", requestId: "confirm-daemon-1" },
      });
    } finally {
      await waitForSparkDaemonActiveTasks(active).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit queue concurrency caps when configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-queue-capped-"));
    const queue = new SparkDaemonQueue({ daemonRoot: root });
    const active = createSparkDaemonActiveTasks();
    const gate = deferred<void>();
    const launched: string[] = [];
    const executeTask: SparkDaemonTaskExecutor = async (task) => {
      launched.push(task.sessionId);
      await gate.promise;
      return { ok: true, sessionId: task.sessionId };
    };

    try {
      await queue.enqueue({ type: "session.run", sessionId: "session-one", prompt: "one" });
      await queue.enqueue({ type: "session.run", sessionId: "session-two", prompt: "two" });

      await expect(
        processSparkDaemonQueueBatch({ queue, active, executeTask, concurrency: 1 }),
      ).resolves.toBe(true);

      expect(launched).toHaveLength(1);
      expect(active.files.size).toBe(1);
      expect(active.invocations.snapshot()).toHaveLength(1);
    } finally {
      gate.resolve();
      await waitForSparkDaemonActiveTasks(active).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runtime worker iteration inherits bounded executor fan-out defaults", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-runtime-fanout-"));
    const queue = new SparkDaemonQueue({ daemonRoot: root });
    const active = createSparkDaemonActiveTasks();
    const gate = deferred<void>();
    const launched: string[] = [];
    const executeTask: SparkDaemonTaskExecutor = async (task) => {
      launched.push(task.sessionId);
      await gate.promise;
      return { ok: true, sessionId: task.sessionId };
    };
    const context = createSparkDaemonWorkerContext({ queue, active, executeTask });

    try {
      await queue.enqueue({ type: "session.run", sessionId: "session-one", prompt: "one" });
      await queue.enqueue({ type: "session.run", sessionId: "session-two", prompt: "two" });

      await expect(runSparkDaemonWorkerIteration({ context })).resolves.toBe(true);

      expect(launched.sort()).toEqual(["session-one", "session-two"]);
      expect(active.files.size).toBe(2);
      expect(active.invocations.snapshot()).toHaveLength(2);
    } finally {
      gate.resolve();
      await waitForSparkDaemonActiveTasks(active).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not become true before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
