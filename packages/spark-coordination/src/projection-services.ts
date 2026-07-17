import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  type ArtifactProjectionPayload,
  type HumanRequestCreatedPayload,
  type HumanResponseAckPayload,
  type HumanResponseDeliverPayload,
  type HumanResponseRecordedPayload,
  type ExecutorClientProjection,
  type InvocationLogChunkPayload,
  type InvocationUpdatePayload,
  type RuntimeCommandAckPayload,
  type RuntimeCommandRejectPayload,
  type ServerCommandPayload,
  type TaskGraphSnapshotPayload,
  type WorkspaceBorrowedState,
  type WorkspaceClientProjection,
} from "@zendev-lab/spark-protocol";

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
  const sequenceRow = db
    .prepare(
      `UPDATE event_ingest_sequence
       SET value = value + 1
       WHERE singleton = 1
       RETURNING value`,
    )
    .get() as { value: number } | undefined;
  if (!sequenceRow) {
    throw new Error("Spark event ingest sequence is not initialized");
  }
  const event = {
    id: createId("evt"),
    createdAt: input.createdAt ?? nowIso(),
    sequence: sequenceRow.value,
  };

  db.prepare(
    `INSERT INTO events
      (id, ingest_sequence, workspace_id, project_id, actor_kind, actor_id, kind, subject_kind, subject_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.sequence,
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
      toJson({ sourceOfTruth: "spark-cockpit-routing" }),
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

export type CockpitWorkspaceDaemonConnectionStatus = "connected" | "disconnected";

export interface CockpitWorkspaceControlProjection {
  workspaceId: string;
  runtimeWorkspaceBindingId: string | null;
  connection: {
    status: CockpitWorkspaceDaemonConnectionStatus;
    runtimeStatus: string | null;
    runtimeName: string | null;
    lastSeenAt: string | null;
  };
  borrowed: WorkspaceBorrowedState;
  workspaceClients: WorkspaceClientProjection[];
  executor: ExecutorClientProjection;
  control: {
    mode: "full" | "snapshot_only";
    reason?: string;
    serverMutationAllowed: boolean;
    message: string;
  };
}

/**
 * Queue a server command in the Cockpit projection outbox for daemon delivery.
 *
 * Execution truth lives in spark-daemon; this table is a durable outbox flushed over
 * `server.command` runtime protocol envelopes (see command-submission.ts / runtime-ws.ts).
 */
export function queueCommandForWorkspaceOwner(db: DatabaseSync, input: QueueCommandInput) {
  return withTransaction(db, () => {
    assertWorkspaceServerMutationAllowed(db, input.workspaceId, input.payload);

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
      payload: {
        runtimeWorkspaceBindingId: owner.runtimeWorkspaceBindingId,
        command: {
          id: command.id,
          kind: input.payload.kind,
          title: input.payload.title ?? null,
          payload: input.payload,
          status: "queued",
          deliveryStatus: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      createdAt: timestamp,
    });

    return command;
  });
}

export function loadWorkspaceServerControl(
  db: DatabaseSync,
  workspaceId: string,
): CockpitWorkspaceControlProjection {
  const owner = db
    .prepare(
      `SELECT wob.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus,
              rc.last_heartbeat_at AS lastHeartbeatAt,
              rc.updated_at AS runtimeUpdatedAt
       FROM workspace_owner_bindings wob
       JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE wob.workspace_id = ? AND wob.ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as
    | {
        runtimeWorkspaceBindingId: string;
        runtimeName: string;
        runtimeStatus: string;
        lastHeartbeatAt: string | null;
        runtimeUpdatedAt: string;
      }
    | undefined;

  const snapshot = owner
    ? latestWorkspaceSnapshotPayload(db, workspaceId, owner.runtimeWorkspaceBindingId)
    : null;
  const connectionStatus: CockpitWorkspaceDaemonConnectionStatus =
    owner && (owner.runtimeStatus === "online" || owner.runtimeStatus === "draining")
      ? "connected"
      : "disconnected";
  const borrowed = normalizeBorrowedState(snapshot?.borrowed);
  const workspaceClients = Array.isArray(snapshot?.workspaceClients)
    ? snapshot.workspaceClients
    : [];
  const executor = normalizeExecutorProjection(snapshot?.executor);
  const snapshotControl = normalizeSnapshotControl(snapshot?.control);
  const derivedReason =
    connectionStatus === "disconnected"
      ? "daemon_disconnected"
      : borrowed.borrowed
        ? "workspace_borrowed"
        : undefined;
  const serverMutationAllowed =
    connectionStatus === "connected" && !borrowed.borrowed && snapshotControl.serverMutationAllowed;
  const reason = serverMutationAllowed ? undefined : (derivedReason ?? snapshotControl.reason);
  const message = serverMutationAllowed
    ? "Server commands may mutate this workspace."
    : workspaceControlMessage(reason);

  return {
    workspaceId,
    runtimeWorkspaceBindingId: owner?.runtimeWorkspaceBindingId ?? null,
    connection: {
      status: connectionStatus,
      runtimeStatus: owner?.runtimeStatus ?? null,
      runtimeName: owner?.runtimeName ?? null,
      lastSeenAt: owner ? (owner.lastHeartbeatAt ?? owner.runtimeUpdatedAt) : null,
    },
    borrowed,
    workspaceClients,
    executor,
    control: {
      mode: serverMutationAllowed ? "full" : "snapshot_only",
      ...(reason ? { reason } : {}),
      serverMutationAllowed,
      message,
    },
  };
}

function assertWorkspaceServerMutationAllowed(
  db: DatabaseSync,
  workspaceId: string,
  payload: ServerCommandPayload,
): void {
  if (!isServerWorkspaceMutation(payload.kind)) return;
  const control = loadWorkspaceServerControl(db, workspaceId);
  if (control.control.serverMutationAllowed) return;
  throw new Error(control.control.message);
}

function isServerWorkspaceMutation(kind: ServerCommandPayload["kind"]): boolean {
  return (
    kind === "project.create.request" ||
    kind === "task.start.request" ||
    kind === "assignment.create.request" ||
    kind === "session.create.request" ||
    kind === "session.bind.request" ||
    kind === "session.unbind.request" ||
    kind === "session.archive.request"
  );
}

function latestWorkspaceSnapshotPayload(
  db: DatabaseSync,
  workspaceId: string,
  runtimeWorkspaceBindingId: string,
): Partial<{
  borrowed: WorkspaceBorrowedState;
  workspaceClients: WorkspaceClientProjection[];
  executor: ExecutorClientProjection;
  control: { mode: "full" | "snapshot_only"; reason?: string; serverMutationAllowed: boolean };
}> | null {
  const row = db
    .prepare(
      `SELECT payload_json AS payloadJson
       FROM events
       WHERE workspace_id = ?
         AND actor_id = ?
         AND kind = 'workspace.snapshot.received'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(workspaceId, runtimeWorkspaceBindingId) as { payloadJson: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payloadJson) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeBorrowedState(value: unknown): WorkspaceBorrowedState {
  if (!isRecord(value)) {
    return { borrowed: false, interactiveClientCount: 0, borrowedByClientIds: [] };
  }
  const borrowedByClientIds = Array.isArray(value.borrowedByClientIds)
    ? value.borrowedByClientIds.filter((item): item is string => typeof item === "string")
    : [];
  return {
    borrowed: value.borrowed === true,
    interactiveClientCount:
      typeof value.interactiveClientCount === "number" && value.interactiveClientCount >= 0
        ? Math.floor(value.interactiveClientCount)
        : borrowedByClientIds.length,
    borrowedByClientIds,
    ...(typeof value.since === "string" ? { since: value.since } : {}),
  };
}

function normalizeExecutorProjection(value: unknown): ExecutorClientProjection {
  if (!isRecord(value)) {
    return { state: "none", activeInvocationCount: 0, activeAgentCount: 0 };
  }
  const state =
    value.state === "starting" || value.state === "online" || value.state === "unhealthy"
      ? value.state
      : "none";
  return {
    state,
    ...(typeof value.clientId === "string" ? { clientId: value.clientId } : {}),
    activeInvocationCount: nonnegativeInteger(value.activeInvocationCount),
    activeAgentCount: nonnegativeInteger(value.activeAgentCount),
    ...(typeof value.lastSeenAt === "string" ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(typeof value.unhealthyReason === "string"
      ? { unhealthyReason: value.unhealthyReason }
      : {}),
  };
}

function normalizeSnapshotControl(value: unknown): {
  mode: "full" | "snapshot_only";
  reason?: string;
  serverMutationAllowed: boolean;
} {
  if (!isRecord(value)) {
    return { mode: "full", serverMutationAllowed: true };
  }
  const mode = value.mode === "snapshot_only" ? "snapshot_only" : "full";
  const serverMutationAllowed = value.serverMutationAllowed === true && mode === "full";
  return {
    mode,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    serverMutationAllowed,
  };
}

function workspaceControlMessage(reason: string | undefined): string {
  switch (reason) {
    case "workspace_borrowed":
      return "Workspace is borrowed by an open TUI client; server actions are snapshot-only until it releases the workspace.";
    case "daemon_disconnected":
      return "Workspace daemon is disconnected; server actions are snapshot-only until it reconnects.";
    default:
      return "Workspace is in snapshot-only mode; server actions are disabled.";
  }
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
    const existing = db
      .prepare(
        `SELECT hr.id AS humanRequestId, ii.id AS inboxItemId
         FROM human_requests hr
         JOIN inbox_items ii ON ii.human_request_id = hr.id
         WHERE hr.runtime_workspace_binding_id = ? AND hr.runtime_request_id = ?
         ORDER BY ii.created_at ASC
         LIMIT 1`,
      )
      .get(input.runtimeWorkspaceBindingId, input.runtimeRequestId) as
      | { humanRequestId: string; inboxItemId: string }
      | undefined;

    if (existing) {
      return existing;
    }

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

export interface RecordHumanResponseFromRuntimeInput {
  runtimeWorkspaceBindingId: string;
  workspaceId: string;
  humanRequestId: string;
  humanResponseId: string;
  payload: HumanResponseRecordedPayload;
  recordedAt?: string;
}

/**
 * Projects a channel/daemon answer that the runtime has already accepted. The response
 * is stored as `acked` immediately so the server never sends it back through
 * the human-response delivery outbox.
 */
export function recordHumanResponseFromRuntime(
  db: DatabaseSync,
  input: RecordHumanResponseFromRuntimeInput,
) {
  return withTransaction(db, () => {
    const existingResponse = db
      .prepare(
        `SELECT human_request_id AS humanRequestId
         FROM human_responses
         WHERE id = ?`,
      )
      .get(input.humanResponseId) as { humanRequestId: string } | undefined;

    if (existingResponse) {
      if (existingResponse.humanRequestId !== input.humanRequestId) {
        throw new Error(
          `Human response ${input.humanResponseId} belongs to another human request.`,
        );
      }
      return { humanResponseId: input.humanResponseId, replayed: true };
    }

    const request = db
      .prepare(
        `SELECT runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
                workspace_id AS workspaceId,
                project_id AS projectId,
                status
         FROM human_requests
         WHERE id = ?`,
      )
      .get(input.humanRequestId) as
      | {
          runtimeWorkspaceBindingId: string;
          workspaceId: string;
          projectId: string | null;
          status: "pending" | "answered" | "cancelled" | "archived";
        }
      | undefined;

    if (!request) {
      throw new Error(`Human request not found: ${input.humanRequestId}`);
    }
    if (
      request.runtimeWorkspaceBindingId !== input.runtimeWorkspaceBindingId ||
      request.workspaceId !== input.workspaceId
    ) {
      throw new Error(`Human request route did not match: ${input.humanRequestId}`);
    }
    if (request.status !== "pending") {
      throw new Error(`Human request is already resolved: ${input.humanRequestId}`);
    }

    const timestamp = input.recordedAt ?? nowIso();
    db.prepare(
      `INSERT INTO human_responses
        (id, human_request_id, answered_by_user_id, answer_json, status, delivery_attempt_count, acked_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'acked', 0, ?, ?, ?)`,
    ).run(
      input.humanResponseId,
      input.humanRequestId,
      toJson(input.payload),
      timestamp,
      timestamp,
      timestamp,
    );

    db.prepare("UPDATE human_requests SET status = ?, updated_at = ? WHERE id = ?").run(
      input.payload.status,
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
      actorKind: "runtime",
      actorId: input.runtimeWorkspaceBindingId,
      kind: "human.response.recorded",
      subjectKind: "human_response",
      subjectId: input.humanResponseId,
      payload: {
        humanRequestId: input.humanRequestId,
        source: input.payload.source,
        status: input.payload.status,
      },
      createdAt: timestamp,
    });

    return { humanResponseId: input.humanResponseId, replayed: false };
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
    const response = db
      .prepare(
        `SELECT hreq.workspace_id AS workspaceId,
                hreq.project_id AS projectId,
                hreq.status AS requestStatus,
                hres.answer_json AS answerJson
         FROM human_responses hres
         JOIN human_requests hreq ON hreq.id = hres.human_request_id
         WHERE hres.id = ? AND hres.human_request_id = ?`,
      )
      .get(input.humanResponseId, input.humanRequestId) as
      | {
          workspaceId: string;
          projectId: string | null;
          requestStatus: "pending" | "answered" | "cancelled" | "archived";
          answerJson: string;
        }
      | undefined;

    const outcome = input.payload.outcome ?? "accepted";

    if (outcome === "accepted" || outcome === "replayed") {
      db.prepare(
        "UPDATE human_responses SET status = 'acked', acked_at = ?, updated_at = ? WHERE id = ? AND human_request_id = ?",
      ).run(timestamp, timestamp, input.humanResponseId, input.humanRequestId);

      const answerStatus = response ? readHumanResponseStatus(response.answerJson) : undefined;
      if (answerStatus && response?.requestStatus === "pending") {
        db.prepare("UPDATE human_requests SET status = ?, updated_at = ? WHERE id = ?").run(
          answerStatus,
          timestamp,
          input.humanRequestId,
        );
        db.prepare(
          `UPDATE inbox_items
           SET status = ?, resolved_as = ?, updated_at = ?
           WHERE human_request_id = ?`,
        ).run(
          answerStatus === "answered" ? "resolved" : "archived",
          answerStatus,
          timestamp,
          input.humanRequestId,
        );
      }
    } else if (outcome === "transient") {
      db.prepare(
        "UPDATE human_responses SET status = 'delivering', updated_at = ? WHERE id = ? AND human_request_id = ?",
      ).run(timestamp, input.humanResponseId, input.humanRequestId);
    } else {
      db.prepare(
        "UPDATE human_responses SET status = 'failed', updated_at = ? WHERE id = ? AND human_request_id = ?",
      ).run(timestamp, input.humanResponseId, input.humanRequestId);

      if (
        response?.requestStatus === "pending" &&
        (outcome === "orphaned" || outcome === "unknown_request")
      ) {
        db.prepare(
          "UPDATE human_requests SET status = 'archived', updated_at = ? WHERE id = ?",
        ).run(timestamp, input.humanRequestId);
        db.prepare(
          `UPDATE inbox_items
           SET status = 'archived', resolved_as = ?, updated_at = ?
           WHERE human_request_id = ?`,
        ).run(outcome, timestamp, input.humanRequestId);
      }
    }

    appendEvent(db, {
      workspaceId: response?.workspaceId ?? input.workspaceId ?? null,
      projectId: response?.projectId ?? input.projectId ?? null,
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

function readHumanResponseStatus(
  answerJson: string,
): "answered" | "cancelled" | "archived" | undefined {
  try {
    const answer = JSON.parse(answerJson) as unknown;
    if (!isRecord(answer)) {
      return undefined;
    }
    return answer.status === "answered" ||
      answer.status === "cancelled" ||
      answer.status === "archived"
      ? answer.status
      : undefined;
  } catch {
    return undefined;
  }
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

    // Direct session turns are admitted through runtime_control_commands and get
    // their initial queued row in runtime_invocation_projections. Runtime
    // lifecycle envelopes arrive later through this legacy-compatible ingest
    // path, so keep the direct projection in sync without manufacturing rows for
    // older assignment/task invocations that have no runtime session parent.
    const sequence = input.payload.sequence ?? null;
    db.prepare(
      `UPDATE runtime_invocation_projections
       SET command_id = COALESCE(command_id, ?),
           status = ?,
           event_cursor = MAX(event_cursor, COALESCE(?, event_cursor)),
           started_at = COALESCE(?, started_at),
           completed_at = COALESCE(?, completed_at),
           terminal_reason = COALESCE(?, terminal_reason),
           payload_json = json_patch(payload_json, ?),
           updated_at = ?
       WHERE runtime_id = (
         SELECT runtime_id
         FROM runtime_workspace_bindings
         WHERE id = ?
       )
         AND runtime_invocation_id = ?
         AND (? IS NULL OR ? >= event_cursor)`,
    ).run(
      input.commandId ?? null,
      input.payload.status,
      sequence,
      input.payload.startedAt ?? null,
      input.payload.completedAt ?? null,
      input.payload.terminalReason ?? null,
      toJson(input.payload.payload),
      timestamp,
      input.runtimeWorkspaceBindingId,
      input.payload.runtimeInvocationId,
      sequence,
      sequence,
    );

    db.prepare(
      `INSERT INTO invocation_events
        (id, invocation_id, runtime_event_id, kind, sequence, payload_json, created_at)
       SELECT ?, id, NULL, ?, ?, ?, ?
       FROM mirrored_invocations
       WHERE runtime_workspace_binding_id = ? AND runtime_invocation_id = ?`,
    ).run(
      createId("evt"),
      `invocation.${input.payload.status}`,
      input.payload.sequence ?? null,
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
      payload: {
        ...input.payload,
        commandId: input.commandId ?? null,
      },
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

    const inserted = db
      .prepare(
        `INSERT INTO invocation_log_chunks
        (id, invocation_id, stream, sequence, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (invocation_id, stream, sequence) DO NOTHING`,
      )
      .run(
        createId("log"),
        invocationId,
        input.payload.stream,
        input.payload.sequence,
        input.payload.content,
        timestamp,
      );
    if (inserted.changes === 0) return;

    appendEvent(db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      actorKind: "runtime",
      actorId: input.runtimeWorkspaceBindingId,
      kind: "invocation.log_chunk",
      subjectKind: "invocation",
      subjectId: input.payload.runtimeInvocationId,
      payload: {
        ...input.payload,
        commandId: input.commandId ?? null,
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
