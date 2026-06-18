import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { openDatabase } from "@navia-dev/db";
import type { NaviaPaths } from "@navia-dev/system";

export function openRunnerDatabase(paths: NaviaPaths): DatabaseSync {
  const db = openDatabase({ path: paths.databasePath });
  migrateRunnerDatabase(db);
  return db;
}

export function migrateRunnerDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invocations (
      id TEXT PRIMARY KEY,
      command_id TEXT,
      workspace_binding_id TEXT,
      status TEXT NOT NULL,
      prompt TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS invocations_status_idx ON invocations(status);
    CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox(status, created_at);
  `);
  migrateWorkspacesTable(db);
  db.exec("CREATE INDEX IF NOT EXISTS workspaces_status_idx ON workspaces(status)");
  migrateRunnerRegistrationTables(db);
  backfillRunnerRegistrationTables(db);
}

function migrateWorkspacesTable(db: DatabaseSync): void {
  const columns = workspaceColumns(db, "workspaces");
  if (columns.size === 0) {
    createWorkspacesTable(db);
    return;
  }

  if (columns.has("server_url")) {
    addMissingWorkspaceProfileColumns(db, columns);
    return;
  }

  db.exec("ALTER TABLE workspaces RENAME TO workspaces_legacy");
  createWorkspacesTable(db);
  db.exec(`
    INSERT OR IGNORE INTO workspaces
      (id, server_url, local_workspace_key, display_name, local_path, status, capabilities_json, diagnostics_json, created_at, updated_at)
    SELECT
      id,
      '',
      local_workspace_key,
      display_name,
      local_path,
      status,
      capabilities_json,
      diagnostics_json,
      created_at,
      updated_at
    FROM workspaces_legacy;

    DROP TABLE workspaces_legacy;
  `);
}

function createWorkspacesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      server_url TEXT NOT NULL DEFAULT '',
      local_workspace_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      status TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      diagnostics_json TEXT NOT NULL DEFAULT '{}',
      profile_source_kind TEXT,
      profile_ref TEXT,
      profile_commit TEXT,
      profile_imported_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (server_url, local_workspace_key),
      UNIQUE (server_url, local_path)
    )
  `);
}

function migrateRunnerRegistrationTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_servers (
      id TEXT PRIMARY KEY,
      server_url TEXT NOT NULL UNIQUE,
      first_registered_at TEXT NOT NULL,
      last_connected_at TEXT,
      last_disconnect_reason TEXT,
      protocol_version TEXT
    );

    CREATE TABLE IF NOT EXISTS runner_server_credentials (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL UNIQUE REFERENCES runner_servers(id),
      runtime_id TEXT NOT NULL,
      runtime_token_hash TEXT NOT NULL,
      refresh_token_hash TEXT,
      runtime_token_expires_at TEXT,
      refresh_token_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runner_workspaces (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES runner_servers(id),
      server_workspace_id TEXT,
      server_binding_id TEXT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      local_path TEXT NOT NULL,
      profile_source_kind TEXT,
      profile_ref TEXT,
      profile_commit TEXT,
      registered_at TEXT NOT NULL,
      last_known_status TEXT NOT NULL,
      last_known_offline_reason TEXT,
      last_status_changed_at TEXT NOT NULL,
      UNIQUE (server_id, local_path),
      UNIQUE (server_id, slug)
    );

    CREATE TABLE IF NOT EXISTS runner_workspace_grants (
      id TEXT PRIMARY KEY,
      runner_workspace_id TEXT NOT NULL REFERENCES runner_workspaces(id),
      grant_token_hash TEXT,
      server_grant_id TEXT,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS runner_workspaces_status_idx
      ON runner_workspaces(last_known_status);
    CREATE INDEX IF NOT EXISTS runner_workspace_grants_workspace_idx
      ON runner_workspace_grants(runner_workspace_id);
  `);
}

function backfillRunnerRegistrationTables(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT id,
              server_url AS serverUrl,
              local_workspace_key AS localWorkspaceKey,
              display_name AS displayName,
              local_path AS localPath,
              status,
              diagnostics_json AS diagnosticsJson,
              profile_source_kind AS profileSourceKind,
              profile_ref AS profileRef,
              profile_commit AS profileCommit,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM workspaces`,
    )
    .all() as Array<{
    id: string;
    serverUrl: string;
    localWorkspaceKey: string;
    displayName: string;
    localPath: string;
    status: string;
    diagnosticsJson: string;
    profileSourceKind: string | null;
    profileRef: string | null;
    profileCommit: string | null;
    createdAt: string;
    updatedAt: string;
  }>;

  for (const row of rows) {
    const serverId = ensureRunnerServer(db, row.serverUrl, row.createdAt ?? now);
    const offlineReason = offlineReasonFromDiagnostics(row.status, row.diagnosticsJson);
    db.prepare(
      `INSERT OR IGNORE INTO runner_workspaces
        (id, server_id, server_workspace_id, server_binding_id, name, slug, local_path, profile_source_kind, profile_ref, profile_commit, registered_at, last_known_status, last_known_offline_reason, last_status_changed_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      serverId,
      row.id,
      row.displayName,
      row.localWorkspaceKey,
      row.localPath,
      row.profileSourceKind,
      row.profileRef,
      row.profileCommit,
      row.createdAt ?? now,
      row.status,
      offlineReason,
      row.updatedAt ?? now,
    );
  }
}

function ensureRunnerServer(db: DatabaseSync, serverUrl: string, now: string): string {
  const existing = db
    .prepare("SELECT id FROM runner_servers WHERE server_url = ? LIMIT 1")
    .get(serverUrl) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }

  const id = `rnsrv_${cryptoRandomId()}`;
  db.prepare(
    `INSERT INTO runner_servers
      (id, server_url, first_registered_at)
     VALUES (?, ?, ?)`,
  ).run(id, serverUrl, now);
  return id;
}

function offlineReasonFromDiagnostics(status: string, diagnosticsJson: string): string | null {
  if (status === "available") {
    return null;
  }

  try {
    const diagnostics = JSON.parse(diagnosticsJson) as Record<string, unknown>;
    if (diagnostics.userDetached === true) {
      return "user-detached";
    }
    if (diagnostics.pathMissing === true) {
      return "path-missing";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

function cryptoRandomId(): string {
  return randomUUID().replaceAll("-", "");
}

function addMissingWorkspaceProfileColumns(db: DatabaseSync, columns: Set<string>): void {
  const profileColumns: Array<[name: string, definition: string]> = [
    ["profile_source_kind", "profile_source_kind TEXT"],
    ["profile_ref", "profile_ref TEXT"],
    ["profile_commit", "profile_commit TEXT"],
    ["profile_imported_at", "profile_imported_at TEXT"],
  ];

  for (const [name, definition] of profileColumns) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE workspaces ADD COLUMN ${definition}`);
    }
  }
}

function workspaceColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}
