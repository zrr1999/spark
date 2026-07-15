import { createId } from "@zendev-lab/spark-protocol";
import { appendEvent } from "./projection-services";
import type { DatabaseSync } from "node:sqlite";

export const runtimeHeartbeatIntervalMs = 15_000;
export const runtimeStaleAfterMs = 45_000;
/** Absolute age after which a still-running mirrored invocation is marked lost. */
export const invocationStaleAfterMs = 35 * 60_000;
/** When the owning runtime is offline, mark running invocations lost sooner. */
export const invocationOfflineStaleAfterMs = 2 * 60_000;

export interface SweepStaleRuntimeConnectionsOptions {
  now?: Date;
  staleAfterMs?: number;
}

export interface SweepStaleRuntimeConnectionsResult {
  staleRuntimeIds: string[];
  staleSessionCount: number;
}

export interface SweepStaleInvocationsOptions {
  now?: Date;
  staleAfterMs?: number;
  offlineStaleAfterMs?: number;
}

export interface SweepStaleInvocationsResult {
  lostInvocationIds: string[];
}

export interface LivenessSweepSchedulerOptions {
  intervalMs?: number;
  now?: () => Date;
}

export interface LivenessSweepResult {
  runtimeConnections: SweepStaleRuntimeConnectionsResult;
  invocations: SweepStaleInvocationsResult;
}

/**
 * Own liveness maintenance once per server process instead of once per SSE
 * client. Event polling remains connection-local; only the mutating sweeps are
 * gated here.
 */
export function createLivenessSweepScheduler(
  options: LivenessSweepSchedulerOptions = {},
): (db: DatabaseSync) => LivenessSweepResult | null {
  const intervalMs = options.intervalMs ?? runtimeHeartbeatIntervalMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("liveness sweep interval must be a positive finite number");
  }
  let nextSweepAt = Number.NEGATIVE_INFINITY;

  return (db) => {
    const now = options.now?.() ?? new Date();
    if (now.getTime() < nextSweepAt) return null;
    nextSweepAt = now.getTime() + intervalMs;
    try {
      return {
        runtimeConnections: sweepStaleRuntimeConnections(db, { now }),
        invocations: sweepStaleInvocations(db, { now }),
      };
    } catch (error) {
      nextSweepAt = now.getTime();
      throw error;
    }
  };
}

export function sweepStaleRuntimeConnections(
  db: DatabaseSync,
  options: SweepStaleRuntimeConnectionsOptions = {},
): SweepStaleRuntimeConnectionsResult {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? runtimeStaleAfterMs;
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - staleAfterMs).toISOString();
  const staleRuntimes = db
    .prepare(
      `SELECT id, last_heartbeat_at AS lastHeartbeatAt
       FROM runtime_connections
       WHERE status = 'online'
         AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)`,
    )
    .all(staleBefore) as Array<{ id: string; lastHeartbeatAt: string | null }>;

  if (staleRuntimes.length === 0) {
    return { staleRuntimeIds: [], staleSessionCount: 0 };
  }

  let staleSessionCount = 0;
  db.exec("BEGIN");
  try {
    for (const runtime of staleRuntimes) {
      db.prepare(
        "UPDATE runtime_connections SET status = 'offline', updated_at = ? WHERE id = ?",
      ).run(nowIso, runtime.id);

      const sessionUpdate = db
        .prepare(
          `UPDATE runtime_sessions
           SET status = 'stale', closed_at = ?, close_reason = 'heartbeat_stale'
           WHERE runtime_id = ? AND status = 'connected'`,
        )
        .run(nowIso, runtime.id);
      staleSessionCount += Number(sessionUpdate.changes ?? 0);

      appendEvent(db, {
        actorKind: "server",
        kind: "runtime.offline",
        subjectKind: "runtime",
        subjectId: runtime.id,
        payload: {
          reason: "heartbeat_stale",
          staleAfterMs,
          lastHeartbeatAt: runtime.lastHeartbeatAt,
        },
        createdAt: nowIso,
      });
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    staleRuntimeIds: staleRuntimes.map((runtime) => runtime.id),
    staleSessionCount,
  };
}

/**
 * Fail-open for Cockpit projections: if a mirrored invocation stays `queued`/`running`
 * after the daemon timeout window (or after the runtime goes offline), mark it `lost`
 * so chat UI does not spin forever.
 */
export function sweepStaleInvocations(
  db: DatabaseSync,
  options: SweepStaleInvocationsOptions = {},
): SweepStaleInvocationsResult {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const absoluteBefore = new Date(
    now.getTime() - (options.staleAfterMs ?? invocationStaleAfterMs),
  ).toISOString();
  const offlineBefore = new Date(
    now.getTime() - (options.offlineStaleAfterMs ?? invocationOfflineStaleAfterMs),
  ).toISOString();

  const staleRows = db
    .prepare(
      `SELECT mi.id,
              mi.runtime_invocation_id AS runtimeInvocationId,
              mi.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              mi.workspace_id AS workspaceId,
              mi.project_id AS projectId,
              mi.command_id AS commandId,
              mi.task_runtime_id AS taskRuntimeId,
              mi.agent_name AS agentName,
              mi.status,
              mi.updated_at AS updatedAt,
              rc.status AS runtimeStatus
       FROM mirrored_invocations mi
       JOIN runtime_workspace_bindings rwb ON rwb.id = mi.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rwb.runtime_id
       WHERE mi.status IN ('queued', 'running')
         AND (
           mi.updated_at < ?
           OR (rc.status = 'offline' AND mi.updated_at < ?)
         )`,
    )
    .all(absoluteBefore, offlineBefore) as Array<{
    id: string;
    runtimeInvocationId: string;
    runtimeWorkspaceBindingId: string;
    workspaceId: string;
    projectId: string | null;
    commandId: string | null;
    taskRuntimeId: string | null;
    agentName: string | null;
    status: string;
    updatedAt: string;
    runtimeStatus: string;
  }>;

  if (staleRows.length === 0) {
    return { lostInvocationIds: [] };
  }

  db.exec("BEGIN");
  try {
    for (const row of staleRows) {
      const reason =
        row.runtimeStatus === "offline" ? "runtime_offline_stale" : "invocation_projection_stale";
      db.prepare(
        `UPDATE mirrored_invocations
         SET status = 'lost',
             completed_at = ?,
             terminal_reason = ?,
             updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      ).run(nowIso, reason, nowIso, row.id);

      db.prepare(
        `INSERT INTO invocation_events
          (id, invocation_id, runtime_event_id, kind, sequence, payload_json, created_at)
         VALUES (?, ?, NULL, 'invocation.lost', NULL, ?, ?)`,
      ).run(
        createId("evt"),
        row.id,
        JSON.stringify({ reason, previousStatus: row.status }),
        nowIso,
      );

      appendEvent(db, {
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        actorKind: "server",
        actorId: row.runtimeWorkspaceBindingId,
        kind: "invocation.updated",
        subjectKind: "invocation",
        subjectId: row.runtimeInvocationId,
        payload: {
          runtimeInvocationId: row.runtimeInvocationId,
          status: "lost",
          completedAt: nowIso,
          terminalReason: reason,
          taskRuntimeId: row.taskRuntimeId,
          agentName: row.agentName,
          commandId: row.commandId,
        },
        createdAt: nowIso,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { lostInvocationIds: staleRows.map((row) => row.id) };
}
