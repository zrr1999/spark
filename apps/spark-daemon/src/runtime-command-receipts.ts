import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  runtimeProtocolVersion,
  runtimeServerCommandSpecification,
  type ServerCommandEnvelope,
} from "@zendev-lab/spark-protocol";

export type RuntimeCommandReceiptClaim =
  | { kind: "new" }
  | { kind: "replay"; ack?: unknown; terminal?: unknown }
  | { kind: "conflict" };

export function claimRuntimeCommandReceipt(
  db: DatabaseSync,
  command: ServerCommandEnvelope,
  claimedAt = new Date().toISOString(),
): RuntimeCommandReceiptClaim {
  const commandId = command.commandId;
  const runtimeId = command.runtimeId;
  const scope =
    command.payload.scope ?? runtimeServerCommandSpecification(command.payload.kind)?.scope;
  if (!commandId || !runtimeId || !scope) {
    throw new Error("Runtime command receipt requires a fully routed server command.");
  }
  const payloadHash = runtimeCommandPayloadHash(command);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        `SELECT payload_hash AS payloadHash, ack_json AS ackJson, terminal_json AS terminalJson
         FROM runtime_command_receipts WHERE command_id = ?`,
      )
      .get(commandId) as
      | { payloadHash: string; ackJson: string | null; terminalJson: string | null }
      | undefined;
    if (existing) {
      db.prepare(
        `UPDATE runtime_command_receipts
         SET delivery_count = delivery_count + 1, last_seen_at = ?, updated_at = ?
         WHERE command_id = ?`,
      ).run(claimedAt, claimedAt, commandId);
      db.exec("COMMIT");
      if (existing.payloadHash !== payloadHash) return { kind: "conflict" };
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
         kind, payload_hash, status, delivery_count, first_seen_at, last_seen_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?, ?)`,
    ).run(
      commandId,
      runtimeId,
      scope,
      command.workspaceBindingId ?? null,
      command.workspaceId ?? null,
      command.projectId ?? null,
      command.payload.kind,
      payloadHash,
      claimedAt,
      claimedAt,
      claimedAt,
      claimedAt,
    );
    db.exec("COMMIT");
    return { kind: "new" };
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
): void {
  const serialized = JSON.stringify(envelope);
  db.prepare(
    `UPDATE runtime_command_receipts
     SET status = 'accepted', ack_json = COALESCE(ack_json, ?), updated_at = ?
     WHERE command_id = ?`,
  ).run(serialized, recordedAt, commandId);
}

export function recordRuntimeCommandTerminal(
  db: DatabaseSync,
  input: {
    commandId: string;
    status: "succeeded" | "failed" | "rejected";
    envelope: unknown;
    recordedAt?: string;
  },
): void {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const serialized = JSON.stringify(input.envelope);
  const existing = db
    .prepare(
      "SELECT terminal_json AS terminalJson FROM runtime_command_receipts WHERE command_id = ?",
    )
    .get(input.commandId) as { terminalJson: string | null } | undefined;
  if (!existing) throw new Error(`Unknown runtime command receipt: ${input.commandId}`);
  if (existing.terminalJson) {
    if (existing.terminalJson !== serialized) {
      throw new Error(`RUNTIME_COMMAND_TERMINAL_CONFLICT: ${input.commandId}`);
    }
    return;
  }
  db.prepare(
    `UPDATE runtime_command_receipts
     SET status = ?, terminal_message_id = ?, terminal_json = ?, completed_at = ?, updated_at = ?
     WHERE command_id = ? AND terminal_json IS NULL`,
  ).run(
    input.status,
    messageIdOf(input.envelope),
    serialized,
    recordedAt,
    recordedAt,
    input.commandId,
  );
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
              project_id AS projectId
       FROM runtime_command_receipts
       WHERE status IN ('processing', 'accepted') AND terminal_json IS NULL`,
    )
    .all() as Array<{
    commandId: string;
    runtimeId: string;
    workspaceBindingId: string | null;
    workspaceId: string | null;
    projectId: string | null;
  }>;
  for (const row of rows) {
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
        commandId: row.commandId,
        payload: {
          status: "failed",
          result: {
            reasonCode: "DAEMON_RESTARTED",
            message: "Spark daemon restarted before the command reached a terminal result.",
          },
          completedAt: recoveredAt,
        },
      },
      recordedAt: recoveredAt,
    });
  }
  return rows.length;
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
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        payload: command.payload,
      }),
    )
    .digest("hex");
}

function stableTerminalMessageId(commandId: string): string {
  return `msg_${createHash("sha256").update(`${commandId}:terminal`).digest("hex").slice(0, 32)}`;
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
