import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  parseSparkChannelControlSnapshot,
  parseSparkModelControlSnapshot,
  runtimeEphemeralSecretResultPayloadSchema,
  sparkProtocolJsonObjectSchema,
  type RuntimeCommandResultPayload,
  type RuntimeEphemeralSecretRequestPayload,
  type RuntimeEphemeralSecretResultPayload,
  type ServerEphemeralSecretRequestEnvelope,
  type ServerCommandPayload,
  type SparkChannelControlSnapshot,
  type SparkModelControlSnapshot,
  type SparkProtocolJsonValue,
} from "@zendev-lab/spark-protocol";
import {
  dispatchRuntimeControlCommands,
  RuntimeControlCommandError,
  submitRuntimeControlCommand,
  waitForRuntimeControlCommand,
  type RuntimeControlCommandRecord,
} from "./runtime-control.ts";
import {
  runtimeSessionRouteForRuntime,
  runtimeSessionRouteForSession,
  runtimeSessionRouteForWorkspace,
  type RuntimeSessionRoute,
} from "./runtime-session-control.ts";

export interface RuntimeEphemeralSecretRequestContext {
  actorUserId: string;
  browserRequestId: string;
  csrfVerified: true;
  pageProtocol: "https:";
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RuntimeEphemeralSecretDispatchInput {
  envelope: ServerEphemeralSecretRequestEnvelope;
  resolve(result: RuntimeEphemeralSecretResultPayload): void;
  reject(error: unknown): void;
}

type EphemeralSecretDispatcher = (input: RuntimeEphemeralSecretDispatchInput) => () => void;

const ephemeralDispatchers = new WeakMap<
  DatabaseSync,
  Map<string, Set<EphemeralSecretDispatcher>>
>();

export function registerRuntimeEphemeralSecretDispatcher(
  db: DatabaseSync,
  runtimeId: string,
  dispatch: EphemeralSecretDispatcher,
): () => void {
  const byRuntime = ephemeralDispatchers.get(db) ?? new Map();
  ephemeralDispatchers.set(db, byRuntime);
  const dispatchers = byRuntime.get(runtimeId) ?? new Set();
  byRuntime.set(runtimeId, dispatchers);
  dispatchers.add(dispatch);
  return () => {
    dispatchers.delete(dispatch);
    if (dispatchers.size === 0) byRuntime.delete(runtimeId);
    if (byRuntime.size === 0) ephemeralDispatchers.delete(db);
  };
}

export async function runRuntimeModelChannelControlCommand(
  db: DatabaseSync,
  input: {
    route: RuntimeSessionRoute;
    sessionId?: string;
    payload: ServerCommandPayload;
    requestedByUserId?: string;
    idempotencyKey?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<Record<string, SparkProtocolJsonValue>> {
  const command = submitRuntimeControlCommand(db, {
    runtimeId: input.route.runtimeId,
    workspaceId: input.route.workspaceId,
    sessionId: input.sessionId,
    requestedByUserId: input.requestedByUserId,
    idempotencyKey: input.idempotencyKey ?? createId("idem"),
    payload: { ...input.payload, scope: input.route.scope },
  });
  dispatchRuntimeControlCommands(db, input.route.runtimeId);
  const terminal = await waitForRuntimeControlCommand(db, command.commandId, {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (terminal.status !== "succeeded" || !terminal.result) {
    const failure = terminal.result?.result;
    throw new RuntimeControlCommandError(
      typeof failure?.message === "string"
        ? failure.message
        : "Spark daemon rejected the remote model or channel command.",
      typeof failure?.reasonCode === "string" ? failure.reasonCode : "COMMAND_FAILED",
    );
  }
  return terminal.result.result;
}

export async function runRuntimeEphemeralSecretRequest(
  db: DatabaseSync,
  input: {
    route: RuntimeSessionRoute;
    request: RuntimeEphemeralSecretRequestPayload;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  },
): Promise<RuntimeEphemeralSecretResultPayload> {
  if (input.context.pageProtocol !== "https:") {
    throw new RuntimeControlCommandError(
      "Secret operations require an HTTPS Cockpit page.",
      "SECRET_HTTPS_REQUIRED",
    );
  }
  if (!input.context.actorUserId.trim()) {
    throw new RuntimeControlCommandError(
      "Secret operations require an authenticated Cockpit owner.",
      "SECRET_OWNER_REQUIRED",
    );
  }
  if (!input.context.csrfVerified || !input.context.browserRequestId.trim()) {
    throw new RuntimeControlCommandError(
      "Secret operations require verified browser request correlation.",
      "SECRET_CSRF_REQUIRED",
    );
  }
  assertEphemeralRoute(input.route, input.request);
  const dispatchers = ephemeralDispatchers.get(db)?.get(input.route.runtimeId);
  if (!dispatchers || dispatchers.size !== 1) {
    throw new RuntimeControlCommandError(
      "The selected Spark daemon has no unique secure runtime connection.",
      "SECRET_RUNTIME_UNAVAILABLE",
    );
  }

  const requestId = input.requestId ?? createId("eph");
  const createdAt = new Date().toISOString();
  insertSecretAudit(db, {
    requestId,
    route: input.route,
    actorUserId: input.context.actorUserId,
    browserRequestId: input.context.browserRequestId,
    operation: input.request.operation,
    createdAt,
  });
  const timeoutMs = Math.max(1, Math.min(60_000, input.context.timeoutMs ?? 15_000));
  const envelope: ServerEphemeralSecretRequestEnvelope = {
    protocolVersion: "spark.runtime.v1alpha1",
    messageId: createId("msg"),
    type: "server.ephemeral_secret.request",
    sentAt: createdAt,
    runtimeId: input.route.runtimeId,
    ...(input.route.workspaceId ? { workspaceId: input.route.workspaceId } : {}),
    ...(input.route.runtimeWorkspaceBindingId
      ? { workspaceBindingId: input.route.runtimeWorkspaceBindingId }
      : {}),
    ephemeralRequestId: requestId,
    actorUserId: input.context.actorUserId,
    browserRequestId: input.context.browserRequestId,
    csrfVerified: true,
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    payload: input.request,
  };

  const dispatcher = [...dispatchers][0]!;
  try {
    const result = await waitForEphemeralResult(dispatcher, envelope, {
      timeoutMs,
      signal: input.context.signal,
    });
    updateSecretAudit(db, requestId, result.status === "succeeded" ? "succeeded" : "failed");
    if (result.status !== "succeeded") {
      throw new RuntimeControlCommandError(
        result.message ?? "Spark daemon rejected the secret operation.",
        result.reasonCode ?? "SECRET_OPERATION_FAILED",
      );
    }
    return result;
  } catch (error) {
    if (error instanceof RuntimeControlCommandError && error.reasonCode === "SECRET_TIMEOUT") {
      updateSecretAudit(db, requestId, "timed_out");
    } else if (
      error instanceof RuntimeControlCommandError &&
      error.reasonCode === "SECRET_RUNTIME_DISCONNECTED"
    ) {
      updateSecretAudit(db, requestId, "disconnected");
    } else {
      updateSecretAudit(db, requestId, "failed");
    }
    throw error;
  }
}

export function recordRuntimeEphemeralSecretProjection(
  db: DatabaseSync,
  input: {
    runtimeId: string;
    runtimeWorkspaceBindingId?: string;
    result: RuntimeEphemeralSecretResultPayload;
  },
): void {
  if (input.result.status !== "succeeded" || !input.result.result) return;
  if (input.result.operation === "provider.auth.api_key.set") {
    upsertModelProjection(
      db,
      input.runtimeId,
      parseSparkModelControlSnapshot(input.result.result),
      input.result.completedAt,
    );
  } else if (input.result.operation === "channel.configure") {
    if (!input.runtimeWorkspaceBindingId) {
      throw new RuntimeControlCommandError(
        "Channel secret result omitted its workspace owner route.",
        "CHANNEL_ROUTE_MISMATCH",
      );
    }
    upsertChannelProjection(
      db,
      input.runtimeId,
      input.runtimeWorkspaceBindingId,
      parseSparkChannelControlSnapshot(input.result.result),
      input.result.completedAt,
    );
  }
}

export function recordRuntimeModelChannelProjection(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  payload: RuntimeCommandResultPayload,
): void {
  if (payload.status !== "succeeded" || !payload.projection) return;
  if (payload.projection.kind === "model.catalog") {
    upsertModelProjection(
      db,
      command.runtimeId,
      parseSparkModelControlSnapshot(payload.projection.data),
      payload.completedAt,
    );
  } else if (payload.projection.kind === "channel.status") {
    const snapshot = parseSparkChannelControlSnapshot(payload.projection.data);
    if (
      command.scope !== "workspace" ||
      command.workspaceId !== snapshot.workspaceId ||
      !command.runtimeWorkspaceBindingId
    ) {
      throw new RuntimeControlCommandError(
        "Channel projection did not match its workspace owner route.",
        "CHANNEL_ROUTE_MISMATCH",
      );
    }
    upsertChannelProjection(
      db,
      command.runtimeId,
      command.runtimeWorkspaceBindingId,
      snapshot,
      payload.completedAt,
    );
  }
}

export function getRuntimeModelControlProjection(
  db: DatabaseSync,
  runtimeId: string,
): SparkModelControlSnapshot | null {
  const row = db
    .prepare(
      "SELECT snapshot_json AS snapshotJson FROM runtime_model_control_projections WHERE runtime_id = ?",
    )
    .get(runtimeId) as { snapshotJson: string } | undefined;
  return row ? parseSparkModelControlSnapshot(JSON.parse(row.snapshotJson)) : null;
}

export function getRuntimeChannelControlProjection(
  db: DatabaseSync,
  workspaceId: string,
): SparkChannelControlSnapshot | null {
  const rows = db
    .prepare(
      `SELECT snapshot_json AS snapshotJson
       FROM runtime_channel_control_projections
       WHERE workspace_id = ?
       ORDER BY projected_at DESC
       LIMIT 2`,
    )
    .all(workspaceId) as Array<{ snapshotJson: string }>;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new RuntimeControlCommandError(
      "Channel projection is ambiguous across runtimes.",
      "CHANNEL_ROUTE_AMBIGUOUS",
    );
  }
  return parseSparkChannelControlSnapshot(JSON.parse(rows[0]!.snapshotJson));
}

export function runtimeModelRouteForRuntime(runtimeId: string): RuntimeSessionRoute {
  return runtimeSessionRouteForRuntime(runtimeId);
}

export function runtimeModelRouteForSession(
  db: DatabaseSync,
  sessionId: string,
): RuntimeSessionRoute {
  return runtimeSessionRouteForSession(db, sessionId);
}

export function runtimeModelRouteForWorkspace(
  db: DatabaseSync,
  workspaceId: string,
): RuntimeSessionRoute {
  return runtimeSessionRouteForWorkspace(db, workspaceId);
}

export function runtimeChannelRouteForWorkspace(
  db: DatabaseSync,
  workspaceId: string,
): RuntimeSessionRoute {
  return runtimeSessionRouteForWorkspace(db, workspaceId);
}

function waitForEphemeralResult(
  dispatcher: EphemeralSecretDispatcher,
  envelope: ServerEphemeralSecretRequestEnvelope,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<RuntimeEphemeralSecretResultPayload> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (value: RuntimeEphemeralSecretResultPayload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(runtimeEphemeralSecretResultPayloadSchema.parse(value));
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    let cancelDispatch = () => {};
    const timeout = setTimeout(
      () =>
        finishReject(
          new RuntimeControlCommandError(
            "Secret request timed out and will not be retried.",
            "SECRET_TIMEOUT",
          ),
        ),
      options.timeoutMs,
    );
    const onAbort = () => finishReject(options.signal?.reason);
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      cancelDispatch();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      cancelDispatch = dispatcher({ envelope, resolve: finishResolve, reject: finishReject });
      if (settled) cancelDispatch();
    } catch (error) {
      finishReject(error);
    }
  });
}

function assertEphemeralRoute(
  route: RuntimeSessionRoute,
  request: RuntimeEphemeralSecretRequestPayload,
): void {
  const channel = request.operation === "channel.configure";
  if (channel) {
    if (route.scope !== "workspace" || route.workspaceId !== request.workspaceId) {
      throw new RuntimeControlCommandError(
        "Channel secret request does not match the active workspace owner.",
        "SECRET_ROUTE_INVALID",
      );
    }
  } else if (route.scope !== "daemon") {
    throw new RuntimeControlCommandError(
      "Provider secret requests must use a daemon route.",
      "SECRET_ROUTE_INVALID",
    );
  }
}

function insertSecretAudit(
  db: DatabaseSync,
  input: {
    requestId: string;
    route: RuntimeSessionRoute;
    actorUserId: string;
    browserRequestId: string;
    operation: RuntimeEphemeralSecretRequestPayload["operation"];
    createdAt: string;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO runtime_ephemeral_secret_audit
        (request_id, runtime_id, workspace_id, actor_user_id, browser_request_id,
         operation, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      input.requestId,
      input.route.runtimeId,
      input.route.workspaceId ?? null,
      input.actorUserId,
      input.browserRequestId,
      input.operation,
      input.createdAt,
    );
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) {
      throw new RuntimeControlCommandError(
        "Secret request id was already used and cannot be replayed.",
        "SECRET_REPLAY_REJECTED",
      );
    }
    throw error;
  }
}

function updateSecretAudit(
  db: DatabaseSync,
  requestId: string,
  outcome: "succeeded" | "failed" | "rejected" | "disconnected" | "timed_out",
): void {
  db.prepare(
    `UPDATE runtime_ephemeral_secret_audit
     SET outcome = ?, completed_at = ?
     WHERE request_id = ? AND outcome = 'pending'`,
  ).run(outcome, new Date().toISOString(), requestId);
}

function upsertModelProjection(
  db: DatabaseSync,
  runtimeId: string,
  snapshot: SparkModelControlSnapshot,
  projectedAt: string,
): void {
  const snapshotJson = JSON.stringify(parseSparkModelControlSnapshot(snapshot));
  db.prepare(
    `INSERT INTO runtime_model_control_projections (runtime_id, snapshot_json, projected_at)
     VALUES (?, ?, ?)
     ON CONFLICT(runtime_id) DO UPDATE SET
       snapshot_json = excluded.snapshot_json,
       projected_at = excluded.projected_at`,
  ).run(runtimeId, snapshotJson, projectedAt);
}

function upsertChannelProjection(
  db: DatabaseSync,
  runtimeId: string,
  runtimeWorkspaceBindingId: string,
  snapshot: SparkChannelControlSnapshot,
  projectedAt: string,
): void {
  const snapshotJson = JSON.stringify(parseSparkChannelControlSnapshot(snapshot));
  db.prepare(
    `INSERT INTO runtime_channel_control_projections
      (runtime_id, workspace_id, runtime_workspace_binding_id, snapshot_json, projected_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(runtime_id, workspace_id) DO UPDATE SET
       runtime_workspace_binding_id = excluded.runtime_workspace_binding_id,
       snapshot_json = excluded.snapshot_json,
       projected_at = excluded.projected_at`,
  ).run(runtimeId, snapshot.workspaceId, runtimeWorkspaceBindingId, snapshotJson, projectedAt);
}

export function publicRuntimeObject(value: unknown): Record<string, SparkProtocolJsonValue> {
  return sparkProtocolJsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}
