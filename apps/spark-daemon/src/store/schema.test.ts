import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.js";

describe("migrateSparkDaemonDatabase", () => {
  it("renames legacy daemon-owned tables before applying the current schema", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE runner_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO runner_meta (key, value, updated_at)
        VALUES ('schema', 'legacy', '2026-06-20T00:00:00.000Z');
      `);

      migrateSparkDaemonDatabase(db);

      expect(tableExists(db, "runner_meta")).toBe(false);
      expect(tableExists(db, "daemon_meta")).toBe(true);
      expect(db.prepare("SELECT value FROM daemon_meta WHERE key = ?").get("schema")).toMatchObject(
        { value: "legacy" },
      );
    } finally {
      db.close();
    }
  });
});

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}
