import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireSparkDaemonLock,
  readSparkDaemonLock,
} from "../apps/spark-daemon/src/core/index.ts";

void test("Spark daemon lock acquires, rejects duplicate live lock, and releases owner lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-lock-"));
  try {
    const runtimeDir = join(dir, "runtime");
    const lock = await acquireSparkDaemonLock({ runtimeDir, cwd: dir });
    const record = await readSparkDaemonLock(lock.path);
    assert.equal(record?.pid, process.pid);
    assert.equal(record?.cwd, dir);

    await assert.rejects(
      () => acquireSparkDaemonLock({ runtimeDir }),
      /another Spark daemon is already running/,
    );

    await lock.release();
    await assert.rejects(() => readFile(lock.path, "utf8"), /ENOENT/);
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark daemon lock recovers stale or malformed lock files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-stale-lock-"));
  try {
    const runtimeDir = join(dir, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const lockPath = join(runtimeDir, "daemon.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999_999, startedAt: "2026-06-03T00:00:00.000Z" }),
      "utf8",
    );

    const lock = await acquireSparkDaemonLock({ runtimeDir });
    assert.equal(lock.path, lockPath);
    assert.equal((await readSparkDaemonLock(lockPath))?.pid, process.pid);
    await lock.release();

    await writeFile(lockPath, "not json", "utf8");
    const recovered = await acquireSparkDaemonLock({ runtimeDir });
    assert.equal((await readSparkDaemonLock(lockPath))?.pid, process.pid);
    await recovered.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
