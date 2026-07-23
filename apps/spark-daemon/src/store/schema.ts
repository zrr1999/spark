import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { openSqliteDatabase, type SparkPaths } from "@zendev-lab/spark-system";

export function openSparkDaemonDatabase(paths: SparkPaths): DatabaseSync {
  const db = openSqliteDatabase(paths.databasePath);
  migrateSparkDaemonDatabase(db);
  return db;
}

export function migrateSparkDaemonDatabase(db: DatabaseSync): void {
  renameLegacySparkDaemonTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invocations (
      id TEXT PRIMARY KEY,
      command_id TEXT,
      workspace_binding_id TEXT,
      session_id TEXT,
      idempotency_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      prompt TEXT,
      task_json TEXT,
      result_json TEXT,
      source_kind TEXT,
      source_ref TEXT,
      retry_of_invocation_id TEXT REFERENCES invocations(id),
      worker_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT,
      error_code TEXT,
      error_message TEXT,
      event_cursor INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invocation_events (
      invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (invocation_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS invocation_event_deliveries (
      destination TEXT NOT NULL,
      invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (destination, invocation_id)
    );

    CREATE TABLE IF NOT EXISTS invocation_event_delivery_consumers (
      destination TEXT PRIMARY KEY,
      registered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_deliveries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('reply', 'ask', 'interaction_ack', 'inbound', 'notification')),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'delivered', 'uncertain')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      claimed_at TEXT,
      dispatched_at TEXT,
      last_error TEXT,
      receipt_json TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qqbot_gateway_cursors (
      workspace_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, adapter_id)
    );

    CREATE TABLE IF NOT EXISTS runtime_command_receipts (
      command_id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('daemon', 'workspace')),
      workspace_binding_id TEXT,
      workspace_id TEXT,
      project_id TEXT,
      session_id TEXT,
      idempotency_key TEXT,
      request_message_id TEXT,
      payload_json TEXT,
      claim_token TEXT,
      lease_expires_at TEXT,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'accepted', 'succeeded', 'failed', 'rejected')),
      delivery_count INTEGER NOT NULL DEFAULT 1,
      ack_json TEXT,
      terminal_message_id TEXT,
      terminal_json TEXT,
      terminal_acked_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daemon_human_waits (
      human_request_id TEXT PRIMARY KEY,
      invocation_id TEXT,
      workspace_binding_id TEXT,
      workspace_id TEXT,
      project_id TEXT,
      tool_call_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT,
      accepted_response_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS invocations_status_idx ON invocations(status, created_at);
    CREATE INDEX IF NOT EXISTS invocation_events_cursor_idx
      ON invocation_events(invocation_id, sequence);
    CREATE INDEX IF NOT EXISTS invocation_event_deliveries_cursor_idx
      ON invocation_event_deliveries(destination, invocation_id, sequence);
    CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox(status, created_at);
    CREATE INDEX IF NOT EXISTS channel_deliveries_due_idx
      ON channel_deliveries(status, next_attempt_at, lease_expires_at, created_at)
      WHERE status IN ('pending', 'retry_wait');
    CREATE TRIGGER IF NOT EXISTS channel_deliveries_idempotency_key_immutable
      BEFORE UPDATE OF idempotency_key ON channel_deliveries
      WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
      BEGIN
        SELECT RAISE(ABORT, 'channel delivery idempotency_key is immutable');
      END;
    CREATE INDEX IF NOT EXISTS runtime_command_receipts_terminal_idx
      ON runtime_command_receipts(terminal_acked_at, completed_at)
      WHERE terminal_json IS NOT NULL;
    CREATE INDEX IF NOT EXISTS daemon_human_waits_status_idx ON daemon_human_waits(status, created_at);
  `);
  migrateChannelDeliverySchema(db);
  addMissingRuntimeCommandReceiptColumns(db);
  addMissingInvocationColumns(db);
  db.exec(`
    INSERT OR IGNORE INTO invocation_event_delivery_consumers (destination, registered_at)
    SELECT DISTINCT destination, MIN(updated_at)
    FROM invocation_event_deliveries
    GROUP BY destination
  `);
  const humanWaitColumns = workspaceColumns(db, "daemon_human_waits");
  if (!humanWaitColumns.has("accepted_response_id")) {
    db.exec("ALTER TABLE daemon_human_waits ADD COLUMN accepted_response_id TEXT");
  }
  retireLegacyDaemonErrorOutbox(db);
  migrateWorkspacesTable(db);
  db.exec("CREATE INDEX IF NOT EXISTS workspaces_status_idx ON workspaces(status)");
  migrateSparkDaemonRegistrationTables(db);
  backfillSparkDaemonRegistrationTables(db);
}

function addMissingRuntimeCommandReceiptColumns(db: DatabaseSync): void {
  const columns = workspaceColumns(db, "runtime_command_receipts");
  for (const [name, type] of [
    ["session_id", "TEXT"],
    ["idempotency_key", "TEXT"],
    ["request_message_id", "TEXT"],
    ["payload_json", "TEXT"],
    ["claim_token", "TEXT"],
    ["lease_expires_at", "TEXT"],
  ] as const) {
    if (!columns.has(name))
      db.exec(`ALTER TABLE runtime_command_receipts ADD COLUMN ${name} ${type}`);
  }
}

function migrateChannelDeliverySchema(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_deliveries'")
    .get() as { sql?: string } | undefined;
  if (
    !row?.sql ||
    (row.sql.includes("'inbound'") &&
      row.sql.includes("'notification'") &&
      row.sql.includes("'uncertain'") &&
      workspaceColumns(db, "channel_deliveries").has("dispatched_at"))
  ) {
    return;
  }

  const columns = workspaceColumns(db, "channel_deliveries");
  const dispatchedAt = columns.has("dispatched_at") ? "dispatched_at" : "NULL";

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP INDEX IF EXISTS channel_deliveries_due_idx;
      DROP TRIGGER IF EXISTS channel_deliveries_idempotency_key_immutable;
      ALTER TABLE channel_deliveries RENAME TO channel_deliveries_legacy;
      CREATE TABLE channel_deliveries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('reply', 'ask', 'interaction_ack', 'inbound', 'notification')),
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'delivered', 'uncertain')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        claimed_at TEXT,
        dispatched_at TEXT,
        last_error TEXT,
        receipt_json TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO channel_deliveries (
        id, kind, idempotency_key, payload_json, status, attempt_count,
        next_attempt_at, lease_owner, lease_token, lease_expires_at, claimed_at, dispatched_at,
        last_error, receipt_json, delivered_at, created_at, updated_at
      )
      SELECT
        id, kind, idempotency_key, payload_json, status, attempt_count,
        next_attempt_at, lease_owner, lease_token, lease_expires_at, claimed_at, ${dispatchedAt},
        last_error, receipt_json, delivered_at, created_at, updated_at
      FROM channel_deliveries_legacy;
      DROP TABLE channel_deliveries_legacy;
      CREATE INDEX channel_deliveries_due_idx
        ON channel_deliveries(status, next_attempt_at, lease_expires_at, created_at)
        WHERE status IN ('pending', 'retry_wait');
      CREATE TRIGGER channel_deliveries_idempotency_key_immutable
        BEFORE UPDATE OF idempotency_key ON channel_deliveries
        WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
        BEGIN
          SELECT RAISE(ABORT, 'channel delivery idempotency_key is immutable');
        END;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * `daemon.error` rows were historically written to the business outbox even
 * though no transport consumed them. A disconnected Cockpit could therefore
 * create one permanent pending row per reconnect attempt. Scrub those rows on
 * every open as well as recording the migration: this remains safe if an old
 * daemon briefly writes again while a newer CLI is stopping/replacing it.
 * Daemon errors now go to process logs while projection connectivity is
 * represented by daemon_servers.
 */
function retireLegacyDaemonErrorOutbox(db: DatabaseSync): void {
  const migrationKey = "migration.retire-daemon-error-outbox-v1";
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM outbox WHERE kind = 'daemon.error'").run();
    db.prepare(
      `INSERT INTO daemon_meta (key, value, updated_at)
       VALUES (?, 'complete', ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    ).run(migrationKey, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function renameLegacySparkDaemonTables(db: DatabaseSync): void {
  for (const [legacy, current] of [
    ["runner_meta", "daemon_meta"],
    ["runner_human_waits", "daemon_human_waits"],
    ["runner_servers", "daemon_servers"],
    ["runner_server_credentials", "daemon_server_credentials"],
    ["runner_workspaces", "daemon_workspaces"],
    ["runner_workspace_grants", "daemon_workspace_grants"],
  ] as const) {
    if (tableExists(db, legacy) && !tableExists(db, current)) {
      db.exec(`ALTER TABLE ${legacy} RENAME TO ${current}`);
    }
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}

function addMissingInvocationColumns(db: DatabaseSync): void {
  const columns = workspaceColumns(db, "invocations");
  const additions = [
    ["session_id", "TEXT"],
    ["idempotency_key", "TEXT"],
    ["task_json", "TEXT"],
    ["result_json", "TEXT"],
    ["source_kind", "TEXT"],
    ["source_ref", "TEXT"],
    ["retry_of_invocation_id", "TEXT REFERENCES invocations(id)"],
    ["worker_id", "TEXT"],
    ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["cancel_reason", "TEXT"],
    ["error_code", "TEXT"],
    ["error_message", "TEXT"],
    ["claimed_at", "TEXT"],
    ["started_at", "TEXT"],
    ["finished_at", "TEXT"],
  ] as const;
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE invocations ADD COLUMN ${name} ${type}`);
  }
  if (!columns.has("event_cursor")) {
    db.exec(`ALTER TABLE invocations ADD COLUMN event_cursor INTEGER NOT NULL DEFAULT 0`);
    // One-time backfill so listSummaryPage can avoid scanning invocation_events.
    db.exec(`
      UPDATE invocations
      SET event_cursor = COALESCE((
        SELECT MAX(sequence)
        FROM invocation_events
        WHERE invocation_events.invocation_id = invocations.id
      ), 0)
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS invocation_events (
      invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (invocation_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS invocations_session_status_idx ON invocations(session_id, status);
    CREATE INDEX IF NOT EXISTS invocations_session_updated_idx
      ON invocations(session_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS invocations_created_at_idx
      ON invocations(created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS invocations_idempotency_idx
      ON invocations(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS invocation_event_delivery_consumers (
      destination TEXT PRIMARY KEY,
      registered_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS invocation_events_cursor_idx
      ON invocation_events(invocation_id, sequence);
  `);
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

function migrateSparkDaemonRegistrationTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_servers (
      id TEXT PRIMARY KEY,
      server_url TEXT NOT NULL UNIQUE,
      first_registered_at TEXT NOT NULL,
      last_connected_at TEXT,
      last_disconnect_reason TEXT,
      protocol_version TEXT
    );

    CREATE TABLE IF NOT EXISTS daemon_server_credentials (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL UNIQUE REFERENCES daemon_servers(id),
      runtime_id TEXT NOT NULL,
      runtime_token_hash TEXT NOT NULL,
      refresh_token_hash TEXT,
      runtime_token_expires_at TEXT,
      refresh_token_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daemon_workspaces (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES daemon_servers(id),
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

    CREATE TABLE IF NOT EXISTS daemon_workspace_grants (
      id TEXT PRIMARY KEY,
      daemon_workspace_id TEXT NOT NULL REFERENCES daemon_workspaces(id),
      grant_token_hash TEXT,
      server_grant_id TEXT,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS daemon_workspace_clients (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('interactive', 'headless', 'executor')),
      display_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
      attached_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      lease_expires_at TEXT,
      released_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS daemon_relocation_audit (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      from_server_url TEXT NOT NULL,
      to_server_url TEXT NOT NULL,
      workspace_count INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded')),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS daemon_workspaces_status_idx
      ON daemon_workspaces(last_known_status);
    CREATE INDEX IF NOT EXISTS daemon_workspace_grants_workspace_idx
      ON daemon_workspace_grants(daemon_workspace_id);
    CREATE INDEX IF NOT EXISTS daemon_workspace_clients_workspace_status_idx
      ON daemon_workspace_clients(workspace_id, status, kind);
    CREATE INDEX IF NOT EXISTS daemon_workspace_clients_lease_idx
      ON daemon_workspace_clients(status, lease_expires_at);
  `);
}

function backfillSparkDaemonRegistrationTables(db: DatabaseSync): void {
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
    const serverId = ensureSparkDaemonServer(db, row.serverUrl, row.createdAt ?? now);
    const offlineReason = offlineReasonFromDiagnostics(row.status, row.diagnosticsJson);
    db.prepare(
      `INSERT OR IGNORE INTO daemon_workspaces
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

function ensureSparkDaemonServer(db: DatabaseSync, serverUrl: string, now: string): string {
  const existing = db
    .prepare("SELECT id FROM daemon_servers WHERE server_url = ? LIMIT 1")
    .get(serverUrl) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }

  const id = `rnsrv_${cryptoRandomId()}`;
  db.prepare(
    `INSERT INTO daemon_servers
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
