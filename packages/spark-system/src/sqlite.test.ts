import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openMemorySqliteDatabase, openSqliteDatabase } from "./sqlite.ts";

describe("Spark SQLite mechanism", () => {
  it("opens a configured database with shared safety pragmas", () => {
    const db = openMemorySqliteDatabase();
    try {
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
      db.close();
    }
  });

  it("creates the parent directory for a file-backed database", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-system-sqlite-"));
    const db = openSqliteDatabase(join(root, "nested", "spark.sqlite"));
    try {
      db.exec("CREATE TABLE proof (id TEXT PRIMARY KEY)");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'proof'").get()).toEqual({
        name: "proof",
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
