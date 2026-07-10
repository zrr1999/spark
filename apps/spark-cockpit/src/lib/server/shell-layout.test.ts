import type { DatabaseSync } from "node:sqlite";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { createWorkspaceWithOwnerBinding } from "@zendev-lab/spark-server/projection-services";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDatabase: vi.fn() }));

vi.mock("$lib/server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("$lib/server/active-workspace", () => ({
  activeWorkspaceCookieName: "spark_cockpit_active_workspace",
}));

import { loadShellWorkspaceLayout } from "./shell-layout";

describe("shell workspace layout", () => {
  it("lets the selected conversation workspace override a stale workspace cookie", () => {
    const db = openMemoryDatabase();
    migrate(db);
    createWorkspace(db, "first", "2026-07-10T00:00:00.000Z");
    const second = createWorkspace(db, "second", "2026-07-10T00:01:00.000Z");
    mocks.getDatabase.mockReturnValue(db);
    const set = vi.fn();

    const layout = loadShellWorkspaceLayout({
      cookies: {
        get: () => "first",
        set,
        delete: vi.fn(),
      } as never,
      pathname: "/sessions/sess_second",
      protocol: "http:",
      preferredWorkspaceId: second.id,
    });

    expect(layout.activeWorkspace?.id).toBe(second.id);
    expect(set).toHaveBeenCalledWith(
      "spark_cockpit_active_workspace",
      "second",
      expect.objectContaining({ path: "/", httpOnly: true }),
    );
    db.close();
  });
});

function createWorkspace(db: DatabaseSync, slug: string, createdAt: string) {
  const runtimeId = createId("rt");
  const bindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, ?, 'online', ?, '{}', '{}', ?, ?)`,
  ).run(
    runtimeId,
    `install-${slug}`,
    `Runtime ${slug}`,
    runtimeProtocolVersion,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'available', '{}', '{}', ?, ?)`,
  ).run(bindingId, runtimeId, `local-${slug}`, slug, createdAt, createdAt);
  return createWorkspaceWithOwnerBinding(db, {
    slug,
    name: slug,
    runtimeWorkspaceBindingId: bindingId,
    createdAt,
  });
}
