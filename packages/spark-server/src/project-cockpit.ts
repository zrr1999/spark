import type { DatabaseSync } from "node:sqlite";
import { normalizePiTaskStatusGroup } from "@zendev-lab/spark-tasks";
import { loadWorkspaceServerControl } from "./projection-services";

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeProjectCockpitKindDisplay(value: unknown): ProjectCockpitKindDisplay | null {
  if (!isRecord(value)) return null;
  const kind = typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : "generic";
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : kind;
  const badge =
    typeof value.badge === "string" && value.badge.trim() ? value.badge.trim() : undefined;
  const panels = Array.isArray(value.panels)
    ? value.panels.flatMap((panel): ProjectCockpitKindPanel[] => {
        if (!isRecord(panel)) return [];
        const label = typeof panel.label === "string" ? panel.label.trim() : "";
        const text = typeof panel.text === "string" ? panel.text.trim() : "";
        const render = panel.render;
        if (!label || !text || !isProjectKindRender(render)) return [];
        return [{ label, text, render }];
      })
    : [];
  return { kind, title, ...(badge ? { badge } : {}), panels };
}

function isProjectKindRender(value: unknown): value is ProjectCockpitKindPanel["render"] {
  return value === "text" || value === "progress" || value === "counts" || value === "list";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTaskStatus(status: string) {
  const group = normalizePiTaskStatusGroup(status);
  return group === "pending" ? "ready" : group;
}

export interface ProjectCockpitTaskLink {
  runtimeTaskId: string;
  title: string;
  kind: string;
}

export interface ProjectCockpitInvocationLink {
  id: string;
  runtimeInvocationId: string;
  agentName: string | null;
  status: string;
  updatedAt: string;
}

export interface ProjectCockpitKindPanel {
  label: string;
  render: "text" | "progress" | "counts" | "list";
  text: string;
}

export interface ProjectCockpitKindDisplay {
  kind: string;
  title: string;
  badge?: string;
  panels: ProjectCockpitKindPanel[];
}

export interface ProjectCockpitTask {
  runtimeTaskId: string;
  name: string | null;
  title: string;
  description: string | null;
  status: string;
  statusGroup: string;
  kind: string | null;
  agentRef: string | null;
  runtimeClusterId: string | null;
  clusterTitle: string | null;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  inputArtifactCount: number;
  outputArtifactCount: number;
  runIds: string[];
  blockers: ProjectCockpitTaskLink[];
  dependents: ProjectCockpitTaskLink[];
  invocationLinks: ProjectCockpitInvocationLink[];
  readyFrontier: boolean;
}

export interface ProjectCockpitOwnerBinding {
  runtimeWorkspaceBindingId: string;
  displayName: string;
  bindingStatus: string;
  runtimeName: string;
  runtimeStatus: string;
}

export interface ProjectCockpitCommand {
  id: string;
  kind: string;
  title: string | null;
  payloadJson: string;
  status: string;
  deliveryStatus: string | null;
  attemptCount: number | null;
  lastAttemptAt: string | null;
  ackedAt: string | null;
  rejectedAt: string | null;
  rejectCode: string | null;
  rejectMessage: string | null;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
  runtimeStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCockpitLogChunk {
  id: string;
  runtimeInvocationId: string;
  agentName: string | null;
  stream: string;
  sequence: number;
  content: string;
  createdAt: string;
}

export function loadProjectCockpit(db: DatabaseSync, projectId: string) {
  const project = db
    .prepare(
      `SELECT p.id,
              p.workspace_id AS workspaceId,
              p.slug,
              p.name,
              p.description,
              p.status,
              p.created_at AS createdAt,
              p.updated_at AS updatedAt,
              w.name AS workspaceName,
              w.slug AS workspaceSlug
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = ?
       LIMIT 1`,
    )
    .get(projectId) as
    | {
        id: string;
        workspaceId: string;
        slug: string;
        name: string;
        description: string | null;
        status: string;
        createdAt: string;
        updatedAt: string;
        workspaceName: string;
        workspaceSlug: string;
      }
    | undefined;

  if (!project) {
    return null;
  }

  const ownerBinding =
    (db
      .prepare(
        `SELECT wob.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
                rb.display_name AS displayName,
                rb.status AS bindingStatus,
                rc.name AS runtimeName,
                rc.status AS runtimeStatus
         FROM workspace_owner_bindings wob
         JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
         JOIN runtime_connections rc ON rc.id = rb.runtime_id
         WHERE wob.workspace_id = ? AND wob.ended_at IS NULL
         LIMIT 1`,
      )
      .get(project.workspaceId) as ProjectCockpitOwnerBinding | undefined) ?? null;

  const latestSnapshot = db
    .prepare(
      `SELECT id,
              runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              runtime_snapshot_id AS runtimeSnapshotId,
              snapshot_version AS snapshotVersion,
              payload_json AS payloadJson,
              received_at AS receivedAt
       FROM task_graph_snapshots
       WHERE project_id = ?
       ORDER BY snapshot_version DESC, received_at DESC
       LIMIT 1`,
    )
    .get(project.id) as
    | {
        id: string;
        runtimeWorkspaceBindingId: string;
        runtimeSnapshotId: string;
        snapshotVersion: number;
        payloadJson: string;
        receivedAt: string;
      }
    | undefined;

  const latestSnapshotPayload = parseJsonObject(latestSnapshot?.payloadJson);
  const projectKind = normalizeProjectCockpitKindDisplay(
    isRecord(latestSnapshotPayload.payload) ? latestSnapshotPayload.payload.projectKind : undefined,
  );

  const taskRows = latestSnapshot
    ? (db
        .prepare(
          `SELECT t.runtime_task_id AS runtimeTaskId,
                  t.runtime_cluster_id AS runtimeClusterId,
                  t.name,
                  t.title,
                  t.description,
                  t.status,
                  t.kind,
                  t.agent_ref AS agentRef,
                  t.input_artifact_ids_json AS inputArtifactIdsJson,
                  t.output_artifact_ids_json AS outputArtifactIdsJson,
                  t.run_ids_json AS runIdsJson,
                  th.title AS clusterTitle,
                  th.sort_key AS clusterSortKey
           FROM task_graph_tasks t
           LEFT JOIN task_graph_clusters th
             ON th.snapshot_id = t.snapshot_id AND th.runtime_cluster_id = t.runtime_cluster_id
           WHERE t.snapshot_id = ?
           ORDER BY COALESCE(th.sort_key, th.title, ''), t.title ASC`,
        )
        .all(latestSnapshot.id) as Array<{
        runtimeTaskId: string;
        runtimeClusterId: string | null;
        name: string | null;
        title: string;
        description: string | null;
        status: string;
        kind: string | null;
        agentRef: string | null;
        inputArtifactIdsJson: string;
        outputArtifactIdsJson: string;
        runIdsJson: string;
        clusterTitle: string | null;
        clusterSortKey: string | null;
      }>)
    : [];

  const dependencyRows = latestSnapshot
    ? (db
        .prepare(
          `SELECT from_task_runtime_id AS fromTaskRuntimeId,
                  to_task_runtime_id AS toTaskRuntimeId,
                  kind
           FROM task_graph_dependencies
           WHERE snapshot_id = ?
           ORDER BY kind ASC, from_task_runtime_id ASC, to_task_runtime_id ASC`,
        )
        .all(latestSnapshot.id) as Array<{
        fromTaskRuntimeId: string;
        toTaskRuntimeId: string;
        kind: string;
      }>)
    : [];

  const invocationRows = db
    .prepare(
      `SELECT id,
              runtime_invocation_id AS runtimeInvocationId,
              task_runtime_id AS taskRuntimeId,
              agent_name AS agentName,
              status,
              updated_at AS updatedAt
       FROM mirrored_invocations
       WHERE project_id = ?
       ORDER BY updated_at DESC
       LIMIT 32`,
    )
    .all(project.id) as Array<{
    id: string;
    runtimeInvocationId: string;
    taskRuntimeId: string | null;
    agentName: string | null;
    status: string;
    updatedAt: string;
  }>;

  const taskTitleByRuntimeId = new Map(taskRows.map((task) => [task.runtimeTaskId, task.title]));
  const taskStatusGroupByRuntimeId = new Map(
    taskRows.map((task) => [task.runtimeTaskId, normalizeTaskStatus(task.status)]),
  );
  const tasks: ProjectCockpitTask[] = taskRows.map((task) => {
    const inputArtifactIds = parseJsonArray(task.inputArtifactIdsJson);
    const outputArtifactIds = parseJsonArray(task.outputArtifactIdsJson);
    const runIds = parseJsonArray(task.runIdsJson);
    const invocationLinks = invocationRows
      .filter(
        (invocation) =>
          invocation.taskRuntimeId === task.runtimeTaskId ||
          runIds.includes(invocation.runtimeInvocationId),
      )
      .map(({ taskRuntimeId: _taskRuntimeId, ...invocation }) => invocation);

    const blockers = dependencyRows
      .filter((dependency) => dependency.toTaskRuntimeId === task.runtimeTaskId)
      .map((dependency) => ({
        runtimeTaskId: dependency.fromTaskRuntimeId,
        title:
          taskTitleByRuntimeId.get(dependency.fromTaskRuntimeId) ?? dependency.fromTaskRuntimeId,
        kind: dependency.kind,
      }));

    return {
      runtimeTaskId: task.runtimeTaskId,
      name: task.name,
      title: task.title,
      description: task.description,
      status: task.status,
      statusGroup: normalizeTaskStatus(task.status),
      kind: task.kind,
      agentRef: task.agentRef,
      runtimeClusterId: task.runtimeClusterId,
      clusterTitle: task.clusterTitle,
      inputArtifactIds,
      outputArtifactIds,
      inputArtifactCount: inputArtifactIds.length,
      outputArtifactCount: outputArtifactIds.length,
      runIds,
      blockers,
      dependents: dependencyRows
        .filter((dependency) => dependency.fromTaskRuntimeId === task.runtimeTaskId)
        .map((dependency) => ({
          runtimeTaskId: dependency.toTaskRuntimeId,
          title: taskTitleByRuntimeId.get(dependency.toTaskRuntimeId) ?? dependency.toTaskRuntimeId,
          kind: dependency.kind,
        })),
      invocationLinks,
      readyFrontier:
        normalizeTaskStatus(task.status) === "ready" &&
        blockers.every(
          (blocker) => taskStatusGroupByRuntimeId.get(blocker.runtimeTaskId) === "done",
        ),
    };
  });

  const taskSummary = tasks.reduce(
    (summary, task) => {
      summary.total += 1;
      summary.byGroup[task.statusGroup] = (summary.byGroup[task.statusGroup] ?? 0) + 1;
      summary.byStatus[task.statusGroup] = (summary.byStatus[task.statusGroup] ?? 0) + 1;
      return summary;
    },
    {
      total: 0,
      dependencyCount: dependencyRows.length,
      linkedInvocationCount: tasks.reduce((count, task) => count + task.invocationLinks.length, 0),
      byGroup: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
    },
  );

  const inboxItems = db
    .prepare(
      `SELECT id, human_request_id AS humanRequestId, kind, title, status, urgency, created_at AS createdAt
       FROM inbox_items
       WHERE project_id = ?
       ORDER BY created_at DESC
       LIMIT 8`,
    )
    .all(project.id) as Array<{
    id: string;
    humanRequestId: string | null;
    kind: string;
    title: string;
    status: string;
    urgency: string;
    createdAt: string;
  }>;

  const artifacts = db
    .prepare(
      `SELECT id, kind, title, format, source, created_at AS createdAt
       FROM artifacts
       WHERE project_id = ?
       ORDER BY created_at DESC
       LIMIT 8`,
    )
    .all(project.id) as Array<{
    id: string;
    kind: string;
    title: string;
    format: string;
    source: string;
    createdAt: string;
  }>;

  const invocations = invocationRows.slice(0, 8);

  const commands = db
    .prepare(
      `SELECT c.id,
              c.kind,
              c.title,
              c.payload_json AS payloadJson,
              c.status,
              c.created_at AS createdAt,
              c.updated_at AS updatedAt,
              cd.status AS deliveryStatus,
              cd.attempt_count AS attemptCount,
              cd.last_attempt_at AS lastAttemptAt,
              cd.acked_at AS ackedAt,
              cd.rejected_at AS rejectedAt,
              cd.reject_code AS rejectCode,
              cd.reject_message AS rejectMessage,
              rb.display_name AS runtimeWorkspaceName,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM commands c
       LEFT JOIN command_deliveries cd ON cd.command_id = c.id
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = cd.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE c.project_id = ?
       ORDER BY c.created_at DESC
       LIMIT 8`,
    )
    .all(project.id) as unknown as ProjectCockpitCommand[];

  const logChunks = (
    db
      .prepare(
        `SELECT l.id,
                mi.runtime_invocation_id AS runtimeInvocationId,
                mi.agent_name AS agentName,
                l.stream,
                l.sequence,
                l.content,
                l.created_at AS createdAt
         FROM invocation_log_chunks l
         JOIN mirrored_invocations mi ON mi.id = l.invocation_id
         WHERE mi.project_id = ?
         ORDER BY l.created_at DESC, l.sequence DESC
         LIMIT 48`,
      )
      .all(project.id) as unknown as ProjectCockpitLogChunk[]
  ).reverse();

  return {
    project,
    ownerBinding,
    workspaceControl: loadWorkspaceServerControl(db, project.workspaceId),
    latestSnapshot: latestSnapshot ?? null,
    projectKind,
    tasks,
    taskSummary,
    inboxItems,
    artifacts,
    invocations,
    commands,
    logChunks,
  };
}
