import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
