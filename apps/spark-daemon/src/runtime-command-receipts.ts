import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  runtimeCommandAckEnvelopeSchema,
  runtimeCommandResultEnvelopeSchema,
  runtimeProtocolVersion,
  runtimeServerCommandSpecification,
  serverCommandPayloadSchema,
  sparkTurnSubmitResultSchema,
  type ServerCommandEnvelope,
} from "@zendev-lab/spark-protocol";
import { assertIdempotentTurnPayloadReplay } from "./session-control.ts";
import { SparkInvocationStore } from "./store/invocations.ts";

export type RuntimeCommandReceiptClaim =
  | { kind: "new"; claimToken: string }
  | { kind: "replay"; ack?: unknown; terminal?: unknown }
  | { kind: "conflict" };

export const DEFAULT_RUNTIME_COMMAND_RECEIPT_LEASE_MS = 30_000;

export function claimRuntimeCommandReceipt(
  db: DatabaseSync,
  command: ServerCommandEnvelope,
  claimedAt = new Date().toISOString(),
  options: { leaseMs?: number } = {},
): RuntimeCommandReceiptClaim {
  const commandId = command.commandId;
  const runtimeId = command.runtimeId;
  const scope =
    command.payload.scope ?? runtimeServerCommandSpecification(command.payload.kind)?.scope;
  if (!commandId || !runtimeId || !scope) {
    throw new Error("Runtime command receipt requires a fully routed server command.");
  }
  const payloadHash = runtimeCommandPayloadHash(command);
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(
    Date.parse(claimedAt) +
      Math.max(1, Math.floor(options.leaseMs ?? DEFAULT_RUNTIME_COMMAND_RECEIPT_LEASE_MS)),
  ).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        `SELECT payload_hash AS payloadHash, kind, status,
                ack_json AS ackJson, terminal_json AS terminalJson,
                lease_expires_at AS leaseExpiresAt
         FROM runtime_command_receipts WHERE command_id = ?`,
      )
      .get(commandId) as
      | {
          payloadHash: string;
          kind: string;
          status: string;
          ackJson: string | null;
          terminalJson: string | null;
          leaseExpiresAt: string | null;
        }
      | undefined;
    if (existing) {
      db.prepare(
        `UPDATE runtime_command_receipts
         SET delivery_count = delivery_count + 1, last_seen_at = ?, updated_at = ?
         WHERE command_id = ?`,
      ).run(claimedAt, claimedAt, commandId);
      if (existing.payloadHash !== payloadHash) {
        db.exec("COMMIT");
        return { kind: "conflict" };
      }
      if (
        !existing.terminalJson &&
        existing.kind === "turn.submit.request" &&
        (existing.status === "processing" || existing.status === "accepted") &&
        (!existing.leaseExpiresAt || existing.leaseExpiresAt <= claimedAt)
      ) {
        const reclaimed = db
          .prepare(
            `UPDATE runtime_command_receipts
             SET status = 'processing', claim_token = ?, lease_expires_at = ?, updated_at = ?
             WHERE command_id = ? AND payload_hash = ? AND terminal_json IS NULL
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
          )
          .run(claimToken, leaseExpiresAt, claimedAt, commandId, payloadHash, claimedAt);
        if (Number(reclaimed.changes) > 0) {
          db.exec("COMMIT");
          return { kind: "new", claimToken };
        }
      }
      db.exec("COMMIT");
      return {
        kind: "replay",
        ...(existing.ackJson ? { ack: JSON.parse(existing.ackJson) as unknown } : {}),
        ...(existing.terminalJson
          ? { terminal: JSON.parse(existing.terminalJson) as unknown }
          : {}),
      };
    }

    db.prepare(
      `INSERT INTO runtime_command_receipts
        (command_id, runtime_id, scope, workspace_binding_id, workspace_id, project_id,
         session_id, idempotency_key, request_message_id, payload_json, claim_token,
         lease_expires_at, kind, payload_hash, status, delivery_count, first_seen_at,
         last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?, ?)`,
    ).run(
      commandId,
      runtimeId,
      scope,
      command.workspaceBindingId ?? null,
      command.workspaceId ?? null,
      command.projectId ?? null,
      command.sessionId ?? null,
      command.idempotencyKey ?? null,
      command.messageId,
      JSON.stringify(command.payload),
      claimToken,
      leaseExpiresAt,
      command.payload.kind,
      payloadHash,
      claimedAt,
      claimedAt,
      claimedAt,
      claimedAt,
    );
    db.exec("COMMIT");
    return { kind: "new", claimToken };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recordRuntimeCommandAck(
  db: DatabaseSync,
  commandId: string,
  envelope: unknown,
  recordedAt = new Date().toISOString(),
  claimToken?: string,
): boolean {
  const serialized = JSON.stringify(envelope);
  const result = claimToken
    ? db
        .prepare(
          `UPDATE runtime_command_receipts
           SET status = 'accepted', ack_json = COALESCE(ack_json, ?), updated_at = ?
           WHERE command_id = ? AND claim_token = ? AND terminal_json IS NULL`,
        )
        .run(serialized, recordedAt, commandId, claimToken)
    : db
        .prepare(
          `UPDATE runtime_command_receipts
           SET status = 'accepted', ack_json = COALESCE(ack_json, ?), updated_at = ?
           WHERE command_id = ? AND terminal_json IS NULL`,
        )
        .run(serialized, recordedAt, commandId);
  return Number(result.changes) > 0;
}

export function recordRuntimeCommandTerminal(
  db: DatabaseSync,
  input: {
    commandId: string;
    status: "succeeded" | "failed" | "rejected";
    envelope: unknown;
    recordedAt?: string;
    claimToken?: string;
  },
): boolean {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const serialized = JSON.stringify(input.envelope);
  const existing = db
    .prepare(
      `SELECT claim_token AS claimToken, terminal_json AS terminalJson
       FROM runtime_command_receipts WHERE command_id = ?`,
    )
    .get(input.commandId) as { claimToken: string | null; terminalJson: string | null } | undefined;
  if (!existing) throw new Error(`Unknown runtime command receipt: ${input.commandId}`);
  if (input.claimToken && existing.claimToken !== input.claimToken) return false;
  if (existing.terminalJson) {
    if (existing.terminalJson !== serialized) {
      throw new Error(`RUNTIME_COMMAND_TERMINAL_CONFLICT: ${input.commandId}`);
    }
    return true;
  }
  const result = input.claimToken
    ? db
        .prepare(
          `UPDATE runtime_command_receipts
           SET status = ?, terminal_message_id = ?, terminal_json = ?, completed_at = ?,
               lease_expires_at = NULL, updated_at = ?
           WHERE command_id = ? AND claim_token = ? AND terminal_json IS NULL`,
        )
        .run(
          input.status,
          messageIdOf(input.envelope),
          serialized,
          recordedAt,
          recordedAt,
          input.commandId,
          input.claimToken,
        )
    : db
        .prepare(
          `UPDATE runtime_command_receipts
           SET status = ?, terminal_message_id = ?, terminal_json = ?, completed_at = ?,
               lease_expires_at = NULL, updated_at = ?
           WHERE command_id = ? AND terminal_json IS NULL`,
        )
        .run(
          input.status,
          messageIdOf(input.envelope),
          serialized,
          recordedAt,
          recordedAt,
          input.commandId,
        );
  return Number(result.changes) > 0;
}

export function acknowledgeRuntimeCommandTerminal(
  db: DatabaseSync,
  messageId: string,
  acknowledgedAt = new Date().toISOString(),
): boolean {
  return (
    Number(
      db
        .prepare(
          `UPDATE runtime_command_receipts
           SET terminal_acked_at = COALESCE(terminal_acked_at, ?), updated_at = ?
           WHERE terminal_message_id = ?`,
        )
        .run(acknowledgedAt, acknowledgedAt, messageId).changes,
    ) > 0
  );
}

export function recoverInterruptedRuntimeCommandReceipts(
  db: DatabaseSync,
  recoveredAt = new Date().toISOString(),
): number {
  const rows = db
    .prepare(
      `SELECT command_id AS commandId, runtime_id AS runtimeId,
              workspace_binding_id AS workspaceBindingId, workspace_id AS workspaceId,
              project_id AS projectId, session_id AS sessionId,
              idempotency_key AS idempotencyKey, request_message_id AS requestMessageId,
              payload_json AS payloadJson, kind
       FROM runtime_command_receipts
       WHERE status IN ('processing', 'accepted') AND terminal_json IS NULL`,
    )
    .all() as Array<{
    commandId: string;
    runtimeId: string;
    workspaceBindingId: string | null;
    workspaceId: string | null;
    projectId: string | null;
    sessionId: string | null;
    idempotencyKey: string | null;
    requestMessageId: string | null;
    payloadJson: string | null;
    kind: string;
  }>;
  for (const row of rows) {
    if (row.kind === "turn.submit.request" && row.idempotencyKey) {
      const invocation = new SparkInvocationStore(db).findByIdempotencyKey(row.idempotencyKey);
      if (invocation) {
        try {
          if (row.payloadJson) {
            const commandPayload = serverCommandPayloadSchema.parse(JSON.parse(row.payloadJson));
            if (commandPayload.kind !== "turn.submit.request") {
              throw new Error(`Runtime command receipt kind mismatch: ${row.commandId}`);
            }
            assertIdempotentTurnPayloadReplay(invocation, {
              payload: commandPayload.payload ?? {},
              sessionId: row.sessionId ?? undefined,
              idempotencyKey: row.idempotencyKey,
            });
          }
        } catch (error) {
          recordInterruptedCommandFailure(db, row, recoveredAt, {
            reasonCode: "IDEMPOTENCY_CONFLICT",
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        recoverTurnSubmitAdmission(
          db,
          row,
          invocation.invocationId,
          invocation.createdAt,
          recoveredAt,
        );
        continue;
      }
      // Admission did not commit. Removing only the incomplete daemon-side
      // receipt lets Cockpit redeliver the same durable command and key.
      db.prepare(
        `DELETE FROM runtime_command_receipts
         WHERE command_id = ? AND terminal_json IS NULL`,
      ).run(row.commandId);
      continue;
    }
    recordInterruptedCommandFailure(db, row, recoveredAt, {
      reasonCode: "DAEMON_RESTARTED",
      message: "Spark daemon restarted before the command reached a terminal result.",
    });
  }
  return rows.length;
}

function recordInterruptedCommandFailure(
  db: DatabaseSync,
  row: {
    commandId: string;
    runtimeId: string;
    workspaceBindingId: string | null;
    workspaceId: string | null;
    projectId: string | null;
    sessionId: string | null;
    requestMessageId: string | null;
  },
  recoveredAt: string,
  failure: { reasonCode: string; message: string },
): void {
  recordRuntimeCommandTerminal(db, {
    commandId: row.commandId,
    status: "failed",
    envelope: {
      protocolVersion: runtimeProtocolVersion,
      messageId: stableTerminalMessageId(row.commandId),
      type: "runtime.command.result",
      sentAt: recoveredAt,
      runtimeId: row.runtimeId,
      workspaceBindingId: row.workspaceBindingId ?? undefined,
      workspaceId: row.workspaceId ?? undefined,
      projectId: row.projectId ?? undefined,
      sessionId: row.sessionId ?? undefined,
      commandId: row.commandId,
      ackOf: row.requestMessageId ?? undefined,
      payload: { status: "failed", result: failure, completedAt: recoveredAt },
    },
    recordedAt: recoveredAt,
  });
}

function recoverTurnSubmitAdmission(
  db: DatabaseSync,
  row: {
    commandId: string;
    runtimeId: string;
    workspaceBindingId: string | null;
    workspaceId: string | null;
    projectId: string | null;
    sessionId: string | null;
    requestMessageId: string | null;
  },
  invocationId: string,
  acceptedAt: string,
  recoveredAt: string,
): void {
  const route = {
    runtimeId: row.runtimeId,
    workspaceBindingId: row.workspaceBindingId ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    projectId: row.projectId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    commandId: row.commandId,
    invocationId,
    ackOf: row.requestMessageId ?? undefined,
  };
  const ack = runtimeCommandAckEnvelopeSchema.parse({
    protocolVersion: runtimeProtocolVersion,
    messageId: stableReceiptMessageId(row.commandId, "ack"),
    type: "runtime.command.ack",
    sentAt: recoveredAt,
    ...route,
    payload: { accepted: true, invocationId },
  });
  const result = sparkTurnSubmitResultSchema.parse({
    invocationId,
    status: "queued",
    acceptedAt,
  });
  const terminal = runtimeCommandResultEnvelopeSchema.parse({
    protocolVersion: runtimeProtocolVersion,
    messageId: stableReceiptMessageId(row.commandId, "terminal"),
    type: "runtime.command.result",
    sentAt: recoveredAt,
    ...route,
    payload: { status: "succeeded", result, completedAt: recoveredAt },
  });
  recordRuntimeCommandAck(db, row.commandId, ack, recoveredAt);
  recordRuntimeCommandTerminal(db, {
    commandId: row.commandId,
    status: "succeeded",
    envelope: terminal,
    recordedAt: recoveredAt,
  });
}

export function pendingRuntimeCommandTerminals(db: DatabaseSync, limit = 100): unknown[] {
  const rows = db
    .prepare(
      `SELECT terminal_json AS terminalJson
       FROM runtime_command_receipts
       WHERE terminal_json IS NOT NULL AND terminal_acked_at IS NULL
       ORDER BY completed_at, command_id LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as Array<{ terminalJson: string }>;
  return rows.map((row) => JSON.parse(row.terminalJson) as unknown);
}

export function runtimeCommandReceipt(
  db: DatabaseSync,
  commandId: string,
):
  | {
      status: string;
      deliveryCount: number;
      ack: unknown;
      terminal: unknown;
      terminalAckedAt: string | null;
    }
  | undefined {
  const row = db
    .prepare(
      `SELECT status, delivery_count AS deliveryCount, ack_json AS ackJson,
              terminal_json AS terminalJson, terminal_acked_at AS terminalAckedAt
       FROM runtime_command_receipts WHERE command_id = ?`,
    )
    .get(commandId) as
    | {
        status: string;
        deliveryCount: number;
        ackJson: string | null;
        terminalJson: string | null;
        terminalAckedAt: string | null;
      }
    | undefined;
  return row
    ? {
        status: row.status,
        deliveryCount: Number(row.deliveryCount),
        ack: row.ackJson ? (JSON.parse(row.ackJson) as unknown) : null,
        terminal: row.terminalJson ? (JSON.parse(row.terminalJson) as unknown) : null,
        terminalAckedAt: row.terminalAckedAt,
      }
    : undefined;
}

function runtimeCommandPayloadHash(command: ServerCommandEnvelope): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        runtimeId: command.runtimeId,
        workspaceBindingId: command.workspaceBindingId,
        workspaceId: command.workspaceId,
        projectId: command.projectId,
        sessionId: command.sessionId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        payload: command.payload,
      }),
    )
    .digest("hex");
}

function stableTerminalMessageId(commandId: string): string {
  return stableReceiptMessageId(commandId, "terminal");
}

function stableReceiptMessageId(commandId: string, kind: "ack" | "terminal"): string {
  return `msg_${createHash("sha256").update(`${commandId}:${kind}`).digest("hex").slice(0, 32)}`;
}

function messageIdOf(envelope: unknown): string {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    typeof (envelope as { messageId?: unknown }).messageId !== "string"
  ) {
    throw new Error("Runtime command terminal envelope requires a messageId.");
  }
  return (envelope as { messageId: string }).messageId;
}
