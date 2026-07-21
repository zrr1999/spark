import {
  acquireCockpitDatabaseLock,
  defaultDatabasePath,
  ensureCockpitInstanceId,
  migrate,
  openDatabase,
  type CockpitDatabaseLockHandle,
} from "@zendev-lab/spark-db";
import type { DatabaseSync } from "node:sqlite";

/** Idle grace before closing the DB and releasing the process lock when pin count hits 0. */
export const DATABASE_IDLE_CLOSE_MS = 30_000;

interface CockpitDatabaseState {
  database?: ReturnType<typeof openDatabase>;
  databaseLock?: CockpitDatabaseLockHandle;
  pinCount: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleCloseMs: number;
}

const globalScope = globalThis as typeof globalThis & {
  __sparkCockpitDatabaseState__?: CockpitDatabaseState;
};
const state = (globalScope.__sparkCockpitDatabaseState__ ??= {
  pinCount: 0,
  idleCloseMs: DATABASE_IDLE_CLOSE_MS,
});

/**
 * Nestable consumer pin. Opens the DB and acquires the sqlite lock on 0→1.
 * Cancels any pending idle close.
 */
export function pinDatabase(): DatabaseSync {
  cancelIdleClose();
  if (!state.database) {
    openLockedDatabase();
  }
  state.pinCount += 1;
  return state.database!;
}

/**
 * Drop one pin. When the count reaches 0, schedule idle close (does not close immediately).
 */
export function unpinDatabase(): void {
  if (state.pinCount <= 0) return;
  state.pinCount -= 1;
  if (state.pinCount === 0) {
    scheduleIdleClose();
  }
}

/**
 * Return the open DB without changing the pin count.
 * Callers must already be under `pinDatabase` / `withDatabase` / the request hook.
 */
export function getDatabase(): DatabaseSync {
  if (!state.database) {
    throw new Error(
      "Cockpit database is closed. Call pinDatabase() or withDatabase() before getDatabase().",
    );
  }
  return state.database;
}

export function withDatabase<T>(fn: (db: DatabaseSync) => T): T;
export function withDatabase<T>(fn: (db: DatabaseSync) => Promise<T>): Promise<T>;
export function withDatabase<T>(fn: (db: DatabaseSync) => T | Promise<T>): T | Promise<T> {
  const db = pinDatabase();
  try {
    const result = fn(db);
    if (isPromise(result)) {
      return result.finally(() => {
        unpinDatabase();
      });
    }
    unpinDatabase();
    return result;
  } catch (error) {
    unpinDatabase();
    throw error;
  }
}

/** Cancel idle timer and force-close the DB (shutdown / tests). */
export function closeDatabase(): void {
  cancelIdleClose();
  state.pinCount = 0;
  const opened = state.database;
  const lock = state.databaseLock;
  state.database = undefined;
  state.databaseLock = undefined;
  try {
    opened?.close();
  } finally {
    lock?.release();
  }
}

/** Test-only: override idle grace (use with fake timers). */
export function setDatabaseIdleCloseMsForTests(ms: number): void {
  state.idleCloseMs = ms;
}

/** Test-only: inspect pin count. */
export function databasePinCountForTests(): number {
  return state.pinCount;
}

function openLockedDatabase(): void {
  const databasePath = defaultDatabasePath();
  const lock = acquireCockpitDatabaseLock(databasePath);
  try {
    const opened = openDatabase({ path: databasePath });
    try {
      migrate(opened);
      ensureCockpitInstanceId(opened);
    } catch (error) {
      opened.close();
      throw error;
    }
    state.databaseLock = lock;
    state.database = opened;
  } catch (error) {
    lock.release();
    throw error;
  }
}

function scheduleIdleClose(): void {
  cancelIdleClose();
  state.idleTimer = setTimeout(() => {
    state.idleTimer = undefined;
    if (state.pinCount !== 0) return;
    closeDatabase();
  }, state.idleCloseMs);
  // Allow Node to exit while the idle timer is pending (tests + short-lived CLI).
  state.idleTimer.unref?.();
}

function cancelIdleClose(): void {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value) && typeof (value as Promise<T>).then === "function";
}
