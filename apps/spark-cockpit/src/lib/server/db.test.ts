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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOwnerSession, getCurrentUserId } from "./auth";
import {
  closeDatabase,
  databasePinCountForTests,
  getDatabase,
  pinDatabase,
  setDatabaseIdleCloseMsForTests,
  unpinDatabase,
  withDatabase,
  DATABASE_IDLE_CLOSE_MS,
} from "./db";

const originalEnv = { ...process.env };
const roots: string[] = [];

beforeEach(() => {
  vi.useRealTimers();
  setDatabaseIdleCloseMsForTests(DATABASE_IDLE_CLOSE_MS);
});

afterEach(() => {
  closeDatabase();
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  setDatabaseIdleCloseMsForTests(DATABASE_IDLE_CLOSE_MS);
});

describe("Cockpit database lifecycle", () => {
  it("holds one process lock while pinned and preserves instance identity", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-db-lifecycle-"));
    roots.push(root);
    process.env = { ...originalEnv, SPARK_HOME: root };
    const databasePath = defaultDatabasePath();
    const lockPath = cockpitDatabaseLockPath(databasePath);

    const first = pinDatabase();
    const instanceId = readCockpitInstanceId(first);

    expect(instanceId).toMatch(/^cockpit_[a-f0-9]{32}$/u);
    expect(getDatabase()).toBe(first);
    expect(existsSync(lockPath)).toBe(true);
    expect(() => acquireCockpitDatabaseLock(databasePath)).toThrow(CockpitDatabaseLockedError);

    unpinDatabase();
    closeDatabase();
    expect(existsSync(lockPath)).toBe(false);

    const reopened = pinDatabase();
    expect(realpathSync(reopened.location()!)).toBe(realpathSync(databasePath));
    expect(readCockpitInstanceId(reopened)).toBe(instanceId);
    unpinDatabase();
  });

  it("throws from getDatabase when the DB is closed", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-db-closed-"));
    roots.push(root);
    process.env = { ...originalEnv, SPARK_HOME: root };
    expect(() => getDatabase()).toThrow(/Cockpit database is closed/);
  });

  it("closes after idle grace and lets another process acquire the lock", () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-db-idle-"));
    roots.push(root);
    process.env = { ...originalEnv, SPARK_HOME: root };
    const databasePath = defaultDatabasePath();
    const lockPath = cockpitDatabaseLockPath(databasePath);
    setDatabaseIdleCloseMsForTests(30_000);

    pinDatabase();
    expect(existsSync(lockPath)).toBe(true);
    unpinDatabase();
    expect(databasePinCountForTests()).toBe(0);
    expect(existsSync(lockPath)).toBe(true);

    vi.advanceTimersByTime(29_999);
    expect(existsSync(lockPath)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(() => getDatabase()).toThrow(/Cockpit database is closed/);

    const other = acquireCockpitDatabaseLock(databasePath);
    other.release();
  });

  it("cancels idle close when pinned again", () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-db-repin-"));
    roots.push(root);
    process.env = { ...originalEnv, SPARK_HOME: root };
    const lockPath = cockpitDatabaseLockPath(defaultDatabasePath());
    setDatabaseIdleCloseMsForTests(30_000);

    const first = pinDatabase();
    unpinDatabase();
    vi.advanceTimersByTime(10_000);
    const second = pinDatabase();
    expect(second).toBe(first);
    vi.advanceTimersByTime(30_000);
    expect(existsSync(lockPath)).toBe(true);
    expect(getDatabase()).toBe(first);
    unpinDatabase();
  });

  it("nests pins via withDatabase", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-db-with-"));
    roots.push(root);
    process.env = { ...originalEnv, SPARK_HOME: root };

    const syncId = withDatabase((db) => readCockpitInstanceId(db));
    expect(syncId).toMatch(/^cockpit_/);
    expect(databasePinCountForTests()).toBe(0);

    const asyncId = await withDatabase(async (db) => {
      expect(databasePinCountForTests()).toBe(1);
      return readCockpitInstanceId(db);
    });
    expect(asyncId).toBe(syncId);
    expect(databasePinCountForTests()).toBe(0);
  });

  it("invalidates a real browser session after restore", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-cockpit-db-restore-"));
    roots.push(root);
    process.env = { ...originalEnv, SPARK_HOME: root };
    const databasePath = defaultDatabasePath();
    const snapshotPath = join(root, "browser-session.snapshot");
    const db = pinDatabase();
    const session = createOwnerSession(db, "Owner", null);
    expect(getCurrentUserId(db, session.sessionToken)).toBe(session.userId);

    await createCockpitSnapshot({ sourceDb: db, destination: snapshotPath });
    closeDatabase();
    await restoreCockpitSnapshot({
      snapshotPath,
      databasePath,
      rollbackRoot: join(root, "rollback"),
    });

    const restored = pinDatabase();
    expect(getCurrentUserId(restored, session.sessionToken)).toBeNull();
    unpinDatabase();
  });
});
