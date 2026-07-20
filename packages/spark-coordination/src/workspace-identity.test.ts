import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { createId } from "@zendev-lab/spark-protocol";
import {
  isReservedWorkbenchPathSegment,
  resolveWorkspaceDirectoryDisplayName,
  syncWorkspaceIdentityFromLocalPath,
  workspaceIdentityFromLocalPath,
} from "./workspace-identity.ts";

describe("workspace directory identity", () => {
  it("derives name and slug from the local path basename", () => {
    expect(workspaceIdentityFromLocalPath("/Users/test/workspaces/spark")).toEqual({
      name: "spark",
      slug: "spark",
    });
    expect(
      resolveWorkspaceDirectoryDisplayName({
        localPath: "/Users/test/workspaces/spark",
        displayName: "spore",
      }),
    ).toBe("spark");
    expect(isReservedWorkbenchPathSegment("settings")).toBe(true);
    expect(isReservedWorkbenchPathSegment("login")).toBe(true);
    expect(isReservedWorkbenchPathSegment("daemon")).toBe(true);
  });

  it("syncs workspace name/slug and owner binding display name together", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-20T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    const workspaceId = createId("ws");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, 'install', 'Runtime', 'online', '1', '{}', '{}', ?, ?)`,
    ).run(runtimeId, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, local_path, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'spark', '/Users/test/workspaces/spark', 'old-label', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, description, status, settings_json, created_at, updated_at)
       VALUES (?, 'spore', 'spore', NULL, 'active', '{}', ?, ?)`,
    ).run(workspaceId, now, now);
    db.prepare(
      `INSERT INTO workspace_owner_bindings
        (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
       VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
    ).run(createId("wob"), workspaceId, bindingId, now, now);

    const synced = syncWorkspaceIdentityFromLocalPath(
      db,
      workspaceId,
      "/Users/test/workspaces/spark",
      now,
    );
    expect(synced).toEqual({ name: "spark", slug: "spark" });

    const workspace = db
      .prepare("SELECT slug, name FROM workspaces WHERE id = ?")
      .get(workspaceId) as { slug: string; name: string };
    const binding = db
      .prepare("SELECT display_name AS displayName FROM runtime_workspace_bindings WHERE id = ?")
      .get(bindingId) as { displayName: string };
    expect(workspace).toEqual({ slug: "spark", name: "spark" });
    expect(binding.displayName).toBe("spark");
    db.close();
  });

  it("keeps a reserved slug and only syncs the display name", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-20T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    const workspaceId = createId("ws");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, 'install', 'Runtime', 'online', '1', '{}', '{}', ?, ?)`,
    ).run(runtimeId, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, local_path, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'settings', '/Users/test/workspaces/settings', 'old', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, description, status, settings_json, created_at, updated_at)
       VALUES (?, 'workspace-settings', 'old', NULL, 'active', '{}', ?, ?)`,
    ).run(workspaceId, now, now);
    db.prepare(
      `INSERT INTO workspace_owner_bindings
        (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
       VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
    ).run(createId("wob"), workspaceId, bindingId, now, now);

    const synced = syncWorkspaceIdentityFromLocalPath(
      db,
      workspaceId,
      "/Users/test/workspaces/settings",
      now,
    );
    expect(synced).toEqual({ name: "settings", slug: "workspace-settings" });
    db.close();
  });
});
