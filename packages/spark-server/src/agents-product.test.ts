import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { agentsCockpitSource, loadAgentsProductProjection } from "./agents-product";
import { submitServerCommand } from "./command-submission";
import {
  createWorkspaceWithOwnerBinding,
  recordArtifactProjection,
  recordInvocationUpdate,
} from "./projection-services";

function setupAgentWorkspace() {
  const db = openMemoryDatabase();
  migrate(db);
  const now = "2026-05-22T00:00:00.000Z";
  const runtimeId = createId("rt");
  const runtimeWorkspaceBindingId = createId("rtwb");

  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, ?, 'online', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, "install-agent", "Agent runtime", runtimeProtocolVersion, now, now);

  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'agent-workspace', 'Agent workspace', 'available', '{}', '{}', ?, ?)`,
  ).run(runtimeWorkspaceBindingId, runtimeId, now, now);

  const workspace = createWorkspaceWithOwnerBinding(db, {
    name: "Agent Workspace",
    slug: "agent-workspace",
    runtimeWorkspaceBindingId,
  });
  return { db, workspace, runtimeWorkspaceBindingId };
}

describe("agents product projection", () => {
  it("recovers assistant output from server-side artifact preview cache", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupAgentWorkspace();
    const command = submitServerCommand(db, {
      workspaceId: workspace.id,
      projectId: null,
      payload: {
        kind: "task.start.request",
        title: "Recover agent output",
        payload: { source: agentsCockpitSource, prompt: "recover" },
      },
    });
    const runtimeInvocationId = createId("inv");
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      payload: {
        runtimeInvocationId,
        status: "succeeded",
        agentName: "spark-runtime",
        payload: {},
      },
    });
    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      invocationId: runtimeInvocationId,
      payload: {
        artifactId: "agent-output-artifact",
        scope: "workspace",
        kind: "record",
        title: "Recovered output",
        format: "text",
        source: "runtime",
        contentRef: { text: "Recovered assistant text" },
        provenance: { producer: "task" },
        links: [],
      },
    });

    const projection = loadAgentsProductProjection(db, workspace.id);
    expect(projection.logChunks).toEqual([
      expect.objectContaining({
        id: "artifact-fallback-agent-output-artifact",
        runtimeInvocationId,
        stream: "assistant",
        content: "Recovered assistant text",
      }),
    ]);
  });
});
