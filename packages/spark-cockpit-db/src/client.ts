import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applySqlitePragmas,
  openMemorySqliteDatabase,
  openSqliteDatabase,
  resolveSparkPaths,
} from "@zendev-lab/spark-system";

export interface OpenDatabaseOptions {
  path?: string;
}

export function defaultDatabasePath(): string {
  return resolveSparkPaths({ app: "cockpit" }).databasePath;
}

export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseSync {
  const databasePath = resolve(options.path ?? defaultDatabasePath());
  return openSqliteDatabase(databasePath);
}

export function openMemoryDatabase(): DatabaseSync {
  return openMemorySqliteDatabase();
}

export function applyPragmas(db: DatabaseSync): void {
  applySqlitePragmas(db);
}
