import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireCockpitDatabaseLock,
  cockpitDatabaseLockPath,
  CockpitDatabaseLockedError,
  createCockpitSnapshot,
  defaultDatabasePath,
  readCockpitInstanceId,
  restoreCockpitSnapshot,
} from "@zendev-lab/spark-db";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerSession, getCurrentUserId } from "./auth";
import { closeDatabase, getDatabase } from "./db";

const originalEnv = { ...process.env };
const roots: string[] = [];

afterEach(() => {
  closeDatabase();
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Cockpit database lifecycle", () => {
  it("holds one process lock, survives repeated access, and preserves instance identity", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-db-lifecycle-"));
    roots.push(root);
    process.env = { ...originalEnv, SPARK_COCKPIT_DATA_DIR: root };
    const databasePath = defaultDatabasePath();
    const lockPath = cockpitDatabaseLockPath(databasePath);

    const first = getDatabase();
    const instanceId = readCockpitInstanceId(first);

    expect(instanceId).toMatch(/^cockpit_[a-f0-9]{32}$/u);
    expect(getDatabase()).toBe(first);
    expect(existsSync(lockPath)).toBe(true);
    expect(() => acquireCockpitDatabaseLock(databasePath)).toThrow(CockpitDatabaseLockedError);

    closeDatabase();
    expect(existsSync(lockPath)).toBe(false);

    const reopened = getDatabase();
    expect(realpathSync(reopened.location()!)).toBe(realpathSync(databasePath));
    expect(readCockpitInstanceId(reopened)).toBe(instanceId);
  });

  it("invalidates a real browser session after restore", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-db-restore-"));
    roots.push(root);
    process.env = { ...originalEnv, SPARK_COCKPIT_DATA_DIR: root };
    const databasePath = defaultDatabasePath();
    const snapshotPath = join(root, "browser-session.snapshot");
    const db = getDatabase();
    const session = createOwnerSession(db, "Owner", null);
    expect(getCurrentUserId(db, session.sessionToken)).toBe(session.userId);

    await createCockpitSnapshot({ sourceDb: db, destination: snapshotPath });
    closeDatabase();
    await restoreCockpitSnapshot({
      snapshotPath,
      databasePath,
      rollbackRoot: join(root, "rollback"),
    });

    const restored = getDatabase();
    expect(getCurrentUserId(restored, session.sessionToken)).toBeNull();
  });
});
