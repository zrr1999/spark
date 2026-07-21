import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { createWorkspaceWithOwnerBinding } from "./projection-services";
import { queueWorkspaceOccupancyCommand, workspaceExists } from "./workspace-occupancy";

describe("workspace occupancy commands", () => {
  it("queues attach/heartbeat/release as runtime server commands", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-05-26T00:00:00.000Z";
    const runtimeId = createId("rt");
    const runtimeWorkspaceBindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, ?, ?, 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, "install-test", "Test runtime", runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local-default', 'Local default', 'available', '{}', '{}', ?, ?)`,
    ).run(runtimeWorkspaceBindingId, runtimeId, now, now);

    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });

    expect(workspaceExists(db, workspace.id)).toBe(true);

    const attached = queueWorkspaceOccupancyCommand(db, {
      workspaceId: workspace.id,
      action: "attach",
      clientId: "wcl_cockpit_test",
      sessionId: "wcl_cockpit_test",
    });
    expect(attached.id).toMatch(/^cmd_/);
    expect(
      db
        .prepare("SELECT kind, payload_json AS payloadJson FROM commands WHERE id = ?")
        .get(attached.id),
    ).toMatchObject({
      kind: "workspace.client.attach.request",
      payloadJson: expect.stringContaining("wcl_cockpit_test"),
    });

    const heartbeat = queueWorkspaceOccupancyCommand(db, {
      workspaceId: workspace.id,
      action: "heartbeat",
      clientId: "wcl_cockpit_test",
    });
    expect(db.prepare("SELECT kind FROM commands WHERE id = ?").get(heartbeat.id)).toMatchObject({
      kind: "workspace.client.heartbeat.request",
    });

    const released = queueWorkspaceOccupancyCommand(db, {
      workspaceId: workspace.id,
      action: "release",
      clientId: "wcl_cockpit_test",
    });
    expect(db.prepare("SELECT kind FROM commands WHERE id = ?").get(released.id)).toMatchObject({
      kind: "workspace.client.release.request",
    });

    db.close();
  });
});
