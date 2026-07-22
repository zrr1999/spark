import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import {
  sweepStaleInvocations,
  sweepStaleRuntimeConnections,
} from "@zendev-lab/spark-cockpit-coordination/liveness";
import {
  createProject,
  createWorkspaceWithOwnerBinding,
} from "@zendev-lab/spark-cockpit-coordination/projection-services";

describe("runtime liveness", () => {
  it("marks stale online runtimes offline and appends an event", () => {
    const db = openMemoryDatabase();
    migrate(db);

    const runtimeId = createId("rt");
    const sessionId = createId("rtsn");
    const freshRuntimeId = createId("rt");
    const now = new Date("2026-05-22T00:01:00.000Z");
    const staleHeartbeat = "2026-05-22T00:00:00.000Z";
    const freshHeartbeat = "2026-05-22T00:00:50.000Z";

    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, 'Stale runtime', 'online', ?, '{}', '{}', ?, ?, ?)`,
    ).run(
      runtimeId,
      "stale-install",
      runtimeProtocolVersion,
      staleHeartbeat,
      staleHeartbeat,
      staleHeartbeat,
    );
    db.prepare(
      `INSERT INTO runtime_sessions
        (id, runtime_id, transport, status, connected_at, last_seen_at)
       VALUES (?, ?, 'websocket', 'connected', ?, ?)`,
    ).run(sessionId, runtimeId, staleHeartbeat, staleHeartbeat);

    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, 'Fresh runtime', 'online', ?, '{}', '{}', ?, ?, ?)`,
    ).run(
      freshRuntimeId,
      "fresh-install",
      runtimeProtocolVersion,
      freshHeartbeat,
      freshHeartbeat,
      freshHeartbeat,
    );

    const result = sweepStaleRuntimeConnections(db, { now });

    const staleRuntime = db
      .prepare("SELECT status FROM runtime_connections WHERE id = ?")
      .get(runtimeId) as { status: string };
    const freshRuntime = db
      .prepare("SELECT status FROM runtime_connections WHERE id = ?")
      .get(freshRuntimeId) as { status: string };
    const session = db
      .prepare("SELECT status FROM runtime_sessions WHERE id = ?")
      .get(sessionId) as {
      status: string;
    };
    const event = db
      .prepare("SELECT kind, subject_id AS subjectId FROM events WHERE subject_id = ?")
      .get(runtimeId) as { kind: string; subjectId: string };

    expect(result).toEqual({ staleRuntimeIds: [runtimeId], staleSessionCount: 1 });
    expect(staleRuntime.status).toBe("offline");
    expect(freshRuntime.status).toBe("online");
    expect(session.status).toBe("stale");
    expect(event).toEqual({ kind: "runtime.offline", subjectId: runtimeId });
    db.close();
  });

  it("marks absolute-stale running invocations as lost", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = new Date("2026-05-22T01:00:00.000Z");
    const createdAt = "2026-05-22T00:00:00.000Z";
    const staleUpdatedAt = "2026-05-22T00:20:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    const invocationId = createId("inv");
    const runtimeInvocationId = "inv_stale";

    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, 'Online runtime', 'online', ?, '{}', '{}', ?, ?, ?)`,
    ).run(
      runtimeId,
      "install-stale-inv",
      runtimeProtocolVersion,
      now.toISOString(),
      createdAt,
      createdAt,
    );
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local-default', 'Local default', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, createdAt, createdAt);

    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId: bindingId,
      createdAt,
    });
    const project = createProject(db, {
      workspaceId: workspace.id,
      slug: "mvp",
      name: "MVP",
      createdAt,
    });

    db.prepare(
      `INSERT INTO mirrored_invocations
        (id, workspace_id, project_id, runtime_workspace_binding_id, runtime_invocation_id, task_runtime_id, agent_name, status, started_at, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'task-1', 'Spark', 'running', ?, '{}', ?, ?)`,
    ).run(
      invocationId,
      workspace.id,
      project.id,
      bindingId,
      runtimeInvocationId,
      staleUpdatedAt,
      createdAt,
      staleUpdatedAt,
    );

    const result = sweepStaleInvocations(db, { now, staleAfterMs: 35 * 60_000 });
    const row = db
      .prepare(
        "SELECT status, terminal_reason AS terminalReason FROM mirrored_invocations WHERE id = ?",
      )
      .get(invocationId) as { status: string; terminalReason: string | null };
    const event = db
      .prepare(
        "SELECT kind, payload_json AS payloadJson FROM events WHERE kind = 'invocation.updated' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { kind: string; payloadJson: string };

    expect(result.lostInvocationIds).toEqual([invocationId]);
    expect(row).toEqual({ status: "lost", terminalReason: "invocation_projection_stale" });
    expect(JSON.parse(event.payloadJson)).toMatchObject({
      runtimeInvocationId,
      status: "lost",
      terminalReason: "invocation_projection_stale",
    });
    db.close();
  });

  it("marks offline-runtime running invocations lost sooner", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = new Date("2026-05-22T00:05:00.000Z");
    const createdAt = "2026-05-22T00:00:00.000Z";
    const updatedAt = "2026-05-22T00:02:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    const invocationId = createId("inv");

    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, 'Offline runtime', 'offline', ?, '{}', '{}', ?, ?, ?)`,
    ).run(
      runtimeId,
      "install-offline-inv",
      runtimeProtocolVersion,
      createdAt,
      createdAt,
      createdAt,
    );
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local-default', 'Local default', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, createdAt, createdAt);

    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId: bindingId,
      createdAt,
    });
    const project = createProject(db, {
      workspaceId: workspace.id,
      slug: "mvp",
      name: "MVP",
      createdAt,
    });

    db.prepare(
      `INSERT INTO mirrored_invocations
        (id, workspace_id, project_id, runtime_workspace_binding_id, runtime_invocation_id, task_runtime_id, agent_name, status, started_at, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'inv_offline', 'task-1', 'Spark', 'running', ?, '{}', ?, ?)`,
    ).run(invocationId, workspace.id, project.id, bindingId, updatedAt, createdAt, updatedAt);

    const result = sweepStaleInvocations(db, {
      now,
      staleAfterMs: 35 * 60_000,
      offlineStaleAfterMs: 2 * 60_000,
    });
    const row = db
      .prepare(
        "SELECT status, terminal_reason AS terminalReason FROM mirrored_invocations WHERE id = ?",
      )
      .get(invocationId) as { status: string; terminalReason: string | null };

    expect(result.lostInvocationIds).toEqual([invocationId]);
    expect(row).toEqual({ status: "lost", terminalReason: "runtime_offline_stale" });
    db.close();
  });
});
