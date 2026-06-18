import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SparkDaemonQueue } from "../apps/spark/src/host/index.ts";

void test("SparkDaemonQueue enqueues, reads, and marks processed session.run tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-queue-"));
  try {
    const queue = new SparkDaemonQueue({ daemonRoot: join(dir, "daemon") });
    const entry = await queue.enqueue({ type: "session.run", sessionId: "s1", prompt: "hello" });

    assert.deepEqual(await queue.list("inbox"), [entry.fileName]);
    const loaded = await queue.readEntry(entry.fileName);
    assert.equal(loaded.payload.task.type, "session.run");
    assert.equal(loaded.payload.task.sessionId, "s1");
    assert.equal(loaded.payload.task.prompt, "hello");

    const processedPath = await queue.markProcessed(entry.fileName);
    assert.deepEqual(await queue.list("inbox"), []);
    assert.deepEqual(await queue.list("processed"), [entry.fileName]);
    assert.match(processedPath, /processed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkDaemonQueue writes failed metadata before moving failed entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-failed-queue-"));
  try {
    const queue = new SparkDaemonQueue({ daemonRoot: join(dir, "daemon") });
    const entry = await queue.enqueue({
      type: "session.run",
      sessionId: "s2",
      prompt: "fail please",
      actor: "test",
    });

    const failedPath = await queue.markFailed(entry.fileName, new Error("boom"));
    assert.deepEqual(await queue.list("inbox"), []);
    assert.deepEqual(await queue.list("failed"), [entry.fileName]);
    const failed = JSON.parse(await readFile(failedPath, "utf8")) as {
      error?: string;
      failedAt?: string;
      task?: { sessionId?: string; actor?: string };
    };
    assert.equal(failed.error, "boom");
    assert.equal(typeof failed.failedAt, "string");
    assert.equal(failed.task?.sessionId, "s2");
    assert.equal(failed.task?.actor, "test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkDaemonQueue validates task payloads before enqueue", async () => {
  const queue = new SparkDaemonQueue({ daemonRoot: join(tmpdir(), "spark-daemon-invalid-queue") });
  await assert.rejects(
    () => queue.enqueue({ type: "session.run", sessionId: "", prompt: "x" }),
    /requires sessionId/,
  );
  await assert.rejects(
    () => queue.enqueue({ type: "session.run", sessionId: "s", prompt: "" }),
    /requires prompt/,
  );
});
