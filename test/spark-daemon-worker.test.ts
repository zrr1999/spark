import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SparkDaemonQueue,
  SparkDaemonWorkerLoop,
  createSparkDaemonActiveTasks,
  createSparkDaemonWorkerContext,
  processSparkDaemonQueueBatch,
  runSparkDaemonWorkerIteration,
  type SparkDaemonTaskExecutor,
} from "../apps/spark-daemon/src/core/index.ts";

void test("processSparkDaemonQueueBatch launches at most one active task per session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-worker-dedupe-"));
  try {
    const queue = new SparkDaemonQueue({ daemonRoot: join(dir, "daemon") });
    const first = await queue.enqueue({ type: "session.run", sessionId: "same", prompt: "first" });
    const second = await queue.enqueue({
      type: "session.run",
      sessionId: "same",
      prompt: "second",
    });
    const third = await queue.enqueue({ type: "session.run", sessionId: "other", prompt: "third" });
    const active = createSparkDaemonActiveTasks();
    const started: string[] = [];
    const release = deferred<void>();
    const executeTask: SparkDaemonTaskExecutor = async (task) => {
      started.push(`${task.sessionId}:${task.prompt}`);
      await release.promise;
    };

    const didLaunch = await processSparkDaemonQueueBatch({
      queue,
      active,
      executeTask,
      concurrency: 2,
      limit: 10,
    });

    assert.equal(didLaunch, true);
    assert.deepEqual(started.sort(), ["other:third", "same:first"]);
    assert.equal(active.files.has(first.fileName), true);
    assert.equal(active.files.has(third.fileName), true);
    assert.equal(active.files.has(second.fileName), false);
    assert.equal(active.sessions.has("same"), true);
    assert.equal(active.sessions.has("other"), true);
    assert.equal(active.invocations.hasActiveSession("same"), true);
    assert.equal(active.invocations.hasActiveSession("other"), true);

    release.resolve();
    await waitFor(async () => (await queue.list("processed")).length === 2);
    assert.deepEqual(await queue.list("inbox"), [second.fileName]);

    await processSparkDaemonQueueBatch({ queue, active, executeTask: async () => undefined });
    await waitFor(async () => (await queue.list("processed")).length === 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("processSparkDaemonQueueBatch moves executor failures to failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-worker-fail-"));
  try {
    const queue = new SparkDaemonQueue({ daemonRoot: join(dir, "daemon") });
    const entry = await queue.enqueue({ type: "session.run", sessionId: "s", prompt: "explode" });
    const active = createSparkDaemonActiveTasks();

    await processSparkDaemonQueueBatch({
      queue,
      active,
      executeTask: async () => {
        throw new Error("executor boom");
      },
    });

    await waitFor(async () => (await queue.list("failed")).length === 1);
    assert.deepEqual(await queue.list("inbox"), []);
    const failed = JSON.parse(await readFile(join(queue.failedDir, entry.fileName), "utf8")) as {
      error?: string;
    };
    assert.equal(failed.error, "executor boom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkDaemonWorkerLoop supports poll/wake and bounded stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-worker-loop-"));
  try {
    const queue = new SparkDaemonQueue({ daemonRoot: join(dir, "daemon") });
    const processed: string[] = [];
    const context = createSparkDaemonWorkerContext({
      queue,
      executeTask: async (task) => {
        processed.push(task.prompt);
      },
    });
    const loop = new SparkDaemonWorkerLoop({ context, pollIntervalMs: 5 });
    await loop.start();

    const entry = await queue.enqueue({ type: "session.run", sessionId: "s", prompt: "wake task" });
    loop.wake();
    await waitFor(
      async () =>
        processed.includes("wake task") && (await queue.list("processed")).includes(entry.fileName),
    );

    await loop.stop();
    assert.deepEqual(await queue.list("processed"), [entry.fileName]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkDaemonWorkerIteration uses default executor as a loud failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-default-executor-"));
  try {
    const queue = new SparkDaemonQueue({ daemonRoot: join(dir, "daemon") });
    await queue.enqueue({ type: "session.run", sessionId: "s", prompt: "no executor" });
    const context = createSparkDaemonWorkerContext({ queue });

    await runSparkDaemonWorkerIteration({ context });
    await waitFor(async () => (await queue.list("failed")).length === 1);
    const failedName = (await queue.list("failed"))[0]!;
    const failed = JSON.parse(await readFile(join(queue.failedDir, failedName), "utf8")) as {
      error?: string;
    };
    assert.match(failed.error ?? "", /No Spark daemon executor wired/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
