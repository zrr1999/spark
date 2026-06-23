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

  it("migrates pre-registration workspace rows into daemon-owned workspace projections", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          local_workspace_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          local_path TEXT NOT NULL,
          status TEXT NOT NULL,
          capabilities_json TEXT NOT NULL DEFAULT '{}',
          diagnostics_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (local_workspace_key),
          UNIQUE (local_path)
        );
        INSERT INTO workspaces
          (id, local_workspace_key, display_name, local_path, status, capabilities_json, diagnostics_json, created_at, updated_at)
        VALUES
          ('rtwb_legacy_available', 'workspace-a', 'Workspace A', '/tmp/workspace-a', 'available', '{}', '{}', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
          ('rtwb_legacy_detached', 'workspace-b', 'Workspace B', '/tmp/workspace-b', 'unavailable', '{}', '{"userDetached":true}', '2026-06-02T00:00:00.000Z', '2026-06-03T00:00:00.000Z');
      `);

      migrateSparkDaemonDatabase(db);

      expect(workspaceColumns(db, "workspaces")).toEqual(
        expect.arrayContaining(["server_url", "profile_source_kind", "profile_imported_at"]),
      );
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE server_url = ''").get(),
      ).toMatchObject({ count: 2 });
      expect(
        db
          .prepare(
            `SELECT rw.name,
                    rw.slug,
                    rw.local_path AS localPath,
                    rw.last_known_status AS lastKnownStatus,
                    rw.last_known_offline_reason AS lastKnownOfflineReason,
                    rs.server_url AS serverUrl
             FROM daemon_workspaces rw
             JOIN daemon_servers rs ON rs.id = rw.server_id
             ORDER BY rw.id`,
          )
          .all(),
      ).toEqual([
        {
          name: "Workspace A",
          slug: "workspace-a",
          localPath: "/tmp/workspace-a",
          lastKnownStatus: "available",
          lastKnownOfflineReason: null,
          serverUrl: "",
        },
        {
          name: "Workspace B",
          slug: "workspace-b",
          localPath: "/tmp/workspace-b",
          lastKnownStatus: "unavailable",
          lastKnownOfflineReason: "user-detached",
          serverUrl: "",
        },
      ]);
      expect(tableExists(db, "daemon_workspace_clients")).toBe(true);
    } finally {
      db.close();
    }
  });
});

function workspaceColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}
