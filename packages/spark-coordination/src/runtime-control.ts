import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  prefixedIdSchema,
  runtimeCommandResultPayloadSchema,
  runtimeServerCommandSpecification,
  serverCommandPayloadSchema,
  type RuntimeCommandAckPayload,
  type RuntimeCommandRejectPayload,
  type RuntimeCommandResultPayload,
  type ServerCommandPayload,
} from "@zendev-lab/spark-protocol";
import { appendEvent } from "./projection-services.ts";

export type RuntimeControlCommandStatus =
  | "queued"
  | "delivered"
  | "accepted"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

export interface RuntimeControlCommandRecord {
  commandId: string;
  runtimeId: string;
  scope: "daemon" | "workspace";
  workspaceId?: string;
  runtimeWorkspaceBindingId?: string;
  projectId?: string;
  sessionId?: string;
  kind: ServerCommandPayload["kind"];
  status: RuntimeControlCommandStatus;
  attemptCount: number;
  idempotencyKey?: string;
  result?: RuntimeCommandResultPayload;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitRuntimeControlCommandInput {
  runtimeId: string;
  workspaceId?: string;
  projectId?: string | null;
  requestedByUserId?: string | null;
  sessionId?: string | null;
  idempotencyKey?: string | null;
  payload: ServerCommandPayload;
  createdAt?: string;
}

export class RuntimeControlCommandError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
  }
}

const runtimeDispatchers = new WeakMap<DatabaseSync, Map<string, Set<() => void>>>();

export function registerRuntimeControlDispatcher(
  db: DatabaseSync,
  runtimeId: string,
  dispatch: () => void,
): () => void {
  const byRuntime = runtimeDispatchers.get(db) ?? new Map<string, Set<() => void>>();
  runtimeDispatchers.set(db, byRuntime);
  const dispatchers = byRuntime.get(runtimeId) ?? new Set<() => void>();
  byRuntime.set(runtimeId, dispatchers);
  dispatchers.add(dispatch);
  return () => {
    dispatchers.delete(dispatch);
    if (dispatchers.size === 0) byRuntime.delete(runtimeId);
    if (byRuntime.size === 0) runtimeDispatchers.delete(db);
  };
}

export function dispatchRuntimeControlCommands(db: DatabaseSync, runtimeId: string): void {
  for (const dispatch of runtimeDispatchers.get(db)?.get(runtimeId) ?? []) dispatch();
}

export async function waitForRuntimeControlCommand(
  db: DatabaseSync,
  commandId: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RuntimeControlCommandRecord> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason;
    const command = requireRuntimeControlCommand(db, commandId);
    if (isTerminal(command.status)) return command;
    if (Date.now() >= deadline) {
      throw new RuntimeControlCommandError(
        "Runtime command is still pending; it remains durable and may complete after reconnect.",
        "COMMAND_RESULT_TIMEOUT",
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

export function submitRuntimeControlCommand(
  db: DatabaseSync,
  input: SubmitRuntimeControlCommandInput,
): RuntimeControlCommandRecord {
  const payload = serverCommandPayloadSchema.parse(input.payload);
  const specification = runtimeServerCommandSpecification(payload.kind);
  if (!specification) {
    throw new RuntimeControlCommandError(
      "Runtime command kind is not allowed.",
      "COMMAND_KIND_UNKNOWN",
    );
  }
  const scope = payload.scope ?? specification.scope;
  const canonicalPayloadJson = JSON.stringify({ ...payload, scope });
  const now = input.createdAt ?? new Date().toISOString();
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey && !prefixedIdSchema("idem").safeParse(idempotencyKey).success) {
    throw new RuntimeControlCommandError(
      "Runtime command idempotency key is invalid.",
      "IDEMPOTENCY_KEY_INVALID",
    );
  }

  let route: { workspaceId?: string; bindingId?: string } | undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    route = resolveRuntimeControlRoute(db, input.runtimeId, scope, input.workspaceId);
    if (idempotencyKey) {
      const existing = findRuntimeControlCommandByIdempotencyKey(
        db,
        input.runtimeId,
        idempotencyKey,
      );
      if (existing) {
        assertIdempotentCommand(db, existing, canonicalPayloadJson, {
          workspaceId: route.workspaceId,
          bindingId: route.bindingId,
          projectId: scope === "workspace" ? (input.projectId ?? undefined) : undefined,
          sessionId: input.sessionId?.trim() || undefined,
        });
        db.exec("COMMIT");
        return existing;
      }
    }

    const commandId = createId("cmd");
    db.prepare(
      `INSERT INTO runtime_control_commands
        (id, runtime_id, scope, workspace_id, runtime_workspace_binding_id, project_id, session_id,
         kind, title, payload_json, requested_by_user_id, idempotency_key, status,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      commandId,
      input.runtimeId,
      scope,
      route.workspaceId ?? null,
      route.bindingId ?? null,
      scope === "workspace" ? (input.projectId ?? null) : null,
      input.sessionId?.trim() || null,
      payload.kind,
      payload.title ?? null,
      canonicalPayloadJson,
      input.requestedByUserId ?? null,
      idempotencyKey,
      now,
      now,
    );
    appendEvent(db, {
      workspaceId: route.workspaceId ?? null,
      projectId: scope === "workspace" ? (input.projectId ?? null) : null,
      actorKind: "server",
      kind: "runtime.control.queued",
      subjectKind: "command",
      subjectId: commandId,
      payload: { runtimeId: input.runtimeId, scope, kind: payload.kind },
      createdAt: now,
    });
    db.exec("COMMIT");
    return requireRuntimeControlCommand(db, commandId);
  } catch (error) {
    db.exec("ROLLBACK");
    if (idempotencyKey) {
      const existing = findRuntimeControlCommandByIdempotencyKey(
        db,
        input.runtimeId,
        idempotencyKey,
      );
      if (existing) {
        const fallbackRoute =
          route ?? resolveRuntimeControlRoute(db, input.runtimeId, scope, input.workspaceId);
        assertIdempotentCommand(db, existing, canonicalPayloadJson, {
          workspaceId: fallbackRoute.workspaceId,
          bindingId: fallbackRoute.bindingId,
          projectId: scope === "workspace" ? (input.projectId ?? undefined) : undefined,
          sessionId: input.sessionId?.trim() || undefined,
        });
        return existing;
      }
    }
    throw error;
  }
}

export function recordRuntimeControlCommandAck(
  db: DatabaseSync,
  input: {
    runtimeId: string;
    commandId: string;
    payload: RuntimeCommandAckPayload;
    acknowledgedAt?: string;
  },
): void {
  const now = input.acknowledgedAt ?? new Date().toISOString();
  const command = requireRuntimeControlCommandForRuntime(db, input.commandId, input.runtimeId);
  if (isTerminal(command.status) || command.status === "accepted") return;
  withTransaction(db, () => {
    db.prepare(
      `UPDATE runtime_control_commands
       SET status = 'accepted', accepted_at = ?, updated_at = ?
       WHERE id = ? AND runtime_id = ?`,
    ).run(now, now, input.commandId, input.runtimeId);
    appendRuntimeControlEvent(db, command, "runtime.control.accepted", input.payload, now);
  });
}

export function recordRuntimeControlCommandReject(
  db: DatabaseSync,
  input: {
    runtimeId: string;
    commandId: string;
    payload: RuntimeCommandRejectPayload;
    rejectedAt?: string;
  },
): void {
  const now = input.rejectedAt ?? new Date().toISOString();
  const command = requireRuntimeControlCommandForRuntime(db, input.commandId, input.runtimeId);
  if (isTerminal(command.status)) return;
  withTransaction(db, () => {
    db.prepare(
      `UPDATE runtime_control_commands
       SET status = 'rejected', rejected_at = ?, reject_code = ?, reject_message = ?,
           completed_at = ?, updated_at = ?
       WHERE id = ? AND runtime_id = ?`,
    ).run(
      now,
      input.payload.reasonCode,
      input.payload.message,
      now,
      now,
      input.commandId,
      input.runtimeId,
    );
    appendRuntimeControlEvent(db, command, "runtime.control.rejected", input.payload, now);
  });
}

export function recordRuntimeControlCommandResult(
  db: DatabaseSync,
  input: {
    runtimeId: string;
    commandId: string;
    messageId: string;
    payload: RuntimeCommandResultPayload;
    project?: (command: RuntimeControlCommandRecord, payload: RuntimeCommandResultPayload) => void;
  },
): void {
  const payload = runtimeCommandResultPayloadSchema.parse(input.payload);
  const command = requireRuntimeControlCommandForRuntime(db, input.commandId, input.runtimeId);
  if (command.status === "rejected" || command.status === "cancelled") {
    throw new RuntimeControlCommandError(
      "Terminal result conflicts with the command terminal state.",
      "COMMAND_RESULT_CONFLICT",
    );
  }
  const existing = db
    .prepare(
      `SELECT result_message_id AS resultMessageId, result_json AS resultJson
       FROM runtime_control_commands WHERE id = ? AND runtime_id = ?`,
    )
    .get(input.commandId, input.runtimeId) as {
    resultMessageId: string | null;
    resultJson: string | null;
  };
  const resultJson = JSON.stringify(payload);
  if (existing.resultMessageId) {
    if (existing.resultMessageId !== input.messageId || existing.resultJson !== resultJson) {
      throw new RuntimeControlCommandError(
        "Command already has a different terminal result.",
        "COMMAND_RESULT_CONFLICT",
      );
    }
    return;
  }

  withTransaction(db, () => {
    db.prepare(
      `UPDATE runtime_control_commands
       SET status = ?, result_message_id = ?, result_json = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND runtime_id = ? AND result_message_id IS NULL`,
    ).run(
      payload.status,
      input.messageId,
      resultJson,
      payload.completedAt,
      payload.completedAt,
      input.commandId,
      input.runtimeId,
    );
    input.project?.(command, payload);
    appendRuntimeControlEvent(
      db,
      command,
      "runtime.control.result",
      { messageId: input.messageId, status: payload.status, projection: payload.projection },
      payload.completedAt,
    );
  });
}

export function recoverUnacknowledgedRuntimeControlCommands(
  db: DatabaseSync,
  runtimeId: string,
  recoveredAt = new Date().toISOString(),
): number {
  return Number(
    db
      .prepare(
        `UPDATE runtime_control_commands
         SET status = 'queued', updated_at = ?
         WHERE runtime_id = ? AND status IN ('delivered', 'accepted')`,
      )
      .run(recoveredAt, runtimeId).changes,
  );
}

/**
 * Make an ambiguous non-terminal delivery eligible for replay with the same
 * command id. The daemon receipt ledger fences duplicate execution, while a
 * late terminal result can still win this status transition.
 */
export function requeueRuntimeControlCommand(
  db: DatabaseSync,
  commandId: string,
  requeuedAt = new Date().toISOString(),
): RuntimeControlCommandRecord {
  db.prepare(
    `UPDATE runtime_control_commands
     SET status = 'queued', updated_at = ?
     WHERE id = ? AND status IN ('delivered', 'accepted')`,
  ).run(requeuedAt, commandId);
  return requireRuntimeControlCommand(db, commandId);
}

export function pendingRuntimeControlCommands(
  db: DatabaseSync,
  runtimeId: string,
  limit = 10,
): Array<{
  command: RuntimeControlCommandRecord;
  payload: ServerCommandPayload;
}> {
  const rows = db
    .prepare(
      `SELECT rcc.id
       FROM runtime_control_commands rcc
       WHERE rcc.runtime_id = ?
         AND rcc.status = 'queued'
         AND (
           rcc.scope = 'daemon'
           OR EXISTS (
             SELECT 1
             FROM workspace_owner_bindings wob
             JOIN runtime_workspace_bindings rwb
               ON rwb.id = wob.runtime_workspace_binding_id
             WHERE wob.workspace_id = rcc.workspace_id
               AND wob.runtime_workspace_binding_id = rcc.runtime_workspace_binding_id
               AND wob.ended_at IS NULL
               AND rwb.runtime_id = rcc.runtime_id
           )
         )
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(runtimeId, Math.max(1, Math.min(100, Math.floor(limit)))) as Array<{ id: string }>;
  return rows.map((row) => {
    const command = requireRuntimeControlCommand(db, row.id);
    const payloadRow = db
      .prepare("SELECT payload_json AS payloadJson FROM runtime_control_commands WHERE id = ?")
      .get(row.id) as { payloadJson: string };
    return {
      command,
      payload: serverCommandPayloadSchema.parse(JSON.parse(payloadRow.payloadJson)),
    };
  });
}

export function markRuntimeControlCommandDeliveryAttempt(
  db: DatabaseSync,
  input: { commandId: string; runtimeId: string; sent: boolean; attemptedAt?: string },
): void {
  const now = input.attemptedAt ?? new Date().toISOString();
  db.prepare(
    `UPDATE runtime_control_commands
     SET status = CASE WHEN ? = 1 THEN 'delivered' ELSE status END,
         attempt_count = attempt_count + 1,
         last_attempt_at = ?, updated_at = ?
     WHERE id = ? AND runtime_id = ? AND status = 'queued'`,
  ).run(input.sent ? 1 : 0, now, now, input.commandId, input.runtimeId);
}

export function requireRuntimeControlCommand(
  db: DatabaseSync,
  commandId: string,
): RuntimeControlCommandRecord {
  const row = db
    .prepare(
      `SELECT id, runtime_id AS runtimeId, scope, workspace_id AS workspaceId,
              runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              project_id AS projectId, session_id AS sessionId, kind, status,
              attempt_count AS attemptCount, idempotency_key AS idempotencyKey,
              result_json AS resultJson,
              created_at AS createdAt, updated_at AS updatedAt
       FROM runtime_control_commands WHERE id = ?`,
    )
    .get(commandId) as RuntimeControlCommandRow | undefined;
  if (!row) throw new RuntimeControlCommandError("Unknown runtime command.", "COMMAND_UNKNOWN");
  return runtimeControlCommandRecord(row);
}

function resolveRuntimeControlRoute(
  db: DatabaseSync,
  runtimeId: string,
  scope: "daemon" | "workspace",
  workspaceId: string | undefined,
): { workspaceId?: string; bindingId?: string } {
  if (!db.prepare("SELECT 1 FROM runtime_connections WHERE id = ?").get(runtimeId)) {
    throw new RuntimeControlCommandError("Runtime is not registered.", "RUNTIME_UNKNOWN");
  }
  if (scope === "daemon") {
    if (workspaceId) {
      throw new RuntimeControlCommandError(
        "Daemon-scoped commands must not include a workspace.",
        "COMMAND_SCOPE_INVALID",
      );
    }
    return {};
  }
  if (!workspaceId) {
    throw new RuntimeControlCommandError(
      "Workspace-scoped commands require a workspace.",
      "WORKSPACE_REQUIRED",
    );
  }
  const owner = db
    .prepare(
      `SELECT wob.runtime_workspace_binding_id AS bindingId
       FROM workspace_owner_bindings wob
       JOIN runtime_workspace_bindings rwb ON rwb.id = wob.runtime_workspace_binding_id
       WHERE wob.workspace_id = ? AND wob.ended_at IS NULL AND rwb.runtime_id = ?
       LIMIT 1`,
    )
    .get(workspaceId, runtimeId) as { bindingId: string } | undefined;
  if (!owner) {
    throw new RuntimeControlCommandError(
      "Workspace is not owned by this runtime.",
      "WORKSPACE_ROUTE_INVALID",
    );
  }
  return { workspaceId, bindingId: owner.bindingId };
}

function requireRuntimeControlCommandForRuntime(
  db: DatabaseSync,
  commandId: string,
  runtimeId: string,
): RuntimeControlCommandRecord {
  const command = requireRuntimeControlCommand(db, commandId);
  if (command.runtimeId !== runtimeId) {
    throw new RuntimeControlCommandError(
      "Runtime command belongs to a different runtime.",
      "RUNTIME_ID_MISMATCH",
    );
  }
  return command;
}

function findRuntimeControlCommandByIdempotencyKey(
  db: DatabaseSync,
  runtimeId: string,
  idempotencyKey: string,
): RuntimeControlCommandRecord | undefined {
  const row = db
    .prepare("SELECT id FROM runtime_control_commands WHERE runtime_id = ? AND idempotency_key = ?")
    .get(runtimeId, idempotencyKey) as { id: string } | undefined;
  return row ? requireRuntimeControlCommand(db, row.id) : undefined;
}

function assertIdempotentCommand(
  db: DatabaseSync,
  existing: RuntimeControlCommandRecord,
  canonicalPayloadJson: string,
  route: {
    workspaceId?: string;
    bindingId?: string;
    projectId?: string;
    sessionId?: string;
  },
): void {
  const stored = db
    .prepare("SELECT payload_json AS payloadJson FROM runtime_control_commands WHERE id = ?")
    .get(existing.commandId) as { payloadJson: string };
  if (
    existing.workspaceId !== route.workspaceId ||
    existing.runtimeWorkspaceBindingId !== route.bindingId ||
    existing.projectId !== route.projectId ||
    existing.sessionId !== route.sessionId ||
    stored.payloadJson !== canonicalPayloadJson
  ) {
    throw new RuntimeControlCommandError(
      "Idempotency key is already bound to another command.",
      "IDEMPOTENCY_CONFLICT",
    );
  }
}

function appendRuntimeControlEvent(
  db: DatabaseSync,
  command: RuntimeControlCommandRecord,
  kind: string,
  payload: unknown,
  createdAt: string,
): void {
  appendEvent(db, {
    workspaceId: command.workspaceId ?? null,
    projectId: command.projectId ?? null,
    actorKind: "runtime",
    actorId: command.runtimeWorkspaceBindingId ?? command.runtimeId,
    kind,
    subjectKind: "command",
    subjectId: command.commandId,
    payload,
    createdAt,
  });
}

function runtimeControlCommandRecord(row: RuntimeControlCommandRow): RuntimeControlCommandRecord {
  return {
    commandId: row.id,
    runtimeId: row.runtimeId,
    scope: row.scope,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ...(row.runtimeWorkspaceBindingId
      ? { runtimeWorkspaceBindingId: row.runtimeWorkspaceBindingId }
      : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    kind: row.kind,
    status: row.status,
    attemptCount: Number(row.attemptCount),
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    ...(row.resultJson
      ? { result: runtimeCommandResultPayloadSchema.parse(JSON.parse(row.resultJson)) }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isTerminal(status: RuntimeControlCommandStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "rejected" || status === "cancelled"
  );
}

function withTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface RuntimeControlCommandRow {
  id: string;
  runtimeId: string;
  scope: "daemon" | "workspace";
  workspaceId: string | null;
  runtimeWorkspaceBindingId: string | null;
  projectId: string | null;
  sessionId: string | null;
  kind: ServerCommandPayload["kind"];
  status: RuntimeControlCommandStatus;
  attemptCount: number;
  idempotencyKey: string | null;
  resultJson: string | null;
  createdAt: string;
  updatedAt: string;
}
