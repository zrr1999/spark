import { describe, expect, it } from "vitest";
import { openMemoryDatabase } from "./client.js";
import { migrate } from "./migrate.js";

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
      "runtime_message_receipts_runtime_seen_idx",
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
    ]);
    db.close();
  });

  it("is idempotent after all migrations have been recorded", () => {
    const db = openMemoryDatabase();

    migrate(db);
    migrate(db);

    const migrationCount = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
      count: number;
    };

    expect(migrationCount.count).toBe(7);
    db.close();
  });
});
