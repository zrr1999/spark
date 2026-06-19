import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  type ArtifactProjectionPayload,
  type HumanRequestCreatedPayload,
  type HumanResponseAckPayload,
  type HumanResponseDeliverPayload,
  type InvocationLogChunkPayload,
  type InvocationUpdatePayload,
  type RuntimeCommandAckPayload,
  type RuntimeCommandRejectPayload,
  type ServerCommandPayload,
  type TaskGraphSnapshotPayload,
} from "@zendev-lab/navia-protocol";

function nowIso() {
  return new Date().toISOString();
}

function toJson(value: unknown) {
  return JSON.stringify(value ?? {});
}

function withTransaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface AppendEventInput {
  workspaceId?: string | null;
  projectId?: string | null;
  actorKind: "user" | "runtime" | "server";
  actorId?: string | null;
  kind: string;
  subjectKind?: string | null;
  subjectId?: string | null;
  payload?: unknown;
  createdAt?: string;
}

export function appendEvent(db: DatabaseSync, input: AppendEventInput) {
  const event = {
    id: createId("evt"),
    createdAt: input.createdAt ?? nowIso(),
  };

  db.prepare(
    `INSERT INTO events
      (id, workspace_id, project_id, actor_kind, actor_id, kind, subject_kind, subject_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    input.workspaceId ?? null,
    input.projectId ?? null,
    input.actorKind,
    input.actorId ?? null,
    input.kind,
    input.subjectKind ?? null,
    input.subjectId ?? null,
    toJson(input.payload),
    event.createdAt,
  );

  return event;
}

interface CreateWorkspaceInput {
  slug: string;
  name: string;
  description?: string | null;
  settings?: unknown;
  profileSource?: {
    sourceKind: "builtin" | "git";
    profileId: string;
    profileName: string;
    schemaVersion: string;
    repoUrl?: string | null;
    sourcePath?: string | null;
    commitHash?: string | null;
  } | null;
  agentSpecs?: Array<{
    name: string;
    source: "builtin" | "workspace" | "imported";
    status: "active" | "disabled" | "archived";
    description?: string | null;
    config?: unknown;
  }>;
  resources?: Array<{
    kind: "repo" | "doc" | "url" | "file" | "secret_ref" | "tool" | "other";
    name: string;
    uri?: string | null;
    status: "available" | "degraded" | "unavailable" | "archived";
    config?: unknown;
  }>;
  createdAt?: string;
}

export interface CreateWorkspaceWithOwnerBindingInput extends CreateWorkspaceInput {
  runtimeWorkspaceBindingId: string;
}

export interface WorkspaceProjection {
  id: string;
  ownerBindingId: string;
  createdAt: string;
  updatedAt: string;
}

export function createWorkspaceWithOwnerBinding(
  db: DatabaseSync,
  input: CreateWorkspaceWithOwnerBindingInput,
) {
  return withTransaction(db, () => {
    const binding = db
      .prepare("SELECT id FROM runtime_workspace_bindings WHERE id = ? AND status != 'archived'")
      .get(input.runtimeWorkspaceBindingId) as { id: string } | undefined;

    if (!binding) {
      throw new Error(
        `Spark daemon workspace binding is not available: ${input.runtimeWorkspaceBindingId}`,
      );
    }

    const existing = db
      .prepare(
        `SELECT id,
                created_at AS createdAt
         FROM workspaces
         WHERE slug = ? AND status = 'active'
         LIMIT 1`,
      )
      .get(input.slug) as { id: string; createdAt: string } | undefined;

    return upsertWorkspaceProjection(db, input, input.runtimeWorkspaceBindingId, existing ?? null);
  });
}

function upsertWorkspaceProjection(
  db: DatabaseSync,
  input: CreateWorkspaceInput,
  runtimeWorkspaceBindingId: string,
  existing: { id: string; createdAt: string } | null,
): WorkspaceProjection {
  const timestamp = input.createdAt ?? nowIso();
  const workspace = {
    id: existing?.id ?? createId("ws"),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  if (existing) {
    db.prepare(
      `UPDATE workspaces
       SET name = ?,
           description = ?,
           settings_json = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      input.description ?? null,
      toJson(input.settings ?? {}),
      timestamp,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, description, status, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      workspace.id,
      input.slug,
      input.name,
      input.description ?? null,
      toJson(input.settings ?? {}),
      timestamp,
      timestamp,
    );
  }

  const ownerBindingId = ensureActiveOwnerBinding(
    db,
    workspace.id,
    runtimeWorkspaceBindingId,
    timestamp,
    { replaceExisting: !existing },
  );
  const shouldSeedWorkspace = !hasWorkspaceProfileSource(db, workspace.id);

  if (input.profileSource && shouldSeedWorkspace) {
    db.prepare(
      `INSERT INTO workspace_profile_sources
        (id, workspace_id, source_kind, profile_id, profile_name, schema_version, repo_url, source_path, commit_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId("wpsrc"),
      workspace.id,
      input.profileSource.sourceKind,
      input.profileSource.profileId,
      input.profileSource.profileName,
      input.profileSource.schemaVersion,
      input.profileSource.repoUrl ?? null,
      input.profileSource.sourcePath ?? null,
      input.profileSource.commitHash ?? null,
      timestamp,
    );
  }

  for (const resource of shouldSeedWorkspace ? (input.resources ?? []) : []) {
    db.prepare(
      `INSERT INTO resources
        (id, workspace_id, kind, name, uri, status, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId("res"),
      workspace.id,
      resource.kind,
      resource.name,
      resource.uri ?? null,
      resource.status,
      toJson(resource.config ?? {}),
      timestamp,
      timestamp,
    );
  }

  for (const agent of shouldSeedWorkspace ? (input.agentSpecs ?? []) : []) {
    db.prepare(
      `INSERT INTO agent_specs
        (id, workspace_id, name, source, status, description, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, name) DO UPDATE SET
         source = excluded.source,
         status = excluded.status,
         description = excluded.description,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
    ).run(
      createId("agent"),
      workspace.id,
      agent.name,
      agent.source,
      agent.status,
      agent.description ?? null,
      toJson(agent.config ?? {}),
      timestamp,
      timestamp,
    );
  }

  if (shouldSeedWorkspace) {
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "server",
      kind: "workspace.created",
      subjectKind: "workspace",
      subjectId: workspace.id,
      payload: {
        runtimeWorkspaceBindingId,
        profileSource: input.profileSource
          ? {
              sourceKind: input.profileSource.sourceKind,
              profileId: input.profileSource.profileId,
              commitHash: input.profileSource.commitHash ?? null,
            }
          : null,
      },
      createdAt: timestamp,
    });
  }

  return { ...workspace, ownerBindingId };
}

function ensureActiveOwnerBinding(
  db: DatabaseSync,
  workspaceId: string,
  runtimeWorkspaceBindingId: string,
  timestamp: string,
  options: { replaceExisting: boolean },
): string {
  const active = db
    .prepare(
      `SELECT id,
              runtime_workspace_binding_id AS runtimeWorkspaceBindingId
       FROM workspace_owner_bindings
       WHERE workspace_id = ? AND ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { id: string; runtimeWorkspaceBindingId: string } | undefined;
  if (active?.runtimeWorkspaceBindingId === runtimeWorkspaceBindingId) {
    return active.id;
  }
  if (active && !options.replaceExisting) {
    throw new Error(`Workspace already has an active runtime owner binding: ${workspaceId}`);
  }

  db.prepare(
    `UPDATE workspace_owner_bindings
     SET ended_at = ?
     WHERE workspace_id = ? AND ended_at IS NULL`,
  ).run(timestamp, workspaceId);

  const ownerBindingId = createId("wob");
  db.prepare(
    `INSERT INTO workspace_owner_bindings
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
     VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
  ).run(ownerBindingId, workspaceId, runtimeWorkspaceBindingId, timestamp, timestamp);
  return ownerBindingId;
}

function hasWorkspaceProfileSource(db: DatabaseSync, workspaceId: string): boolean {
  const existing = db
    .prepare("SELECT id FROM workspace_profile_sources WHERE workspace_id = ? LIMIT 1")
    .get(workspaceId);
  return Boolean(existing);
}

export interface CreateProjectInput {
  workspaceId: string;
  slug: string;
  name: string;
  description?: string | null;
  createdAt?: string;
}

export function createProject(db: DatabaseSync, input: CreateProjectInput) {
  return withTransaction(db, () => {
    const timestamp = input.createdAt ?? nowIso();
    const project = {
      id: createId("proj"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    db.prepare(
      `INSERT INTO projects
        (id, workspace_id, slug, name, description, status, current_conclusion_artifact_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'planned', NULL, ?, ?, ?)`,
    ).run(
      project.id,
      input.workspaceId,
      input.slug,
      input.name,
      input.description ?? null,
      toJson({ sourceOfTruth: "navia-cockpit-routing" }),
      timestamp,
      timestamp,
    );

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: project.id,
      actorKind: "user",
      kind: "project.created",
      subjectKind: "project",
      subjectId: project.id,
      createdAt: timestamp,
    });

    return project;
  });
}

export interface QueueCommandInput {
  workspaceId: string;
  projectId?: string | null;
  requestedByUserId?: string | null;
  idempotencyKey?: string | null;
  payload: ServerCommandPayload;
  createdAt?: string;
}

export function queueCommandForWorkspaceOwner(db: DatabaseSync, input: QueueCommandInput) {
  return withTransaction(db, () => {
    const owner = db
      .prepare(
        `SELECT runtime_workspace_binding_id AS runtimeWorkspaceBindingId
         FROM workspace_owner_bindings
         WHERE workspace_id = ? AND ended_at IS NULL
         LIMIT 1`,
      )
      .get(input.workspaceId) as { runtimeWorkspaceBindingId: string } | undefined;

    if (!owner) {
      throw new Error(`Workspace has no active runtime owner binding: ${input.workspaceId}`);
    }

    const timestamp = input.createdAt ?? nowIso();
    const command = {
      id: createId("cmd"),
      deliveryId: createId("deliv"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    db.prepare(
      `INSERT INTO commands
        (id, workspace_id, project_id, kind, title, payload_json, requested_by_user_id, idempotency_key, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      command.id,
      input.workspaceId,
      input.projectId ?? null,
      input.payload.kind,
      input.payload.title ?? null,
      toJson(input.payload),
      input.requestedByUserId ?? null,
      input.idempotencyKey ?? null,
      timestamp,
      timestamp,
    );

    db.prepare(
      `INSERT INTO command_deliveries
        (id, command_id, runtime_workspace_binding_id, status, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(command.deliveryId, command.id, owner.runtimeWorkspaceBindingId, timestamp, timestamp);

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      actorKind: "server",
      kind: "command.queued",
      subjectKind: "command",
      subjectId: command.id,
      payload: { runtimeWorkspaceBindingId: owner.runtimeWorkspaceBindingId },
      createdAt: timestamp,
    });

    return command;
  });
}

export interface RecordHumanRequestInput {
  runtimeWorkspaceBindingId: string;
  workspaceId: string;
  projectId?: string | null;
  commandId?: string | null;
  invocationId?: string | null;
  humanRequestId?: string;
  runtimeRequestId: string;
  payload: HumanRequestCreatedPayload;
  createdAt?: string;
}

export function recordHumanRequestFromRuntime(db: DatabaseSync, input: RecordHumanRequestInput) {
  return withTransaction(db, () => {
    const timestamp = input.createdAt ?? nowIso();
    const humanRequestId = input.humanRequestId ?? createId("hreq");
    const inboxItemId = createId("inbox");
    const inboxKind = input.payload.kind === "ask_user" ? "ask" : input.payload.kind;

    db.prepare(
      `INSERT INTO human_requests
        (id, runtime_workspace_binding_id, workspace_id, project_id, runtime_request_id, kind, title, prompt, questions_json, context_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      humanRequestId,
      input.runtimeWorkspaceBindingId,
      input.workspaceId,
      input.projectId ?? null,
      input.runtimeRequestId,
      input.payload.kind,
      input.payload.title,
      input.payload.prompt,
      JSON.stringify(input.payload.questions),
      toJson({
        ...input.payload.context,
        toolCallId: input.payload.toolCallId,
        commandId: input.commandId,
        invocationId: input.invocationId,
        contextArtifactRefs: input.payload.contextArtifactRefs,
      }),
      timestamp,
      timestamp,
    );

    db.prepare(
      `INSERT INTO inbox_items
        (id, workspace_id, project_id, human_request_id, kind, title, summary, urgency, status, resolved_as, next_reminder_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', 'pending', NULL, NULL, ?, ?)`,
    ).run(
      inboxItemId,
      input.workspaceId,
      input.projectId ?? null,
      humanRequestId,
      inboxKind,
      input.payload.title,
      input.payload.prompt,
      timestamp,
      timestamp,
    );

    if (input.payload.kind === "ask_user") {
      db.prepare(
        `INSERT INTO asks (id, human_request_id, artifact_id, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?)`,
      ).run(createId("ask"), humanRequestId, timestamp, timestamp);
    }

    if (input.payload.kind === "review") {
      db.prepare(
        `INSERT INTO reviews
          (id, workspace_id, project_id, human_request_id, subject_json, outcome, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?)`,
      ).run(
        createId("review"),
        input.workspaceId,
        input.projectId ?? null,
        humanRequestId,
        toJson(input.payload.context),
        timestamp,
        timestamp,
      );
    }

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      actorKind: "runtime",
      actorId: input.runtimeWorkspaceBindingId,
      kind: "human.request.created",
      subjectKind: "human_request",
      subjectId: humanRequestId,
      payload: { runtimeRequestId: input.runtimeRequestId },
      createdAt: timestamp,
    });

    return { humanRequestId, inboxItemId };
  });
}

export interface RecordHumanResponseInput {
  humanRequestId: string;
  humanResponseId?: string;
  answeredByUserId?: string | null;
  payload: HumanResponseDeliverPayload;
  createdAt?: string;
}

export function recordHumanResponse(db: DatabaseSync, input: RecordHumanResponseInput) {
  return withTransaction(db, () => {
    const timestamp = input.createdAt ?? nowIso();
    const humanResponseId = input.humanResponseId ?? createId("hres");
    const request = db
      .prepare(
        "SELECT workspace_id AS workspaceId, project_id AS projectId FROM human_requests WHERE id = ?",
      )
      .get(input.humanRequestId) as { workspaceId: string; projectId: string | null } | undefined;

    if (!request) {
      throw new Error(`Human request not found: ${input.humanRequestId}`);
    }

    db.prepare(
      `INSERT INTO human_responses
        (id, human_request_id, answered_by_user_id, answer_json, status, delivery_attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'delivering', 0, ?, ?)`,
    ).run(
      humanResponseId,
      input.humanRequestId,
      input.answeredByUserId ?? null,
      toJson(input.payload),
      timestamp,
      timestamp,
    );

    const requestStatus = input.payload.status === "answered" ? "answered" : input.payload.status;
    db.prepare("UPDATE human_requests SET status = ?, updated_at = ? WHERE id = ?").run(
      requestStatus,
      timestamp,
      input.humanRequestId,
    );

    db.prepare(
      `UPDATE inbox_items
       SET status = ?, resolved_as = ?, updated_at = ?
       WHERE human_request_id = ?`,
    ).run(
      input.payload.status === "answered" ? "resolved" : "archived",
      input.payload.status,
      timestamp,
      input.humanRequestId,
    );

    appendEvent(db, {
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      actorKind: "user",
      actorId: input.answeredByUserId ?? null,
      kind: "human.response.recorded",
      subjectKind: "human_response",
      subjectId: humanResponseId,
      createdAt: timestamp,
    });

    return { humanResponseId };
  });
}

export interface IngestTaskGraphSnapshotInput {
  runtimeWorkspaceBindingId: string;
  workspaceId: string;
  projectId?: string | null;
  payload: TaskGraphSnapshotPayload;
  receivedAt?: string;
}

export function ingestTaskGraphSnapshot(db: DatabaseSync, input: IngestTaskGraphSnapshotInput) {
  return withTransaction(db, () => {
    const timestamp = input.receivedAt ?? nowIso();
    const existing = db
      .prepare(
        `SELECT id FROM task_graph_snapshots
         WHERE runtime_workspace_binding_id = ? AND runtime_snapshot_id = ?`,
      )
      .get(input.runtimeWorkspaceBindingId, input.payload.runtimeSnapshotId) as
      | { id: string }
      | undefined;

    const snapshotId = existing?.id ?? createId("tgs");

    if (existing) {
      db.prepare("DELETE FROM task_graph_dependencies WHERE snapshot_id = ?").run(snapshotId);
      db.prepare("DELETE FROM task_graph_tasks WHERE snapshot_id = ?").run(snapshotId);
      db.prepare("DELETE FROM task_graph_clusters WHERE snapshot_id = ?").run(snapshotId);
      db.prepare(
        `UPDATE task_graph_snapshots
         SET workspace_id = ?, project_id = ?, snapshot_version = ?, payload_json = ?, received_at = ?
         WHERE id = ?`,
      ).run(
        input.workspaceId,
        input.projectId ?? null,
        input.payload.snapshotVersion,
        toJson(input.payload),
        timestamp,
        snapshotId,
      );
    } else {
      db.prepare(
        `INSERT INTO task_graph_snapshots
          (id, workspace_id, project_id, runtime_workspace_binding_id, runtime_snapshot_id, snapshot_version, payload_json, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        snapshotId,
        input.workspaceId,
        input.projectId ?? null,
        input.runtimeWorkspaceBindingId,
        input.payload.runtimeSnapshotId,
        input.payload.snapshotVersion,
        toJson(input.payload),
        timestamp,
      );
    }

    for (const cluster of input.payload.clusters) {
      db.prepare(
        `INSERT INTO task_graph_clusters
          (id, snapshot_id, workspace_id, project_id, runtime_cluster_id, name, title, status, sort_key, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        createId("tgt"),
        snapshotId,
        input.workspaceId,
        input.projectId ?? null,
        cluster.runtimeClusterId,
        cluster.name ?? null,
        cluster.title,
        cluster.status,
        cluster.sortKey ?? null,
        toJson(cluster.payload),
      );
    }

    for (const task of input.payload.tasks) {
      db.prepare(
        `INSERT INTO task_graph_tasks
          (id, snapshot_id, workspace_id, project_id, runtime_task_id, runtime_cluster_id, name, title, description, kind, status, agent_ref, input_artifact_ids_json, output_artifact_ids_json, run_ids_json, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        createId("task"),
        snapshotId,
        input.workspaceId,
        input.projectId ?? null,
        task.runtimeTaskId,
        task.runtimeClusterId ?? null,
        task.name ?? null,
        task.title,
        task.description ?? null,
        task.kind ?? null,
        task.status,
        task.agentRef ?? null,
        JSON.stringify(task.inputArtifactIds ?? []),
        JSON.stringify(task.outputArtifactIds ?? []),
        JSON.stringify(task.runIds ?? []),
        toJson(task.payload),
      );
    }

    for (const dependency of input.payload.dependencies) {
      db.prepare(
        `INSERT INTO task_graph_dependencies
          (id, snapshot_id, from_task_runtime_id, to_task_runtime_id, kind)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        createId("dep"),
        snapshotId,
        dependency.fromTaskRuntimeId,
        dependency.toTaskRuntimeId,
        dependency.kind,
      );
    }

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      actorKind: "runtime",
      actorId: input.runtimeWorkspaceBindingId,
      kind: "task_graph.snapshot.ingested",
      subjectKind: "task_graph_snapshot",
      subjectId: snapshotId,
      payload: { runtimeSnapshotId: input.payload.runtimeSnapshotId },
      createdAt: timestamp,
    });

    return { snapshotId };
  });
}

export interface RecordArtifactProjectionInput {
  runtimeWorkspaceBindingId?: string | null;
  workspaceId: string;
  projectId?: string | null;
  invocationId?: string | null;
  humanRequestId?: string | null;
  payload: ArtifactProjectionPayload;
  createdAt?: string;
}

export function recordArtifactProjection(db: DatabaseSync, input: RecordArtifactProjectionInput) {
  return withTransaction(db, () => {
    const timestamp = input.createdAt ?? nowIso();
    const invocation = input.invocationId
      ? (db
          .prepare(
            `SELECT id FROM mirrored_invocations
             WHERE runtime_workspace_binding_id = ? AND runtime_invocation_id = ?`,
          )
          .get(input.runtimeWorkspaceBindingId ?? null, input.invocationId) as
          | { id: string }
          | undefined)
      : undefined;

    db.prepare(
      `INSERT INTO artifacts
        (id, workspace_id, project_id, scope, kind, title, format, source, runtime_workspace_binding_id, invocation_id, human_request_id, hash, size_bytes, content_ref_json, provenance_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         project_id = excluded.project_id,
         scope = excluded.scope,
         kind = excluded.kind,
         title = excluded.title,
         format = excluded.format,
         source = excluded.source,
         runtime_workspace_binding_id = excluded.runtime_workspace_binding_id,
         invocation_id = excluded.invocation_id,
         human_request_id = excluded.human_request_id,
         hash = excluded.hash,
         size_bytes = excluded.size_bytes,
         content_ref_json = excluded.content_ref_json,
         provenance_json = excluded.provenance_json,
         updated_at = excluded.updated_at`,
    ).run(
      input.payload.artifactId,
      input.workspaceId,
      input.projectId ?? null,
      input.payload.scope,
      input.payload.kind,
      input.payload.title,
      input.payload.format,
      input.payload.source,
      input.runtimeWorkspaceBindingId ?? null,
      invocation?.id ?? null,
      input.humanRequestId ?? null,
      input.payload.hash ?? null,
      input.payload.sizeBytes ?? null,
      toJson(input.payload.contentRef),
      toJson(input.payload.provenance),
      timestamp,
      timestamp,
    );

    db.prepare("DELETE FROM artifact_links WHERE artifact_id = ?").run(input.payload.artifactId);
    for (const link of input.payload.links) {
      db.prepare(
        `INSERT INTO artifact_links
          (id, artifact_id, target_kind, target_id, relation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        createId("link"),
        input.payload.artifactId,
        link.targetKind,
        link.targetId,
        link.relation,
        timestamp,
      );
    }

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      actorKind: input.payload.source === "runtime" ? "runtime" : "server",
      actorId: input.runtimeWorkspaceBindingId ?? null,
      kind: "artifact.projected",
      subjectKind: "artifact",
      subjectId: input.payload.artifactId,
      createdAt: timestamp,
    });

    return { artifactId: input.payload.artifactId };
  });
}

export interface RecordCommandAckInput {
  runtimeWorkspaceBindingId: string;
  workspaceId: string;
  projectId?: string | null;
  commandId: string;
  payload: RuntimeCommandAckPayload;
  acknowledgedAt?: string;
}

export function recordCommandAck(db: DatabaseSync, input: RecordCommandAckInput) {
  return withTransaction(db, () => {
    const timestamp = input.acknowledgedAt ?? nowIso();

    db.prepare(
      `UPDATE command_deliveries
       SET status = 'acked', acked_at = ?, updated_at = ?
       WHERE command_id = ? AND runtime_workspace_binding_id = ?`,
    ).run(timestamp, timestamp, input.commandId, input.runtimeWorkspaceBindingId);

    db.prepare("UPDATE commands SET status = 'acked', updated_at = ? WHERE id = ?").run(
      timestamp,
      input.commandId,
    );

    if (input.payload.invocationId) {
      upsertInvocation(db, {
        runtimeWorkspaceBindingId: input.runtimeWorkspaceBindingId,
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        runtimeInvocationId: input.payload.invocationId,
        commandId: input.commandId,
        status: "queued",
        timestamp,
      });
    }

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      actorKind: "runtime",
      actorId: input.runtimeWorkspaceBindingId,
      kind: "command.acked",
      subjectKind: "command",
      subjectId: input.commandId,
      payload: input.payload,
      createdAt: timestamp,
    });
  });
}

export interface RecordCommandRejectInput {
  runtimeWorkspaceBindingId: string;
  workspaceId: string;
  projectId?: string | null;
  commandId: string;
  payload: RuntimeCommandRejectPayload;
  rejectedAt?: string;
}

export function recordCommandReject(db: DatabaseSync, input: RecordCommandRejectInput) {
  return withTransaction(db, () => {
    const timestamp = input.rejectedAt ?? nowIso();

    db.prepare(
      `UPDATE command_deliveries
       SET status = 'rejected', rejected_at = ?, reject_code = ?, reject_message = ?, updated_at = ?
       WHERE command_id = ? AND runtime_workspace_binding_id = ?`,
    ).run(
      timestamp,
      input.payload.reasonCode,
      input.payload.message,
      timestamp,
      input.commandId,
      input.runtimeWorkspaceBindingId,
    );

    db.prepare("UPDATE commands SET status = 'rejected', updated_at = ? WHERE id = ?").run(
      timestamp,
      input.commandId,
    );

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      actorKind: "runtime",
      actorId: input.runtimeWorkspaceBindingId,
      kind: "command.rejected",
      subjectKind: "command",
      subjectId: input.commandId,
      payload: input.payload,
      createdAt: timestamp,
    });
  });
}

export interface RecordHumanResponseAckInput {
  runtimeWorkspaceBindingId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  humanRequestId: string;
  humanResponseId: string;
  payload: HumanResponseAckPayload;
  acknowledgedAt?: string;
}

export function recordHumanResponseAck(db: DatabaseSync, input: RecordHumanResponseAckInput) {
  return withTransaction(db, () => {
    const timestamp = input.acknowledgedAt ?? nowIso();
    const request = db
      .prepare(
        `SELECT workspace_id AS workspaceId, project_id AS projectId
         FROM human_requests
         WHERE id = ?`,
      )
      .get(input.humanRequestId) as { workspaceId: string; projectId: string | null } | undefined;

    db.prepare(
      "UPDATE human_responses SET status = 'acked', acked_at = ?, updated_at = ? WHERE id = ?",
    ).run(timestamp, timestamp, input.humanResponseId);

    appendEvent(db, {
      workspaceId: request?.workspaceId ?? input.workspaceId ?? null,
      projectId: request?.projectId ?? input.projectId ?? null,
      actorKind: "runtime",
      actorId: input.runtimeWorkspaceBindingId,
      kind: "human.response.acked",
      subjectKind: "human_response",
      subjectId: input.humanResponseId,
      payload: input.payload,
      createdAt: timestamp,
    });
  });
}

export interface RecordInvocationUpdateInput {
  runtimeWorkspaceBindingId: string;
  workspaceId: string;
  projectId?: string | null;
  commandId?: string | null;
  invocationId?: string | null;
  payload: InvocationUpdatePayload;
  updatedAt?: string;
}

export function recordInvocationUpdate(db: DatabaseSync, input: RecordInvocationUpdateInput) {
  return withTransaction(db, () => {
    const timestamp = input.updatedAt ?? nowIso();
    upsertInvocation(db, {
      runtimeWorkspaceBindingId: input.runtimeWorkspaceBindingId,
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      runtimeInvocationId: input.payload.runtimeInvocationId,
      commandId: input.commandId ?? null,
      taskRuntimeId: input.payload.taskRuntimeId ?? null,
      agentName: input.payload.agentName ?? null,
      status: input.payload.status,
      startedAt: input.payload.startedAt ?? null,
      completedAt: input.payload.completedAt ?? null,
      terminalReason: input.payload.terminalReason ?? null,
      payload: input.payload.payload,
      timestamp,
    });

    db.prepare(
      `INSERT INTO invocation_events
        (id, invocation_id, runtime_event_id, kind, sequence, payload_json, created_at)
       SELECT ?, id, NULL, ?, NULL, ?, ?
       FROM mirrored_invocations
       WHERE runtime_workspace_binding_id = ? AND runtime_invocation_id = ?`,
    ).run(
      createId("evt"),
      `invocation.${input.payload.status}`,
      toJson(input.payload.payload),
      timestamp,
      input.runtimeWorkspaceBindingId,
      input.payload.runtimeInvocationId,
    );

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      actorKind: "runtime",
      actorId: input.runtimeWorkspaceBindingId,
      kind: "invocation.updated",
      subjectKind: "invocation",
      subjectId: input.payload.runtimeInvocationId,
      payload: { status: input.payload.status },
      createdAt: timestamp,
    });
  });
}

export interface RecordInvocationLogChunkInput {
  runtimeWorkspaceBindingId: string;
  workspaceId: string;
  projectId?: string | null;
  commandId?: string | null;
  payload: InvocationLogChunkPayload;
  createdAt?: string;
}

export function recordInvocationLogChunk(db: DatabaseSync, input: RecordInvocationLogChunkInput) {
  return withTransaction(db, () => {
    const timestamp = input.createdAt ?? nowIso();
    const invocationId = upsertInvocation(db, {
      runtimeWorkspaceBindingId: input.runtimeWorkspaceBindingId,
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      runtimeInvocationId: input.payload.runtimeInvocationId,
      commandId: input.commandId ?? null,
      status: "running",
      timestamp,
    });

    db.prepare(
      `INSERT OR IGNORE INTO invocation_log_chunks
        (id, invocation_id, stream, sequence, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      createId("log"),
      invocationId,
      input.payload.stream,
      input.payload.sequence,
      input.payload.content,
      timestamp,
    );

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      actorKind: "runtime",
      actorId: input.runtimeWorkspaceBindingId,
      kind: "invocation.log_chunk",
      subjectKind: "invocation",
      subjectId: input.payload.runtimeInvocationId,
      payload: {
        stream: input.payload.stream,
        sequence: input.payload.sequence,
      },
      createdAt: timestamp,
    });
  });
}

interface UpsertInvocationInput {
  runtimeWorkspaceBindingId: string;
  workspaceId: string;
  projectId?: string | null;
  runtimeInvocationId: string;
  commandId?: string | null;
  taskRuntimeId?: string | null;
  agentName?: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "lost";
  startedAt?: string | null;
  completedAt?: string | null;
  terminalReason?: string | null;
  payload?: unknown;
  timestamp: string;
}

function upsertInvocation(db: DatabaseSync, input: UpsertInvocationInput) {
  const existing = db
    .prepare(
      `SELECT id FROM mirrored_invocations
       WHERE runtime_workspace_binding_id = ? AND runtime_invocation_id = ?`,
    )
    .get(input.runtimeWorkspaceBindingId, input.runtimeInvocationId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE mirrored_invocations
       SET workspace_id = ?,
           project_id = ?,
           command_id = COALESCE(?, command_id),
           task_runtime_id = COALESCE(?, task_runtime_id),
           agent_name = COALESCE(?, agent_name),
           status = ?,
           started_at = COALESCE(?, started_at),
           completed_at = COALESCE(?, completed_at),
           terminal_reason = COALESCE(?, terminal_reason),
           payload_json = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      input.workspaceId,
      input.projectId ?? null,
      input.commandId ?? null,
      input.taskRuntimeId ?? null,
      input.agentName ?? null,
      input.status,
      input.startedAt ?? null,
      input.completedAt ?? null,
      input.terminalReason ?? null,
      toJson(input.payload),
      input.timestamp,
      existing.id,
    );
    return existing.id;
  }

  const invocationId = createId("inv");
  db.prepare(
    `INSERT INTO mirrored_invocations
      (id, workspace_id, project_id, runtime_workspace_binding_id, runtime_invocation_id, command_id, task_runtime_id, agent_name, status, started_at, completed_at, terminal_reason, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invocationId,
    input.workspaceId,
    input.projectId ?? null,
    input.runtimeWorkspaceBindingId,
    input.runtimeInvocationId,
    input.commandId ?? null,
    input.taskRuntimeId ?? null,
    input.agentName ?? null,
    input.status,
    input.startedAt ?? null,
    input.completedAt ?? null,
    input.terminalReason ?? null,
    toJson(input.payload),
    input.timestamp,
    input.timestamp,
  );

  return invocationId;
}
