import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/navia-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/navia-db";
import {
  createProject,
  createWorkspaceWithOwnerBinding,
  ingestTaskGraphSnapshot,
  queueCommandForWorkspaceOwner,
  recordArtifactProjection,
  recordHumanRequestFromRuntime,
  recordHumanResponse,
} from "./projection-services";

function setupRuntimeBinding() {
  const db = openMemoryDatabase();
  migrate(db);

  const now = "2026-05-22T00:00:00.000Z";
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

  return { db, runtimeId, runtimeWorkspaceBindingId, now };
}

describe("projection services", () => {
  it("creates a workspace, binds its runtime owner, creates a project, and queues a command", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();

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
      idempotencyKey: createId("idem"),
      payload: {
        kind: "task.start.request",
        title: "Start MVP task",
      },
      createdAt: now,
    });

    const owner = db
      .prepare(
        "SELECT runtime_workspace_binding_id AS bindingId FROM workspace_owner_bindings WHERE workspace_id = ?",
      )
      .get(workspace.id) as { bindingId: string };
    expect(owner.bindingId).toBe(runtimeWorkspaceBindingId);

    const projectRow = db
      .prepare("SELECT metadata_json AS metadataJson FROM projects WHERE id = ?")
      .get(project.id) as { metadataJson: string };
    const delivery = db
      .prepare("SELECT status FROM command_deliveries WHERE command_id = ?")
      .get(command.id) as { status: string };
    expect(JSON.parse(projectRow.metadataJson)).toMatchObject({
      sourceOfTruth: "navia-cockpit-routing",
    });
    expect(delivery.status).toBe("pending");

    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM events").get() as {
      count: number;
    };
    expect(eventCount.count).toBe(3);
    db.close();
  });

  it("finalizes an existing registered workspace instead of inserting a duplicate slug", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspaceId = createId("ws");
    const ownerBindingId = createId("wob");
    db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, description, status, settings_json, created_at, updated_at)
       VALUES (?, 'local-default', 'Pending local', NULL, 'active', '{}', ?, ?)`,
    ).run(workspaceId, now, now);
    db.prepare(
      `INSERT INTO workspace_owner_bindings
        (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
       VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
    ).run(ownerBindingId, workspaceId, runtimeWorkspaceBindingId, now, now);

    const input = {
      slug: "local-default",
      name: "Local default",
      description: "Ready for work",
      settings: { profileInputs: { workspaceSlug: "local-default" } },
      profileSource: {
        sourceKind: "builtin" as const,
        profileId: "fresh",
        profileName: "Fresh workspace",
        schemaVersion: "1",
      },
      agentSpecs: [
        {
          name: "Planner",
          source: "builtin" as const,
          status: "active" as const,
        },
      ],
      resources: [
        {
          kind: "repo" as const,
          name: "Local checkout",
          uri: "file:///tmp/local-default",
          status: "available" as const,
        },
      ],
      runtimeWorkspaceBindingId,
      createdAt: "2026-05-22T00:01:00.000Z",
    };
    const finalized = createWorkspaceWithOwnerBinding(db, input);
    const finalizedAgain = createWorkspaceWithOwnerBinding(db, input);

    const workspaceCount = db.prepare("SELECT COUNT(*) AS count FROM workspaces").get() as {
      count: number;
    };
    const workspace = db
      .prepare(
        `SELECT name,
                description,
                settings_json AS settingsJson
         FROM workspaces
         WHERE id = ?`,
      )
      .get(workspaceId) as {
      name: string;
      description: string | null;
      settingsJson: string;
    };
    const activeOwnerCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM workspace_owner_bindings
         WHERE workspace_id = ? AND ended_at IS NULL`,
      )
      .get(workspaceId) as { count: number };
    const profileCount = db
      .prepare("SELECT COUNT(*) AS count FROM workspace_profile_sources WHERE workspace_id = ?")
      .get(workspaceId) as { count: number };
    const agentCount = db
      .prepare("SELECT COUNT(*) AS count FROM agent_specs WHERE workspace_id = ?")
      .get(workspaceId) as { count: number };
    const resourceCount = db
      .prepare("SELECT COUNT(*) AS count FROM resources WHERE workspace_id = ?")
      .get(workspaceId) as { count: number };

    expect(finalized.id).toBe(workspaceId);
    expect(finalized.ownerBindingId).toBe(ownerBindingId);
    expect(finalizedAgain.id).toBe(workspaceId);
    expect(workspaceCount.count).toBe(1);
    expect(workspace).toMatchObject({
      name: "Local default",
      description: "Ready for work",
    });
    expect(JSON.parse(workspace.settingsJson)).toEqual({
      profileInputs: { workspaceSlug: "local-default" },
    });
    expect(activeOwnerCount.count).toBe(1);
    expect(profileCount.count).toBe(1);
    expect(agentCount.count).toBe(1);
    expect(resourceCount.count).toBe(1);
    db.close();
  });

  it("records runtime-originated human requests and user responses", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });

    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "tool-call-1",
      payload: {
        kind: "ask_user",
        title: "Choose scope",
        prompt: "Which scope should Navia apply?",
        questions: [
          {
            id: "scope",
            type: "single",
            prompt: "Scope?",
            required: true,
            options: [{ id: "mvp", label: "MVP", description: "Proceed to MVP." }],
          },
        ],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });

    const inbox = db
      .prepare("SELECT status, kind FROM inbox_items WHERE human_request_id = ?")
      .get(request.humanRequestId) as { status: string; kind: string };
    expect(inbox).toEqual({ status: "pending", kind: "ask" });

    const response = recordHumanResponse(db, {
      humanRequestId: request.humanRequestId,
      payload: {
        status: "answered",
        answers: { scope: "mvp" },
        responseArtifactRefs: [],
      },
      createdAt: now,
    });

    const requestRow = db
      .prepare("SELECT status FROM human_requests WHERE id = ?")
      .get(request.humanRequestId) as { status: string };
    const responseRow = db
      .prepare("SELECT status FROM human_responses WHERE id = ?")
      .get(response.humanResponseId) as { status: string };

    expect(requestRow.status).toBe("answered");
    expect(responseRow.status).toBe("delivering");
    db.close();
  });

  it("ingests task graph snapshots and artifact projections", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
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

    const snapshotPayload = {
      runtimeSnapshotId: "snap-1",
      snapshotVersion: 1,
      clusters: [
        { runtimeClusterId: "cluster-main", title: "Main", status: "running", payload: {} },
      ],
      tasks: [
        {
          runtimeTaskId: "task-a",
          title: "A",
          status: "completed",
          inputArtifactIds: [],
          outputArtifactIds: [],
          runIds: [],
          payload: {},
        },
        {
          runtimeTaskId: "task-b",
          title: "B",
          status: "running",
          inputArtifactIds: [],
          outputArtifactIds: [],
          runIds: [],
          payload: {},
        },
      ],
      dependencies: [
        { fromTaskRuntimeId: "task-a", toTaskRuntimeId: "task-b", kind: "depends_on" },
      ],
      payload: {},
    };
    const snapshot = ingestTaskGraphSnapshot(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: snapshotPayload,
      receivedAt: now,
    });
    const replayedSnapshot = ingestTaskGraphSnapshot(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: snapshotPayload,
      receivedAt: "2026-05-22T00:02:00.000Z",
    });

    const taskCount = db
      .prepare("SELECT COUNT(*) AS count FROM task_graph_tasks WHERE snapshot_id = ?")
      .get(snapshot.snapshotId) as { count: number };
    expect(taskCount.count).toBe(2);

    const artifactId = createId("art");
    const artifactPayload = {
      artifactId,
      scope: "project" as const,
      kind: "report",
      title: "MVP report",
      format: "markdown" as const,
      source: "runtime" as const,
      contentRef: { runtimePathRef: "artifact://local/mvp.md" },
      provenance: { runtimeSnapshotId: "snap-1" },
      links: [{ targetKind: "task", targetId: "task-b", relation: "output" }],
    };
    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: artifactPayload,
      createdAt: now,
    });
    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: artifactPayload,
      createdAt: "2026-05-22T00:02:00.000Z",
    });

    const snapshotCount = db
      .prepare("SELECT COUNT(*) AS count FROM task_graph_snapshots")
      .get() as {
      count: number;
    };
    const artifactCount = db
      .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE id = ?")
      .get(artifactId) as {
      count: number;
    };
    const artifact = db.prepare("SELECT title FROM artifacts WHERE id = ?").get(artifactId) as {
      title: string;
    };
    const linkCount = db
      .prepare("SELECT COUNT(*) AS count FROM artifact_links WHERE artifact_id = ?")
      .get(artifactId) as { count: number };

    expect(replayedSnapshot.snapshotId).toBe(snapshot.snapshotId);
    expect(snapshotCount.count).toBe(1);
    expect(artifact.title).toBe("MVP report");
    expect(artifactCount.count).toBe(1);
    expect(linkCount.count).toBe(1);
    db.close();
  });
});
