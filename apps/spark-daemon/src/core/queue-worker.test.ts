import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPARK_PROTOCOL_VERSION, type SparkDaemonEvent } from "@zendev-lab/spark-protocol";
import { SparkDaemonQueue } from "./queue.js";
import {
  DEFAULT_SPARK_DAEMON_QUEUE_CONCURRENCY,
  DEFAULT_SPARK_DAEMON_QUEUE_LAUNCH_LIMIT,
  createSparkDaemonActiveTasks,
  processSparkDaemonQueueBatch,
  waitForSparkDaemonActiveTasks,
} from "./queue-worker.js";
import { createSparkDaemonWorkerContext, runSparkDaemonWorkerIteration } from "./runtime-worker.js";
import type { SparkDaemonTaskExecutor } from "./types.js";

describe("Spark daemon executor queue fan-out", () => {
  it("defaults queue batches to unbounded launch and concurrency", async () => {
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
      await queue.enqueue({ type: "session.run", sessionId: "session-one", prompt: "one" });
      await queue.enqueue({ type: "session.run", sessionId: "session-two", prompt: "two" });

      await expect(processSparkDaemonQueueBatch({ queue, active, executeTask })).resolves.toBe(
        true,
      );

      expect(DEFAULT_SPARK_DAEMON_QUEUE_LAUNCH_LIMIT).toBe(Number.POSITIVE_INFINITY);
      expect(DEFAULT_SPARK_DAEMON_QUEUE_CONCURRENCY).toBe(Number.POSITIVE_INFINITY);
      expect(launched.sort()).toEqual(["session-one", "session-two"]);
      expect(active.files.size).toBe(2);
      expect(active.invocations.snapshot()).toHaveLength(2);

      gate.resolve();
      await waitForSparkDaemonActiveTasks(active);
      await expect(queue.list("processed")).resolves.toHaveLength(2);
    } finally {
      gate.resolve();
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

  it("runtime worker iteration inherits unbounded executor fan-out defaults", async () => {
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
