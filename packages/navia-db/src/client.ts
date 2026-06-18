import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveNaviaPaths } from "@zendev-lab/navia-system";

export interface OpenDatabaseOptions {
  path?: string;
}

export function defaultDatabasePath(): string {
  return resolveNaviaPaths({ app: "server" }).databasePath;
}

export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseSync {
  const databasePath = resolve(options.path ?? defaultDatabasePath());
  mkdirSync(dirname(databasePath), { recursive: true });

  const db = new DatabaseSync(databasePath);
  applyPragmas(db);
  return db;
}

export function openMemoryDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyPragmas(db);
  return db;
}

export function applyPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
}
