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

  it("retires permanent daemon error rows without deleting other outbox work", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
        VALUES
          ('evt_error_1', 'daemon.error', '{}', 'pending', '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z'),
          ('evt_error_2', 'daemon.error', '{}', 'pending', '2026-06-20T00:00:01.000Z', '2026-06-20T00:00:01.000Z'),
          ('evt_projection', 'projection.example', '{}', 'pending', '2026-06-20T00:00:02.000Z', '2026-06-20T00:00:02.000Z');
      `);

      migrateSparkDaemonDatabase(db);
      db.prepare(
        `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
         VALUES ('evt_error_late', 'daemon.error', '{}', 'pending', '2026-06-20T00:00:03.000Z', '2026-06-20T00:00:03.000Z')`,
      ).run();
      migrateSparkDaemonDatabase(db);

      expect(db.prepare("SELECT id, kind FROM outbox ORDER BY id").all()).toEqual([
        { id: "evt_projection", kind: "projection.example" },
      ]);
      expect(
        db
          .prepare("SELECT value FROM daemon_meta WHERE key = ?")
          .get("migration.retire-daemon-error-outbox-v1"),
      ).toEqual({ value: "complete" });
    } finally {
      db.close();
    }
  });

  it("creates the durable invocation lifecycle schema and indexes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      expect(tableExists(db, "invocations")).toBe(true);
      expect(tableExists(db, "invocation_events")).toBe(true);
      expect(tableExists(db, "invocation_event_deliveries")).toBe(true);
      expect(tableExists(db, "runtime_command_receipts")).toBe(true);
      expect(columnNames(db, "runtime_command_receipts")).toEqual(
        expect.arrayContaining([
          "command_id",
          "payload_hash",
          "delivery_count",
          "ack_json",
          "terminal_message_id",
          "terminal_json",
          "terminal_acked_at",
        ]),
      );
      expect(columnNames(db, "invocations")).toEqual(
        expect.arrayContaining([
          "session_id",
          "idempotency_key",
          "retry_of_invocation_id",
          "worker_id",
          "cancel_reason",
          "error_code",
          "error_message",
          "claimed_at",
          "started_at",
          "finished_at",
        ]),
      );
      expect(indexNames(db, "invocations")).toEqual(
        expect.arrayContaining([
          "invocations_status_idx",
          "invocations_session_status_idx",
          "invocations_session_updated_idx",
        ]),
      );
      expect(indexNames(db, "invocation_events")).toContain("invocation_events_cursor_idx");
      expect(indexNames(db, "invocation_event_deliveries")).toContain(
        "invocation_event_deliveries_cursor_idx",
      );
      expect(indexNames(db, "runtime_command_receipts")).toContain(
        "runtime_command_receipts_terminal_idx",
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

function columnNames(db: DatabaseSync, table: string): string[] {
  return workspaceColumns(db, table);
}

function indexNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(
    (index) => index.name,
  );
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}
