import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import { describe, expect, it } from "vitest";

import { requireWorkspaceByRouteId } from "./workspace-routing";

describe("workspace route lookup", () => {
  it("resolves active workspaces and rejects unknown or archived workspaces", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-20T00:00:00.000Z";
    db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, description, status, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, '{}', ?, ?)`,
    ).run("ws_active", "active", "Active", "active", now, now);
    db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, description, status, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, '{}', ?, ?)`,
    ).run("ws_archived", "archived", "Archived", "archived", now, now);

    try {
      expect(requireWorkspaceByRouteId(db, "active")).toMatchObject({ id: "ws_active" });
      expect(() => requireWorkspaceByRouteId(db, "missing")).toThrow(
        expect.objectContaining({ status: 404 }),
      );
      expect(() => requireWorkspaceByRouteId(db, "archived")).toThrow(
        expect.objectContaining({ status: 404 }),
      );
    } finally {
      db.close();
    }
  });
});
