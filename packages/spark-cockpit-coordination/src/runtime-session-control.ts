import type { DatabaseSync } from "node:sqlite";

import {
  createId,
  parseSparkSessionRegistryRecord,
  parseSparkSessionRegistryRecords,
  sparkSessionViewSchema,
  sparkTurnCancelResultSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  sparkTurnSubmitResultSchema,
  type RuntimeCommandResultPayload,
  type ServerCommandPayload,
  type SparkProtocolJsonValue,
  type SparkSessionRegistryRecord,
  type SparkSessionView,
  type SparkTurnCancelResult,
  type SparkTurnStatusResult,
  type SparkTurnStreamPage,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";

import {
  dispatchRuntimeControlCommands,
  requeueRuntimeControlCommand,
  RuntimeControlCommandError,
  type RuntimeControlCommandRecord,
  submitRuntimeControlCommand,
  waitForRuntimeControlCommand,
} from "./runtime-control.ts";

export interface RuntimeSessionRoute {
  runtimeId: string;
  scope: "daemon" | "workspace";
  workspaceId?: string;
  runtimeWorkspaceBindingId?: string;
}

export interface RuntimeSessionProjectionRecord {
  runtimeId: string;
  session: SparkSessionRegistryRecord;
  workspaceId?: string;
  runtimeWorkspaceBindingId?: string;
  snapshot?: SparkSessionView;
  history?: {
    totalMessages: number;
    loadedMessages: number;
    hiddenMessages: number;
  };
  projectedAt: string;
}

export async function runRuntimeSessionControlCommand(
  db: DatabaseSync,
  input: {
    route: RuntimeSessionRoute;
    sessionId?: string;
    payload: ServerCommandPayload;
    idempotencyKey?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<Record<string, SparkProtocolJsonValue>> {
  // Generate this once per logical call. In particular, never mint a new key
  // after an ambiguous result timeout: the original command may already have
  // admitted a durable invocation on the daemon.
  const idempotencyKey = input.idempotencyKey ?? createId("idem");
  const command = submitRuntimeControlCommand(db, {
    runtimeId: input.route.runtimeId,
    workspaceId: input.route.workspaceId,
    sessionId: input.sessionId,
    idempotencyKey,
    payload: { ...input.payload, scope: input.route.scope },
  });
  while (true) {
    if (input.signal?.aborted) throw input.signal.reason;
    dispatchRuntimeControlCommands(db, input.route.runtimeId);
    let terminal: RuntimeControlCommandRecord;
    try {
      terminal = await waitForRuntimeControlCommand(db, command.commandId, {
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
    } catch (error) {
      const ambiguousTurnSubmitTimeout =
        input.payload.kind === "turn.submit.request" &&
        error instanceof RuntimeControlCommandError &&
        error.reasonCode === "COMMAND_RESULT_TIMEOUT";
      if (!ambiguousTurnSubmitTimeout) throw error;
      requeueRuntimeControlCommand(db, command.commandId);
      await waitForRuntimeSubmitRetry(input.signal);
      continue;
    }
    if (terminal.status !== "succeeded" || !terminal.result) {
      const failure = terminal.result?.result;
      throw new RuntimeControlCommandError(
        typeof failure?.message === "string"
          ? failure.message
          : "Spark daemon rejected the remote session command.",
        typeof failure?.reasonCode === "string" ? failure.reasonCode : "COMMAND_FAILED",
      );
    }
    return terminal.result.result;
  }
}

async function waitForRuntimeSubmitRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  const delayMs = 25 + Math.floor(Math.random() * 26);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function runtimeSessionRouteForWorkspace(
  db: DatabaseSync,
  workspaceId: string,
): RuntimeSessionRoute {
  const row = db
    .prepare(
      `SELECT rwb.runtime_id AS runtimeId,
              rwb.id AS runtimeWorkspaceBindingId
       FROM workspace_leases wob
       JOIN runtime_workspace_bindings rwb ON rwb.id = wob.runtime_workspace_binding_id
       WHERE wob.workspace_id = ? AND wob.ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { runtimeId: string; runtimeWorkspaceBindingId: string } | undefined;
  if (!row) {
    throw new RuntimeControlCommandError(
      "Workspace has no active origin lease.",
      "WORKSPACE_LEASE_UNAVAILABLE",
    );
  }
  return { ...row, scope: "workspace", workspaceId };
}

export function listRuntimeSessionRoutes(db: DatabaseSync): RuntimeSessionRoute[] {
  const routes: RuntimeSessionRoute[] = [];
  const runtimeIds = db
    .prepare(
      `SELECT DISTINCT rc.id AS runtimeId
       FROM runtime_connections rc
       JOIN runtime_sessions rs ON rs.runtime_id = rc.id
       WHERE rc.status = 'online' AND rs.status = 'connected'
       ORDER BY rc.id`,
    )
    .all() as Array<{ runtimeId: string }>;
  for (const { runtimeId } of runtimeIds) routes.push(runtimeSessionRouteForRuntime(runtimeId));

  const workspaces = db
    .prepare(
      `SELECT wob.workspace_id AS workspaceId,
              rwb.runtime_id AS runtimeId,
              rwb.id AS runtimeWorkspaceBindingId
       FROM workspace_leases wob
       JOIN runtime_workspace_bindings rwb ON rwb.id = wob.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rwb.runtime_id
       JOIN runtime_sessions rs ON rs.runtime_id = rc.id
       WHERE wob.ended_at IS NULL
         AND rwb.status IN ('available', 'indexing', 'degraded')
         AND rc.status = 'online'
         AND rs.status = 'connected'
       GROUP BY wob.workspace_id, rwb.runtime_id, rwb.id
       ORDER BY wob.workspace_id`,
    )
    .all() as Array<{
    workspaceId: string;
    runtimeId: string;
    runtimeWorkspaceBindingId: string;
  }>;
  for (const route of workspaces) routes.push({ ...route, scope: "workspace" });
  return routes;
}

export function runtimeSessionRouteForRuntime(runtimeId: string): RuntimeSessionRoute {
  if (!runtimeId.trim()) {
    throw new RuntimeControlCommandError(
      "Daemon-global session control requires runtimeId.",
      "RUNTIME_REQUIRED",
    );
  }
  return { runtimeId: runtimeId.trim(), scope: "daemon" };
}

export function runtimeSessionRouteForSession(
  db: DatabaseSync,
  sessionId: string,
): RuntimeSessionRoute {
  const rows = db
    .prepare(
      `SELECT runtime_id AS runtimeId,
              scope,
              workspace_id AS workspaceId,
              runtime_workspace_binding_id AS runtimeWorkspaceBindingId
       FROM runtime_session_projections
       WHERE session_id = ?
       ORDER BY projected_at DESC
       LIMIT 2`,
    )
    .all(sessionId) as Array<{
    runtimeId: string;
    scope: "daemon" | "workspace";
    workspaceId: string | null;
    runtimeWorkspaceBindingId: string | null;
  }>;
  if (rows.length === 0) {
    throw new RuntimeControlCommandError("Session projection was not found.", "SESSION_NOT_FOUND");
  }
  if (rows.length > 1) {
    throw new RuntimeControlCommandError(
      "Session id is ambiguous across daemon runtimes.",
      "SESSION_ROUTE_AMBIGUOUS",
    );
  }
  const row = rows[0]!;
  if (row.scope === "workspace") {
    if (!row.workspaceId) {
      throw new RuntimeControlCommandError(
        "Workspace session projection has no workspace route.",
        "SESSION_ROUTE_MISSING",
      );
    }
    return runtimeSessionRouteForWorkspace(db, row.workspaceId);
  }
  return runtimeSessionRouteForRuntime(row.runtimeId);
}

export function listRuntimeSessionProjections(
  db: DatabaseSync,
  options: {
    runtimeId?: string;
    workspaceId?: string;
    scope?: "daemon" | "workspace";
    includeArchived?: boolean;
  } = {},
): RuntimeSessionProjectionRecord[] {
  const conditions: string[] = [];
  const values: Array<string | number> = [];
  if (options.runtimeId) {
    conditions.push("runtime_id = ?");
    values.push(options.runtimeId);
  }
  if (options.workspaceId) {
    conditions.push("workspace_id = ?");
    values.push(options.workspaceId);
  }
  if (options.scope) {
    conditions.push("scope = ?");
    values.push(options.scope);
  }
  if (!options.includeArchived) conditions.push("status != 'archived'");
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT runtime_id AS runtimeId,
              workspace_id AS workspaceId,
              runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              record_json AS recordJson,
              snapshot_json AS snapshotJson,
              snapshot_total_messages AS totalMessages,
              snapshot_loaded_messages AS loadedMessages,
              snapshot_hidden_messages AS hiddenMessages,
              projected_at AS projectedAt
       FROM runtime_session_projections
       ${where}
       ORDER BY projected_at DESC, session_id`,
    )
    .all(...values) as unknown as RuntimeSessionProjectionRow[];
  return rows.map(runtimeSessionProjectionRecord);
}

/**
 * Remove projections disproved by one authoritative daemon list.
 *
 * `candidateSessionIds` must be captured before the list starts. This keeps a
 * concurrent create/detail projection from being deleted merely because it was
 * admitted after the daemon produced the list page being reconciled.
 */
export function reconcileRuntimeSessionListProjection(
  db: DatabaseSync,
  route: RuntimeSessionRoute,
  sessions: SparkSessionRegistryRecord[],
  options: {
    candidateSessionIds: Iterable<string>;
    includeArchived?: boolean;
  },
): void {
  const authoritativeIds = new Set(sessions.map((session) => session.sessionId));
  const staleIds = [...new Set(options.candidateSessionIds)].filter(
    (sessionId) => !authoritativeIds.has(sessionId),
  );
  if (staleIds.length === 0) return;

  const routeCondition =
    route.scope === "workspace"
      ? "scope = 'workspace' AND workspace_id = ?"
      : "scope = 'daemon' AND workspace_id IS NULL";
  const routeValues = route.scope === "workspace" ? [route.workspaceId ?? ""] : [];
  const archivedCondition = options.includeArchived ? "" : " AND status != 'archived'";

  db.exec("BEGIN IMMEDIATE");
  try {
    const remove = db.prepare(
      `DELETE FROM runtime_session_projections
       WHERE runtime_id = ? AND session_id = ? AND ${routeCondition}${archivedCondition}`,
    );
    for (const sessionId of staleIds) {
      remove.run(route.runtimeId, sessionId, ...routeValues);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getRuntimeSessionProjection(
  db: DatabaseSync,
  sessionId: string,
): RuntimeSessionProjectionRecord | null {
  const rows = listRuntimeSessionProjectionRows(db, sessionId);
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new RuntimeControlCommandError(
      "Session id is ambiguous across daemon runtimes.",
      "SESSION_ROUTE_AMBIGUOUS",
    );
  }
  return runtimeSessionProjectionRecord(rows[0]!);
}

export function getRuntimeTurnStatusProjection(
  db: DatabaseSync,
  invocationId: string,
): SparkTurnStatusResult | null {
  const row = db
    .prepare(
      `SELECT runtime_invocation_id AS invocationId,
              session_id AS sessionId,
              status,
              event_cursor AS eventCursor,
              started_at AS startedAt,
              completed_at AS finishedAt,
              terminal_reason AS terminalReason,
              payload_json AS payloadJson,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM runtime_invocation_projections
       WHERE runtime_invocation_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(invocationId) as RuntimeInvocationProjectionRow | undefined;
  if (!row) return null;
  const payload = jsonObject(row.payloadJson);
  return sparkTurnStatusResultSchema.parse({
    invocationId: row.invocationId,
    sessionId: row.sessionId,
    status: row.status,
    eventCursor: row.eventCursor,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    cancelReason:
      typeof payload.cancelReason === "string"
        ? payload.cancelReason
        : (row.terminalReason ?? undefined),
    error: isRecord(payload.error) ? payload.error : undefined,
  });
}

export function getRuntimeTurnStreamProjection(
  db: DatabaseSync,
  invocationId: string,
  after = 0,
  limit = 100,
): SparkTurnStreamPage | null {
  const invocation = getRuntimeTurnStatusProjection(db, invocationId);
  if (!invocation) return null;
  const normalizedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT sequence, kind, payload_json AS payloadJson, created_at AS createdAt
       FROM runtime_invocation_event_projections
       WHERE runtime_invocation_id = ? AND sequence > ?
       ORDER BY sequence
       LIMIT ?`,
    )
    .all(invocationId, Math.max(0, Math.floor(after)), normalizedLimit + 1) as Array<{
    sequence: number;
    kind: string;
    payloadJson: string;
    createdAt: string;
  }>;
  const hasMore = rows.length > normalizedLimit;
  const events = rows.slice(0, normalizedLimit).map((row) => ({
    invocationId,
    sequence: Number(row.sequence),
    kind: row.kind,
    payload: jsonObject(row.payloadJson),
    createdAt: row.createdAt,
  }));
  return sparkTurnStreamPageSchema.parse({
    invocationId,
    events,
    nextCursor: events.at(-1)?.sequence ?? Math.max(0, Math.floor(after)),
    hasMore,
  });
}

export function recordRuntimeSessionControlProjection(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  payload: RuntimeCommandResultPayload,
): void {
  if (payload.status !== "succeeded") return;
  const projection = payload.projection;
  if (projection?.kind === "session.list") {
    const sessions = parseSparkSessionRegistryRecords(projection.data.sessions);
    for (const session of sessions) {
      upsertRuntimeSession(db, command, session, payload.completedAt);
    }
  } else if (projection?.kind === "session.detail") {
    const session = parseSparkSessionRegistryRecord(projection.data.session);
    upsertRuntimeSession(db, command, session, payload.completedAt);
  } else if (projection?.kind === "session.snapshot") {
    const sessionId = requireCommandSessionId(command);
    const snapshot = sparkSessionViewSchema.parse(projection.data.snapshot);
    const history = parseHistory(projection.data.history, snapshot.messages.length);
    // Cursor-addressed history pages are command results for one browser, not
    // replacements for the canonical latest-session projection. Persisting an
    // older page here makes a later navigation paint that middle window as if
    // it were the transcript tail.
    if (history.laterMessages > 0) return;
    updateRuntimeSessionSnapshot(
      db,
      command.runtimeId,
      sessionId,
      snapshot,
      history,
      payload.completedAt,
    );
  } else if (projection?.kind === "turn.status") {
    upsertRuntimeInvocation(
      db,
      command,
      sparkTurnStatusResultSchema.parse(projection.data),
      payload.completedAt,
    );
  } else if (projection?.kind === "turn.stream") {
    recordRuntimeInvocationEvents(
      db,
      command,
      sparkTurnStreamPageSchema.parse(projection.data),
      payload.completedAt,
    );
  }

  if (command.kind === "turn.submit.request") {
    const submitted = sparkTurnSubmitResultSchema.parse(payload.result);
    upsertRuntimeInvocationFromSubmit(db, command, submitted);
  } else if (command.kind === "turn.cancel.request") {
    const cancelled = sparkTurnCancelResultSchema.parse(payload.result);
    updateRuntimeInvocationCancellation(db, command, cancelled, payload.completedAt);
  }
}

function upsertRuntimeSession(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  session: SparkSessionRegistryRecord,
  projectedAt: string,
): void {
  assertSessionCommandRoute(command, session);
  db.prepare(
    `INSERT INTO runtime_session_projections
      (runtime_id, session_id, scope, workspace_id, runtime_workspace_binding_id, status,
       record_json, projected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(runtime_id, session_id) DO UPDATE SET
       scope = excluded.scope,
       workspace_id = excluded.workspace_id,
       runtime_workspace_binding_id = excluded.runtime_workspace_binding_id,
       status = excluded.status,
       record_json = excluded.record_json,
       projected_at = excluded.projected_at`,
  ).run(
    command.runtimeId,
    session.sessionId,
    command.scope,
    command.workspaceId ?? null,
    command.runtimeWorkspaceBindingId ?? null,
    session.status,
    JSON.stringify(session),
    projectedAt,
  );
}

function updateRuntimeSessionSnapshot(
  db: DatabaseSync,
  runtimeId: string,
  sessionId: string,
  snapshot: SparkSessionView,
  history: { totalMessages: number; loadedMessages: number; hiddenMessages: number },
  projectedAt: string,
): void {
  const changed = db
    .prepare(
      `UPDATE runtime_session_projections
       SET snapshot_json = ?, snapshot_total_messages = ?, snapshot_loaded_messages = ?,
           snapshot_hidden_messages = ?, projected_at = ?
       WHERE runtime_id = ? AND session_id = ?`,
    )
    .run(
      JSON.stringify(snapshot),
      history.totalMessages,
      history.loadedMessages,
      history.hiddenMessages,
      projectedAt,
      runtimeId,
      sessionId,
    );
  if (Number(changed.changes) !== 1) {
    throw new RuntimeControlCommandError(
      "Session snapshot arrived before its registry projection.",
      "SESSION_PROJECTION_MISSING",
    );
  }
}

function upsertRuntimeInvocationFromSubmit(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  submitted: SparkTurnSubmitResult,
): void {
  const sessionId = requireCommandSessionId(command);
  const observed = command.runtimeWorkspaceBindingId
    ? (db
        .prepare(
          `SELECT invocation.status,
                  invocation.started_at AS startedAt,
                  invocation.completed_at AS completedAt,
                  invocation.terminal_reason AS terminalReason,
                  invocation.payload_json AS payloadJson,
                  invocation.updated_at AS updatedAt,
                  COALESCE((
                    SELECT MAX(event.sequence)
                    FROM invocation_events event
                    WHERE event.invocation_id = invocation.id
                  ), 0) AS eventCursor
           FROM mirrored_invocations invocation
           WHERE invocation.runtime_workspace_binding_id = ?
             AND invocation.runtime_invocation_id = ?
           LIMIT 1`,
        )
        .get(command.runtimeWorkspaceBindingId, submitted.invocationId) as
        | {
            status: string;
            startedAt: string | null;
            completedAt: string | null;
            terminalReason: string | null;
            payloadJson: string;
            updatedAt: string;
            eventCursor: number;
          }
        | undefined)
    : undefined;
  db.prepare(
    `INSERT INTO runtime_invocation_projections
      (runtime_id, runtime_invocation_id, session_id, scope, workspace_id,
       runtime_workspace_binding_id, command_id, status, event_cursor, started_at,
       completed_at, terminal_reason, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(runtime_id, runtime_invocation_id) DO UPDATE SET
       command_id = COALESCE(runtime_invocation_projections.command_id, excluded.command_id),
       status = CASE
         WHEN runtime_invocation_projections.event_cursor > 0
           THEN runtime_invocation_projections.status
         ELSE excluded.status
       END,
       event_cursor = MAX(runtime_invocation_projections.event_cursor, excluded.event_cursor),
       started_at = COALESCE(runtime_invocation_projections.started_at, excluded.started_at),
       completed_at = COALESCE(runtime_invocation_projections.completed_at, excluded.completed_at),
       terminal_reason = COALESCE(runtime_invocation_projections.terminal_reason, excluded.terminal_reason),
       payload_json = CASE
         WHEN excluded.event_cursor >= runtime_invocation_projections.event_cursor
           THEN json_patch(runtime_invocation_projections.payload_json, excluded.payload_json)
         ELSE runtime_invocation_projections.payload_json
       END,
       updated_at = MAX(runtime_invocation_projections.updated_at, excluded.updated_at)`,
  ).run(
    command.runtimeId,
    submitted.invocationId,
    sessionId,
    command.scope,
    command.workspaceId ?? null,
    command.runtimeWorkspaceBindingId ?? null,
    command.commandId,
    observed?.status ?? submitted.status,
    observed?.eventCursor ?? 0,
    observed?.startedAt ?? null,
    observed?.completedAt ?? null,
    observed?.terminalReason ?? null,
    observed?.payloadJson ?? "{}",
    submitted.acceptedAt,
    observed?.updatedAt ?? submitted.acceptedAt,
  );
}

function upsertRuntimeInvocation(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  status: SparkTurnStatusResult,
  observedAt: string,
): void {
  const sessionId = status.sessionId ?? requireCommandSessionId(command);
  db.prepare(
    `INSERT INTO runtime_invocation_projections
      (runtime_id, runtime_invocation_id, session_id, scope, workspace_id,
       runtime_workspace_binding_id, command_id, status, event_cursor, started_at,
       completed_at, terminal_reason, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(runtime_id, runtime_invocation_id) DO UPDATE SET
       status = excluded.status,
       event_cursor = MAX(runtime_invocation_projections.event_cursor, excluded.event_cursor),
       started_at = COALESCE(excluded.started_at, runtime_invocation_projections.started_at),
       completed_at = COALESCE(excluded.completed_at, runtime_invocation_projections.completed_at),
       terminal_reason = COALESCE(excluded.terminal_reason, runtime_invocation_projections.terminal_reason),
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`,
  ).run(
    command.runtimeId,
    status.invocationId,
    sessionId,
    command.scope,
    command.workspaceId ?? null,
    command.runtimeWorkspaceBindingId ?? null,
    command.commandId,
    status.status,
    status.eventCursor,
    status.startedAt ?? null,
    status.finishedAt ?? null,
    status.cancelReason ?? status.error?.message ?? null,
    JSON.stringify({ cancelReason: status.cancelReason, error: status.error }),
    status.createdAt,
    observedAt,
  );
}

function recordRuntimeInvocationEvents(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  page: SparkTurnStreamPage,
  observedAt: string,
): void {
  const invocation = db
    .prepare(
      `SELECT 1 FROM runtime_invocation_projections
       WHERE runtime_id = ? AND runtime_invocation_id = ?`,
    )
    .get(command.runtimeId, page.invocationId);
  if (!invocation) {
    throw new RuntimeControlCommandError(
      "Invocation events arrived before invocation status projection.",
      "INVOCATION_PROJECTION_MISSING",
    );
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO runtime_invocation_event_projections
      (runtime_id, runtime_invocation_id, sequence, kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const event of page.events) {
    insert.run(
      command.runtimeId,
      page.invocationId,
      event.sequence,
      event.kind,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }
  db.prepare(
    `UPDATE runtime_invocation_projections
     SET event_cursor = MAX(event_cursor, ?), updated_at = ?
     WHERE runtime_id = ? AND runtime_invocation_id = ?`,
  ).run(page.nextCursor, observedAt, command.runtimeId, page.invocationId);
}

function updateRuntimeInvocationCancellation(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  result: SparkTurnCancelResult,
  observedAt: string,
): void {
  db.prepare(
    `UPDATE runtime_invocation_projections
     SET status = ?, updated_at = ?
     WHERE runtime_id = ? AND runtime_invocation_id = ?`,
  ).run(result.status, observedAt, command.runtimeId, result.invocationId);
}

function assertSessionCommandRoute(
  command: RuntimeControlCommandRecord,
  session: SparkSessionRegistryRecord,
): void {
  if (command.scope === "daemon" && session.scope.kind !== "daemon") {
    throw new RuntimeControlCommandError(
      "Daemon command returned a workspace session.",
      "SESSION_ROUTE_MISMATCH",
    );
  }
  if (
    command.scope === "workspace" &&
    (session.scope.kind !== "workspace" || session.scope.workspaceId !== command.workspaceId)
  ) {
    throw new RuntimeControlCommandError(
      "Workspace command returned a session from another owner.",
      "SESSION_ROUTE_MISMATCH",
    );
  }
}

function requireCommandSessionId(command: RuntimeControlCommandRecord): string {
  if (!command.sessionId) {
    throw new RuntimeControlCommandError(
      "Runtime session command has no session route.",
      "SESSION_ROUTE_MISSING",
    );
  }
  return command.sessionId;
}

function parseHistory(
  value: unknown,
  loadedMessages: number,
): {
  totalMessages: number;
  loadedMessages: number;
  hiddenMessages: number;
  laterMessages: number;
} {
  if (!isRecord(value)) {
    throw new RuntimeControlCommandError(
      "Session snapshot history projection is invalid.",
      "SESSION_SNAPSHOT_INVALID",
    );
  }
  const total = integer(value.totalMessages);
  const loaded = integer(value.loadedMessages);
  const hidden = integer(value.hiddenMessages);
  // Older runtime peers did not project cursor direction. Their only emitted
  // snapshot was the latest window, so absence remains compatible with zero.
  const later = value.laterMessages === undefined ? 0 : integer(value.laterMessages);
  if (loaded !== loadedMessages || total !== loaded + hidden) {
    throw new RuntimeControlCommandError(
      "Session snapshot history counts are inconsistent.",
      "SESSION_SNAPSHOT_INVALID",
    );
  }
  return {
    totalMessages: total,
    loadedMessages: loaded,
    hiddenMessages: hidden,
    laterMessages: later,
  };
}

function runtimeSessionProjectionRecord(
  row: RuntimeSessionProjectionRow,
): RuntimeSessionProjectionRecord {
  const session = parseSparkSessionRegistryRecord(JSON.parse(row.recordJson));
  const snapshot = row.snapshotJson
    ? sparkSessionViewSchema.parse(JSON.parse(row.snapshotJson))
    : undefined;
  return {
    runtimeId: row.runtimeId,
    session,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ...(row.runtimeWorkspaceBindingId
      ? { runtimeWorkspaceBindingId: row.runtimeWorkspaceBindingId }
      : {}),
    ...(snapshot
      ? {
          snapshot,
          history: {
            totalMessages: Number(row.totalMessages),
            loadedMessages: Number(row.loadedMessages),
            hiddenMessages: Number(row.hiddenMessages),
          },
        }
      : {}),
    projectedAt: row.projectedAt,
  };
}

function listRuntimeSessionProjectionRows(
  db: DatabaseSync,
  sessionId: string,
): RuntimeSessionProjectionRow[] {
  return db
    .prepare(
      `SELECT runtime_id AS runtimeId,
              workspace_id AS workspaceId,
              runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              record_json AS recordJson,
              snapshot_json AS snapshotJson,
              snapshot_total_messages AS totalMessages,
              snapshot_loaded_messages AS loadedMessages,
              snapshot_hidden_messages AS hiddenMessages,
              projected_at AS projectedAt
       FROM runtime_session_projections
       WHERE session_id = ?
       ORDER BY projected_at DESC
       LIMIT 2`,
    )
    .all(sessionId) as unknown as RuntimeSessionProjectionRow[];
}

function jsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RuntimeControlCommandError(
      "Runtime projection integer is invalid.",
      "RUNTIME_PROJECTION_INVALID",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RuntimeSessionProjectionRow {
  runtimeId: string;
  workspaceId: string | null;
  runtimeWorkspaceBindingId: string | null;
  recordJson: string;
  snapshotJson: string | null;
  totalMessages: number;
  loadedMessages: number;
  hiddenMessages: number;
  projectedAt: string;
}

interface RuntimeInvocationProjectionRow {
  invocationId: string;
  sessionId: string;
  status: string;
  eventCursor: number;
  startedAt: string | null;
  finishedAt: string | null;
  terminalReason: string | null;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
}
