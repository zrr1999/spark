import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateLegacyQueueHistory } from "./legacy-queue-migration.ts";
import { SparkInvocationStore } from "./invocations.ts";
import { migrateSparkDaemonDatabase } from "./schema.ts";

describe("migrateLegacyQueueHistory", () => {
  it("imports every legacy state, reports malformed entries, archives, and reruns idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-legacy-queue-"));
    const queueRoot = join(root, "queue");
    for (const state of ["inbox", "processed", "failed"]) {
      await mkdir(join(queueRoot, state), { recursive: true });
    }
    await writeLegacy(queueRoot, "inbox", "queued.json", {
      enqueuedAt: "2026-07-14T00:00:00.000Z",
      task: { type: "session.run", sessionId: "session-queued", prompt: "queued" },
    });
    await writeLegacy(queueRoot, "processed", "done.json", {
      enqueuedAt: "2026-07-14T00:00:01.000Z",
      processedAt: "2026-07-14T00:00:02.000Z",
      task: { type: "session.run", sessionId: "session-done", prompt: "done" },
      result: { assistantText: "done" },
    });
    await writeLegacy(queueRoot, "processed", "duplicate-task.json", {
      enqueuedAt: "2026-07-14T00:00:03.000Z",
      processedAt: "2026-07-14T00:00:04.000Z",
      task: { type: "session.run", sessionId: "session-done", prompt: "done" },
      result: { assistantText: "done again" },
    });
    await writeLegacy(queueRoot, "failed", "failed.json", {
      enqueuedAt: "2026-07-14T00:00:05.000Z",
      failedAt: "2026-07-14T00:00:06.000Z",
      task: { type: "session.run", sessionId: "session-failed", prompt: "failed" },
      error: "legacy failure",
    });
    await writeFile(join(queueRoot, "failed", "malformed.json"), "{broken\n", "utf8");

    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const first = await migrateLegacyQueueHistory({
        db,
        queueRoot,
        now: "2026-07-14T01:00:00.000Z",
      });
      expect(first).toMatchObject({
        imported: { inbox: 1, processed: 2, failed: 1 },
        malformed: 1,
        alreadyComplete: false,
      });
      expect(first.archivePath).toBeDefined();
      await expect(stat(first.archivePath!)).resolves.toBeDefined();
      await expect(stat(queueRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(first.archivePath!, "failed", "malformed.json"), "utf8"),
      ).resolves.toBe("{broken\n");

      const store = new SparkInvocationStore(db);
      expect(store.findByIdempotencyKey("legacy-queue:inbox:queued.json")).toMatchObject({
        status: "queued",
        sourceKind: "legacy-queue",
        sourceRef: "inbox/queued.json",
      });
      expect(store.findByIdempotencyKey("legacy-queue:processed:done.json")).toMatchObject({
        status: "succeeded",
        result: { assistantText: "done" },
      });
      expect(store.findByIdempotencyKey("legacy-queue:failed:failed.json")).toMatchObject({
        status: "failed",
        errorMessage: "legacy failure",
      });

      const second = await migrateLegacyQueueHistory({ db, queueRoot });
      expect(second).toMatchObject({
        imported: first.imported,
        malformed: first.malformed,
        archivePath: first.archivePath,
        alreadyComplete: true,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM invocations").get()).toEqual({ count: 4 });
      console.info(
        "SPARK_INVOCATION_LEGACY_MIGRATION_TRANSCRIPT",
        JSON.stringify({
          firstRun: first,
          secondRun: second,
          invocationCount: 4,
          sourceDirectoryRecreated: false,
        }),
      );
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an archived import when the migration marker was not committed", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-legacy-queue-recovery-"));
    const queueRoot = join(root, "queue");
    await mkdir(join(queueRoot, "processed"), { recursive: true });
    await writeLegacy(queueRoot, "processed", "done.json", {
      enqueuedAt: "2026-07-14T00:00:00.000Z",
      processedAt: "2026-07-14T00:00:01.000Z",
      task: { type: "session.run", sessionId: "session-done", prompt: "done" },
      result: { assistantText: "done" },
    });

    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const first = await migrateLegacyQueueHistory({
        db,
        queueRoot,
        now: "2026-07-14T01:00:00.000Z",
      });
      expect(first.archivePath).toBeDefined();
      db.prepare("DELETE FROM daemon_meta WHERE key = ?").run(first.migrationKey);

      const recovered = await migrateLegacyQueueHistory({
        db,
        queueRoot,
        now: "2026-07-14T02:00:00.000Z",
      });
      expect(recovered).toMatchObject({
        imported: { inbox: 0, processed: 1, failed: 0 },
        malformed: 0,
        archivePath: first.archivePath,
        alreadyComplete: false,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM invocations").get()).toEqual({ count: 1 });
      await expect(stat(first.archivePath!)).resolves.toBeDefined();
      await expect(stat(queueRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create an active directory when no migration source exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-no-legacy-queue-"));
    const queueRoot = join(root, "queue");
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const report = await migrateLegacyQueueHistory({ db, queueRoot });
      expect(report).toMatchObject({
        imported: { inbox: 0, processed: 0, failed: 0 },
        malformed: 0,
      });
      expect(report.archivePath).toBeUndefined();
      await expect(stat(queueRoot)).rejects.toMatchObject({ code: "ENOENT" });
      console.info(
        "SPARK_INVOCATION_CLEAN_INSTALL_TRANSCRIPT",
        JSON.stringify({ ...report, sourceDirectoryCreated: false }),
      );
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeLegacy(
  queueRoot: string,
  state: "inbox" | "processed" | "failed",
  fileName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(queueRoot, state, fileName), `${JSON.stringify(payload)}\n`, "utf8");
}
