import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import {
  createProject,
  createWorkspaceWithOwnerBinding,
  ingestTaskGraphSnapshot,
  queueCommandForWorkspaceOwner,
  recordCommandAck,
  recordCommandReject,
  recordInvocationLogChunk,
  recordInvocationUpdate,
} from "./projection-services";
import { loadProjectCockpit } from "./project-cockpit";

function offsetIso(baseIso: string, offsetMs: number) {
  return new Date(Date.parse(baseIso) + offsetMs).toISOString();
}

function setupProject() {
  const db = openMemoryDatabase();
  migrate(db);

  const now = new Date(Date.now() - 10_000).toISOString();
  const runtimeId = createId("rt");
  const runtimeWorkspaceBindingId = createId("rtwb");

  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, last_heartbeat_at, created_at, updated_at)
     VALUES (?, ?, ?, 'online', ?, '{}', '{}', ?, ?, ?)`,
  ).run(runtimeId, "install-test", "Test runtime", runtimeProtocolVersion, now, now, now);

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

  return { db, now, runtimeWorkspaceBindingId, workspace, project };
}

describe("project cockpit projection", () => {
  it("summarizes latest task graph snapshots with dependencies and invocation links", () => {
    const { db, now, runtimeWorkspaceBindingId, workspace, project } = setupProject();
    const invocationId = createId("inv");

    ingestTaskGraphSnapshot(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: {
        runtimeSnapshotId: "snap-1",
        snapshotVersion: 1,
        clusters: [
          { runtimeClusterId: "cluster-main", title: "Main", status: "running", payload: {} },
        ],
        tasks: [
          {
            runtimeTaskId: "task-plan",
            runtimeClusterId: "cluster-main",
            title: "Plan",
            status: "completed",
            inputArtifactIds: [],
            outputArtifactIds: [createId("art")],
            runIds: [],
            payload: {},
          },
          {
            runtimeTaskId: "task-build",
            runtimeClusterId: "cluster-main",
            title: "Build",
            status: "blocked",
            agentRef: "role:worker",
            inputArtifactIds: [createId("art")],
            outputArtifactIds: [],
            runIds: [invocationId],
            payload: {},
          },
        ],
        dependencies: [
          { fromTaskRuntimeId: "task-plan", toTaskRuntimeId: "task-build", kind: "depends_on" },
        ],
        payload: {
          projectKind: {
            kind: "generic",
            title: "Generic",
            badge: "generic",
            panels: [{ label: "Gate", render: "text", text: "task graph" }],
          },
        },
      },
      receivedAt: now,
    });

    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: {
        runtimeInvocationId: invocationId,
        taskRuntimeId: "task-build",
        agentName: "worker",
        status: "running",
        startedAt: now,
        payload: {},
      },
      updatedAt: now,
    });

    const cockpit = loadProjectCockpit(db, project.id);
    expect(cockpit?.latestSnapshot?.runtimeSnapshotId).toBe("snap-1");
    expect(cockpit?.taskSummary).toMatchObject({
      total: 2,
      dependencyCount: 1,
      linkedInvocationCount: 1,
    });
    expect(cockpit?.taskSummary.byGroup).toMatchObject({ done: 1, blocked: 1 });
    expect(cockpit?.taskSummary.byStatus).toMatchObject({ done: 1, blocked: 1 });
    expect(cockpit?.projectKind).toEqual({
      kind: "generic",
      title: "Generic",
      badge: "generic",
      panels: [{ label: "Gate", render: "text", text: "task graph" }],
    });

    const buildTask = cockpit?.tasks.find((task) => task.runtimeTaskId === "task-build");
    expect(buildTask?.blockers).toEqual([
      { runtimeTaskId: "task-plan", title: "Plan", kind: "depends_on" },
    ]);
    expect(buildTask?.invocationLinks).toMatchObject([
      { runtimeInvocationId: invocationId, agentName: "worker", status: "running" },
    ]);
    expect(buildTask?.inputArtifactCount).toBe(1);
    expect(buildTask?.readyFrontier).toBe(false);

    db.close();
  });

  it("includes owner binding, recent commands, delivery outcomes, and Spark daemon log chunks", () => {
    const { db, now, runtimeWorkspaceBindingId, workspace, project } = setupProject();
    const pendingCommand = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      projectId: project.id,
      payload: {
        kind: "task.start.request",
        title: "Pending project task",
        payload: { prompt: "Inspect the workspace." },
      },
      createdAt: offsetIso(now, 2_000),
    });
    const ackedCommand = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      projectId: project.id,
      payload: {
        kind: "task.start.request",
        title: "Acked project task",
        payload: { prompt: "Run the workspace." },
      },
      createdAt: offsetIso(now, 1_000),
    });
    const rejectedCommand = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      projectId: project.id,
      payload: {
        kind: "task.start.request",
        title: "Rejected project task",
        payload: { prompt: "Mutate the workspace." },
      },
      createdAt: now,
    });

    recordCommandAck(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      commandId: ackedCommand.id,
      payload: { accepted: true, invocationId: createId("inv") },
      acknowledgedAt: offsetIso(now, 3_000),
    });
    recordCommandReject(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      commandId: rejectedCommand.id,
      payload: { reasonCode: "policy_denied", message: "Mutation disabled" },
      rejectedAt: offsetIso(now, 4_000),
    });
    const invocationId = createId("inv");

    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      commandId: ackedCommand.id,
      payload: {
        runtimeInvocationId: invocationId,
        agentName: "pi",
        status: "running",
        payload: {},
      },
      updatedAt: now,
    });
    recordInvocationLogChunk(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      commandId: ackedCommand.id,
      payload: {
        runtimeInvocationId: invocationId,
        stream: "agent",
        sequence: 1,
        content: "Starting work",
      },
      createdAt: now,
    });

    const cockpit = loadProjectCockpit(db, project.id);
    expect(cockpit?.ownerBinding).toMatchObject({
      runtimeWorkspaceBindingId,
      runtimeStatus: "online",
    });
    expect(cockpit?.commands).toMatchObject([
      {
        id: pendingCommand.id,
        kind: "task.start.request",
        title: "Pending project task",
        status: "queued",
        deliveryStatus: "pending",
        attemptCount: 0,
      },
      {
        id: ackedCommand.id,
        title: "Acked project task",
        status: "acked",
        deliveryStatus: "acked",
        ackedAt: offsetIso(now, 3_000),
      },
      {
        id: rejectedCommand.id,
        title: "Rejected project task",
        status: "rejected",
        deliveryStatus: "rejected",
        rejectedAt: offsetIso(now, 4_000),
        rejectCode: "policy_denied",
        rejectMessage: "Mutation disabled",
      },
    ]);
    expect(cockpit?.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId: ackedCommand.id,
          runtimeInvocationId: invocationId,
          agentName: "pi",
          status: "running",
        }),
      ]),
    );
    expect(cockpit?.logChunks).toMatchObject([
      {
        runtimeInvocationId: invocationId,
        stream: "agent",
        sequence: 1,
        content: "Starting work",
      },
    ]);

    db.close();
  });
});
