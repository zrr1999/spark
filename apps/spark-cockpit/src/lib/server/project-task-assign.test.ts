import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import {
  createProject,
  createWorkspaceWithOwnerBinding,
  queueCommandForWorkspaceOwner,
} from "@zendev-lab/spark-coordination/projection-services";
import { buildProjectTaskAssignCommandPayload } from "./project-task-assign";

describe("project task assign command", () => {
  it("builds an existing task.start command for a ready board task", () => {
    expect(
      buildProjectTaskAssignCommandPayload({
        runtimeTaskId: "task-build",
        name: "build",
        title: "Build",
        description: "Implement the feature",
      }),
    ).toEqual({
      kind: "task.start.request",
      title: "Assign Build",
      payload: {
        runtimeTaskId: "task-build",
        taskName: "build",
        prompt: "Implement the feature",
        source: "project-cockpit-board",
      },
    });
  });

  it("queues assign commands through the daemon command delivery outbox", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-03T00:00:00.000Z";
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
    const project = createProject(db, {
      workspaceId: workspace.id,
      slug: "mvp",
      name: "MVP",
      createdAt: now,
    });

    const command = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      projectId: project.id,
      payload: buildProjectTaskAssignCommandPayload({
        runtimeTaskId: "task-build",
        name: "build",
        title: "Build",
        description: null,
      }),
      createdAt: now,
    });

    const row = db
      .prepare(
        `SELECT c.kind, c.payload_json AS payloadJson, cd.status AS deliveryStatus
         FROM commands c
         JOIN command_deliveries cd ON cd.command_id = c.id
         WHERE c.id = ?`,
      )
      .get(command.id) as { kind: string; payloadJson: string; deliveryStatus: string };
    expect(row.kind).toBe("task.start.request");
    expect(row.deliveryStatus).toBe("pending");
    expect(JSON.parse(row.payloadJson)).toMatchObject({
      kind: "task.start.request",
      payload: { runtimeTaskId: "task-build", source: "project-cockpit-board" },
    });
    db.close();
  });
});
