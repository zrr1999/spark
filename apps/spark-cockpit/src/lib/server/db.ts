import {
  acquireCockpitDatabaseLock,
  defaultDatabasePath,
  ensureCockpitInstanceId,
  migrate,
  openDatabase,
  type CockpitDatabaseLockHandle,
} from "@zendev-lab/spark-db";

interface CockpitDatabaseState {
  database?: ReturnType<typeof openDatabase>;
  databaseLock?: CockpitDatabaseLockHandle;
}

const globalScope = globalThis as typeof globalThis & {
  __sparkCockpitDatabaseState__?: CockpitDatabaseState;
};
const state = (globalScope.__sparkCockpitDatabaseState__ ??= {});

export function getDatabase() {
  if (state.database) return state.database;

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
    return opened;
  } catch (error) {
    lock.release();
    throw error;
  }
}

export function closeDatabase(): void {
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
