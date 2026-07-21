import type { DatabaseSync } from "node:sqlite";
import {
  assertCockpitMayWriteScope,
  assertDaemonOwnsScope,
  createId,
  optionalWireIdempotencyKey,
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

import { appendEvent, nowIso, toJson, withTransaction } from "./workspace.ts";

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
    assertCockpitMayWriteScope("commands");
    assertWorkspaceServerMutationAllowed(db, input.workspaceId, input.payload);

    const owner = db
      .prepare(
        `SELECT runtime_workspace_binding_id AS runtimeWorkspaceBindingId
         FROM workspace_leases
         WHERE workspace_id = ? AND ended_at IS NULL
         LIMIT 1`,
      )
      .get(input.workspaceId) as { runtimeWorkspaceBindingId: string } | undefined;

    if (!owner) {
      throw new Error(`Workspace has no active origin lease: ${input.workspaceId}`);
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
      optionalWireIdempotencyKey(input.idempotencyKey) ?? null,
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
       FROM workspace_leases wob
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
  const foreignOccupied = hasForeignInteractiveOccupancy(borrowed, workspaceClients);
  const derivedReason =
    connectionStatus === "disconnected"
      ? "daemon_disconnected"
      : foreignOccupied
        ? "workspace_borrowed"
        : undefined;
  const serverMutationAllowed =
    connectionStatus === "connected" && !foreignOccupied && snapshotControl.serverMutationAllowed;
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
    return {
      borrowed: false,
      occupied: false,
      interactiveClientCount: 0,
      borrowedByClientIds: [],
      sessions: [],
    };
  }
  const borrowedByClientIds = Array.isArray(value.borrowedByClientIds)
    ? value.borrowedByClientIds.filter((item): item is string => typeof item === "string")
    : [];
  const sessions = normalizeOccupancySessions(value.sessions, borrowedByClientIds);
  const occupied =
    value.occupied === true ||
    value.borrowed === true ||
    sessions.length > 0 ||
    borrowedByClientIds.length > 0;
  return {
    borrowed: occupied,
    occupied,
    interactiveClientCount:
      typeof value.interactiveClientCount === "number" && value.interactiveClientCount >= 0
        ? Math.floor(value.interactiveClientCount)
        : Math.max(sessions.length, borrowedByClientIds.length),
    borrowedByClientIds,
    sessions,
    ...(typeof value.since === "string" ? { since: value.since } : {}),
  };
}

function normalizeOccupancySessions(
  value: unknown,
  borrowedByClientIds: string[],
): WorkspaceBorrowedState["sessions"] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!isRecord(item)) return [];
      const clientId = typeof item.clientId === "string" ? item.clientId : null;
      const sessionId =
        typeof item.sessionId === "string" && item.sessionId.trim()
          ? item.sessionId.trim()
          : clientId;
      if (!clientId || !sessionId) return [];
      const surface =
        item.surface === "tui" || item.surface === "cockpit" || item.surface === "unknown"
          ? item.surface
          : "tui";
      const kind =
        item.kind === "interactive" || item.kind === "headless" || item.kind === "executor"
          ? item.kind
          : "interactive";
      return [
        {
          sessionId,
          clientId,
          kind,
          surface,
          ...(typeof item.displayName === "string" ? { displayName: item.displayName } : {}),
          ...(typeof item.attachedAt === "string" ? { attachedAt: item.attachedAt } : {}),
          ...(typeof item.lastSeenAt === "string" ? { lastSeenAt: item.lastSeenAt } : {}),
          ...(typeof item.leaseExpiresAt === "string"
            ? { leaseExpiresAt: item.leaseExpiresAt }
            : {}),
        },
      ];
    });
  }
  return borrowedByClientIds.map((clientId) => ({
    sessionId: clientId,
    clientId,
    kind: "interactive" as const,
    surface: "tui" as const,
  }));
}

/** Blocks Cockpit mutations when a non-cockpit interactive session holds occupancy. */
function hasForeignInteractiveOccupancy(
  borrowed: WorkspaceBorrowedState,
  workspaceClients: unknown,
): boolean {
  if (borrowed.sessions.some((session) => session.surface !== "cockpit")) return true;
  if (borrowed.sessions.length > 0) return false;
  if (!borrowed.borrowed) return false;
  if (!Array.isArray(workspaceClients)) return true;
  const interactive = workspaceClients.filter(
    (client): client is Record<string, unknown> =>
      isRecord(client) && client.kind === "interactive" && client.status === "connected",
  );
  if (interactive.length === 0) return borrowed.borrowed;
  return interactive.some((client) => client.surface !== "cockpit");
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
      return "Workspace is occupied by another interactive session; server actions are snapshot-only until it releases.";
    case "daemon_disconnected":
      return "Workspace daemon is disconnected; server actions are snapshot-only until it reconnects.";
    default:
      return "Workspace is in snapshot-only mode; server actions are disabled.";
  }
}

export function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
