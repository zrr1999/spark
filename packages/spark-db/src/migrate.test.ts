import { describe, expect, it } from "vitest";
import { openMemoryDatabase } from "./client.js";
import { loadMigrations, migrate } from "./migrate.js";

function tableExists(db: ReturnType<typeof openMemoryDatabase>, table: string) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
}

function indexExists(db: ReturnType<typeof openMemoryDatabase>, index: string) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index) as { name: string } | undefined;
}

describe("migrations", () => {
  it("applies the MVP projection schema to an empty database", () => {
    const db = openMemoryDatabase();

    migrate(db);

    for (const table of [
      "workspaces",
      "projects",
      "resources",
      "agent_specs",
      "commands",
      "command_deliveries",
      "human_requests",
      "human_responses",
      "inbox_items",
      "asks",
      "reviews",
      "task_graph_snapshots",
      "task_graph_clusters",
      "task_graph_tasks",
      "task_graph_dependencies",
      "mirrored_invocations",
      "invocation_events",
      "invocation_log_chunks",
      "artifacts",
      "artifact_links",
      "artifact_cache_blobs",
      "workspace_profile_sources",
      "workspace_profile_git_access",
      "runtime_enrollment_tokens",
      "runtime_device_authorizations",
      "runtime_message_receipts",
    ]) {
      expect(tableExists(db, table)?.name).toBe(table);
    }

    for (const index of [
      "projects_workspace_status_idx",
      "commands_workspace_status_idx",
      "human_requests_workspace_status_idx",
      "inbox_items_workspace_status_idx",
      "task_graph_snapshots_project_version_idx",
      "mirrored_invocations_workspace_status_idx",
      "artifacts_workspace_kind_idx",
      "artifact_cache_blobs_eviction_idx",
      "workspace_profile_sources_profile_idx",
      "runtime_enrollment_tokens_state_idx",
      "runtime_enrollment_tokens_workspace_idx",
      "runtime_device_authorizations_state_idx",
      "runtime_device_authorizations_installation_pending_idx",
      "runtime_message_receipts_runtime_seen_idx",
      "events_created_id_idx",
    ]) {
      expect(indexExists(db, index)?.name).toBe(index);
    }

    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: string }>;

    expect(versions.map((migration) => migration.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
    ]);

    const bindingColumns = db
      .prepare("PRAGMA table_info(runtime_workspace_bindings)")
      .all() as Array<{
      name: string;
    }>;
    expect(bindingColumns.map((column) => column.name)).toContain("local_path");
    db.close();
  });

  it("is idempotent after all migrations have been recorded", () => {
    const db = openMemoryDatabase();

    migrate(db);
    migrate(db);

    const migrationCount = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
      count: number;
    };

    expect(migrationCount.count).toBe(11);
    db.close();
  });

  it("keeps existing runtime workspace bindings when adding local paths", () => {
    const db = openMemoryDatabase();
    const migrations = loadMigrations();
    migrate(
      db,
      migrations.filter((migration) => migration.version <= "0008"),
    );
    const now = "2026-07-14T00:00:00.000Z";
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, capabilities_json, labels_json, created_at, updated_at)
       VALUES ('rt_legacy', 'install-legacy', 'Legacy daemon', 'offline', '{}', '{}', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES ('rtwb_legacy', 'rt_legacy', 'legacy', 'Legacy workspace', 'available', '{}', '{}', ?, ?)`,
    ).run(now, now);

    migrate(db, migrations);

    const binding = db
      .prepare("SELECT local_path AS localPath FROM runtime_workspace_bindings WHERE id = ?")
      .get("rtwb_legacy") as { localPath: string | null };
    expect(binding.localPath).toBeNull();
    db.close();
  });

  it("does not broaden credentials issued before device authorization existed", () => {
    const db = openMemoryDatabase();
    const migrations = loadMigrations();
    migrate(
      db,
      migrations.filter((migration) => migration.version <= "0007"),
    );
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, capabilities_json, labels_json, created_at, updated_at)
       VALUES ('rt_legacy', 'install-legacy', 'Legacy daemon', 'offline', '{}', '{}', ?, ?)`,
    ).run("2026-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z");
    const insertToken = db.prepare(
      `INSERT INTO runtime_tokens
        (id, runtime_id, token_hash, label, scopes_json, created_at)
       VALUES (?, 'rt_legacy', ?, ?, ?, ?)`,
    );
    insertToken.run(
      "rttok_access",
      "hash-access",
      "runtime access token",
      '["runtime:connect"]',
      "2026-07-13T00:00:00.000Z",
    );
    insertToken.run(
      "rttok_refresh",
      "hash-refresh",
      "runtime refresh token",
      '["runtime:refresh"]',
      "2026-07-13T00:00:00.000Z",
    );
    insertToken.run(
      "rttok_custom",
      "hash-custom",
      "custom token",
      '["runtime:connect","custom:scope"]',
      "2026-07-13T00:00:00.000Z",
    );

    migrate(db, migrations);

    const scopes = db
      .prepare("SELECT id, scopes_json AS scopesJson FROM runtime_tokens ORDER BY id")
      .all() as Array<{ id: string; scopesJson: string }>;
    expect(scopes).toEqual([
      { id: "rttok_access", scopesJson: '["runtime:connect"]' },
      { id: "rttok_custom", scopesJson: '["runtime:connect","custom:scope"]' },
      { id: "rttok_refresh", scopesJson: '["runtime:refresh"]' },
    ]);
    db.close();
  });
});
