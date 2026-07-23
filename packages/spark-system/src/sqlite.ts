import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openSqliteDatabase(path: string): DatabaseSync {
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  applySqlitePragmas(db);
  return db;
}

export function openMemorySqliteDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applySqlitePragmas(db);
  return db;
}

export function applySqlitePragmas(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
}
