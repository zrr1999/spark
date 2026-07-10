import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceWithOwnerBinding,
  queueCommandForWorkspaceOwner,
  recordInvocationUpdate,
} from "./projection-services";
import { conversationActivityStatus, loadConversationSummaries } from "./conversation-summaries";

describe("conversation summaries", () => {
  it("rolls internal invocation state up to the visible conversation", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-10T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, 'install', 'Runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local', 'Local', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "local",
      name: "Local",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    const workspaceId = workspace.id;

    const command = queueCommandForWorkspaceOwner(db, {
      workspaceId,
      createdAt: "2026-07-10T00:01:00.000Z",
      payload: {
        kind: "assignment.create.request",
        title: "Improve the UI",
        payload: {
          goal: "Improve the UI",
          target: { sessionId: "sess_visible", workspaceId },
          source: { kind: "cockpit" },
        },
      },
    });
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId: bindingId,
      workspaceId,
      commandId: command.id,
      payload: {
        runtimeInvocationId: "inv_visible",
        status: "running",
        agentName: "spark-runtime",
        payload: {},
      },
    });
    const invocation = db
      .prepare("SELECT updated_at AS updatedAt FROM mirrored_invocations WHERE command_id = ?")
      .get(command.id) as { updatedAt: string };

    const [summary] = loadConversationSummaries(db, [
      {
        sessionId: "sess_visible",
        workspaceId,
        status: "ready",
        bindings: [],
        createdAt: now,
        updatedAt: now,
      },
    ]);

    expect(summary).toMatchObject({
      sessionId: "sess_visible",
      activityStatus: "running",
      activityUpdatedAt: invocation.updatedAt,
    });
  });

  it("keeps a visible session status when newer unrelated commands exceed the old row window", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-10T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, 'install', 'Runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local', 'Local', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "local",
      name: "Local",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });

    const visibleCommand = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      createdAt: "2026-07-10T00:01:00.000Z",
      payload: {
        kind: "assignment.create.request",
        title: "Keep visible status",
        payload: {
          goal: "Keep visible status",
          target: { sessionId: "sess_visible", workspaceId: workspace.id },
          source: { kind: "cockpit" },
        },
      },
    });
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId: bindingId,
      workspaceId: workspace.id,
      commandId: visibleCommand.id,
      payload: {
        runtimeInvocationId: "inv_visible",
        status: "running",
        agentName: "spark-runtime",
        payload: {},
      },
    });

    for (let index = 0; index < 205; index += 1) {
      const createdAt = new Date(
        Date.parse("2026-07-10T01:00:00.000Z") + index * 1_000,
      ).toISOString();
      queueCommandForWorkspaceOwner(db, {
        workspaceId: workspace.id,
        createdAt,
        payload: {
          kind: "assignment.create.request",
          title: `Unrelated ${index}`,
          payload: {
            goal: `Unrelated ${index}`,
            target: { sessionId: `sess_unrelated_${index}`, workspaceId: workspace.id },
            source: { kind: "cockpit" },
          },
        },
      });
    }

    const [summary] = loadConversationSummaries(db, [
      {
        sessionId: "sess_visible",
        workspaceId: workspace.id,
        status: "ready",
        bindings: [],
        createdAt: now,
        updatedAt: now,
      },
    ]);

    expect(summary).toMatchObject({
      sessionId: "sess_visible",
      activityStatus: "running",
    });
  });

  it("normalizes internal states without exposing the task model", () => {
    expect(conversationActivityStatus("needs-input")).toBe("blocked");
    expect(conversationActivityStatus("succeeded")).toBe("completed");
    expect(conversationActivityStatus("acked")).toBe("queued");
    expect(conversationActivityStatus("lost")).toBe("failed");
  });
});
