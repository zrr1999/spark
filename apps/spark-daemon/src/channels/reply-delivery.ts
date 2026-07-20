import type { DatabaseSync } from "node:sqlite";
import type { ChannelReplyRecovery, ChannelReplyTarget } from "@zendev-lab/spark-channels";
import type { DaemonChannelIngressRuntime } from "./ingress.ts";
import type { SparkInvocationStore } from "../store/invocations.ts";

export const CHANNEL_REPLY_DELIVERY_KIND = "channel.reply";
export const CHANNEL_REPLY_DELIVERY_PENDING_ERROR_CODE = "CHANNEL_REPLY_DELIVERY_PENDING";

export type ChannelReplyDeliveryStatus = "sending" | "pending" | "acked" | "uncertain";
export type ChannelReplyDeliveryMode = "message" | "inline-stream";

export interface ChannelReplyDeliveryInput {
  invocationId: string;
  sessionId: string;
  workspaceId: string;
  adapterId: string;
  target: ChannelReplyTarget;
  text: string;
  deliveryMode?: ChannelReplyDeliveryMode;
  recovery?: ChannelReplyRecovery;
}

interface ChannelReplyDeliveryPayload extends Omit<
  ChannelReplyDeliveryInput,
  "deliveryMode" | "recovery"
> {
  version: 1;
  deliveryMode: ChannelReplyDeliveryMode;
  recovery?: ChannelReplyRecovery;
  attemptCount: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
}

export interface ChannelReplyDeliveryRecord extends Omit<
  ChannelReplyDeliveryInput,
  "deliveryMode"
> {
  deliveryId: string;
  deliveryMode: ChannelReplyDeliveryMode;
  status: ChannelReplyDeliveryStatus;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
}

interface ChannelReplyOutboxRow {
  id: string;
  payload_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export class ChannelReplyDeliveryPendingError extends Error {
  readonly code = CHANNEL_REPLY_DELIVERY_PENDING_ERROR_CODE;
  readonly deliveryId: string;

  constructor(deliveryId: string, cause: unknown) {
    super(`Channel reply delivery is pending retry (${deliveryId}): ${errorMessage(cause)}`, {
      cause,
    });
    this.name = "ChannelReplyDeliveryPendingError";
    this.deliveryId = deliveryId;
  }
}

/**
 * Durable final-answer delivery state.
 *
 * Model execution owns producing the final text; this outbox owns only the
 * platform side effect. A retry therefore never re-enters the model runtime.
 */
export class ChannelReplyDeliveryStore {
  private readonly db: DatabaseSync;
  private readonly invocations: Pick<SparkInvocationStore, "appendEvent">;

  constructor(db: DatabaseSync, invocations: Pick<SparkInvocationStore, "appendEvent">) {
    this.db = db;
    this.invocations = invocations;
  }

  stage(
    input: ChannelReplyDeliveryInput,
    now = new Date().toISOString(),
  ): ChannelReplyDeliveryRecord {
    if ((input.deliveryMode ?? "message") !== "inline-stream" || !input.recovery) {
      throw new Error(
        "ChannelReplyDeliveryStore only accepts recoverable inline streams; ordinary replies use the unified channel delivery outbox",
      );
    }
    const deliveryId = channelReplyDeliveryId(input.invocationId);
    const existing = this.get(deliveryId);
    if (existing) {
      assertSameDelivery(existing, input);
      return existing;
    }
    const payload: ChannelReplyDeliveryPayload = {
      version: 1,
      ...input,
      deliveryMode: input.deliveryMode ?? "message",
      attemptCount: 0,
    };
    this.db
      .prepare(
        `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
         VALUES (?, ?, ?, 'sending', ?, ?)`,
      )
      .run(deliveryId, CHANNEL_REPLY_DELIVERY_KIND, JSON.stringify(payload), now, now);
    const record = this.require(deliveryId);
    this.appendStateEvent(record);
    return record;
  }

  acknowledge(deliveryId: string, now = new Date().toISOString()): ChannelReplyDeliveryRecord {
    return this.finishAttempt(deliveryId, { status: "acked", now });
  }

  /** Replace the restart fallback with the immutable final answer before completion. */
  updateText(
    deliveryId: string,
    text: string,
    now = new Date().toISOString(),
  ): ChannelReplyDeliveryRecord {
    if (!text.trim()) throw new Error("Channel reply delivery text must not be empty");
    const current = this.require(deliveryId);
    if (current.status !== "sending") {
      throw new Error(`Channel reply delivery is not claimed: ${deliveryId}`);
    }
    const payload = payloadFromRecord(current, { text });
    const changed = Number(
      this.db
        .prepare(
          `UPDATE outbox
           SET payload_json = ?, updated_at = ?
           WHERE id = ? AND kind = ? AND status = 'sending'`,
        )
        .run(JSON.stringify(payload), now, deliveryId, CHANNEL_REPLY_DELIVERY_KIND).changes,
    );
    if (changed !== 1) {
      throw new Error(`Channel reply delivery is not claimed: ${deliveryId}`);
    }
    return this.require(deliveryId);
  }

  defer(
    deliveryId: string,
    error: unknown,
    now = new Date().toISOString(),
  ): ChannelReplyDeliveryRecord {
    return this.finishAttempt(deliveryId, {
      status: "pending",
      now,
      error: errorMessage(error),
    });
  }

  markUncertain(
    deliveryId: string,
    error: unknown,
    now = new Date().toISOString(),
  ): ChannelReplyDeliveryRecord {
    const current = this.require(deliveryId);
    if (current.status !== "sending") {
      throw new Error(`Channel reply delivery is not claimed: ${deliveryId}`);
    }
    const payload = payloadFromRecord(current, {
      lastError: errorMessage(error),
      nextAttemptAt: undefined,
    });
    const changed = Number(
      this.db
        .prepare(
          `UPDATE outbox
           SET payload_json = ?, status = 'uncertain', updated_at = ?
           WHERE id = ? AND kind = ? AND status = 'sending'`,
        )
        .run(JSON.stringify(payload), now, deliveryId, CHANNEL_REPLY_DELIVERY_KIND).changes,
    );
    if (changed !== 1) {
      throw new Error(`Channel reply delivery is not claimed: ${deliveryId}`);
    }
    const record = this.require(deliveryId);
    this.appendStateEvent(record);
    return record;
  }

  /** Switch a failed inline-card completion to an ordinary-message fallback. */
  rerouteToMessage(deliveryId: string, now = new Date().toISOString()): ChannelReplyDeliveryRecord {
    const current = this.require(deliveryId);
    if (current.status !== "sending") {
      throw new Error(`Channel reply delivery is not claimed: ${deliveryId}`);
    }
    if (current.deliveryMode === "message") return current;
    const payload = payloadFromRecord(current, {
      deliveryMode: "message",
      attemptCount: current.attemptCount,
    });
    const changed = Number(
      this.db
        .prepare(
          `UPDATE outbox
           SET payload_json = ?, updated_at = ?
           WHERE id = ? AND kind = ? AND status = 'sending'`,
        )
        .run(JSON.stringify(payload), now, deliveryId, CHANNEL_REPLY_DELIVERY_KIND).changes,
    );
    if (changed !== 1) {
      throw new Error(`Channel reply delivery is not claimed: ${deliveryId}`);
    }
    const record = this.require(deliveryId);
    this.appendStateEvent(record);
    return record;
  }

  /** Return interrupted in-flight rows to the retry backlog after daemon startup. */
  recoverInterrupted(now = new Date().toISOString()): number {
    const rows = this.db
      .prepare(
        `SELECT id, payload_json, status, created_at, updated_at
         FROM outbox
         WHERE kind = ? AND status = 'sending'
         ORDER BY created_at ASC`,
      )
      .all(CHANNEL_REPLY_DELIVERY_KIND) as unknown as ChannelReplyOutboxRow[];
    for (const row of rows) {
      const payload = parsePayload(row.payload_json);
      const canRecoverSameArtifact =
        payload.deliveryMode === "inline-stream" && payload.recovery !== undefined;
      const next: ChannelReplyDeliveryPayload = {
        ...payload,
        lastError: "daemon restarted before delivery acknowledgement",
        ...(canRecoverSameArtifact ? { nextAttemptAt: now } : { nextAttemptAt: undefined }),
      };
      this.db
        .prepare(
          `UPDATE outbox
           SET payload_json = ?, status = ?, updated_at = ?
           WHERE id = ? AND kind = ? AND status = 'sending'`,
        )
        .run(
          JSON.stringify(next),
          canRecoverSameArtifact ? "pending" : "uncertain",
          now,
          row.id,
          CHANNEL_REPLY_DELIVERY_KIND,
        );
      this.appendStateEvent(this.require(row.id));
    }
    return rows.length;
  }

  claimNext(
    now = new Date().toISOString(),
    excludedDeliveryIds: readonly string[] = [],
  ): ChannelReplyDeliveryRecord | undefined {
    const excludedClause = excludedDeliveryIds.length
      ? `AND id NOT IN (${excludedDeliveryIds.map(() => "?").join(", ")})`
      : "";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT id, payload_json, status, created_at, updated_at
           FROM outbox
           WHERE kind = ? AND status = 'pending'
             AND (
               json_extract(payload_json, '$.nextAttemptAt') IS NULL
               OR json_extract(payload_json, '$.nextAttemptAt') <= ?
             )
             ${excludedClause}
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(CHANNEL_REPLY_DELIVERY_KIND, now, ...excludedDeliveryIds) as
        | ChannelReplyOutboxRow
        | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const changed = Number(
        this.db
          .prepare(
            `UPDATE outbox
             SET status = 'sending', updated_at = ?
             WHERE id = ? AND kind = ? AND status = 'pending'`,
          )
          .run(now, row.id, CHANNEL_REPLY_DELIVERY_KIND).changes,
      );
      if (changed !== 1) throw new Error(`Channel reply delivery claim conflict: ${row.id}`);
      this.db.exec("COMMIT");
      const claimed = this.require(row.id);
      this.appendStateEvent(claimed);
      return claimed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(deliveryId: string): ChannelReplyDeliveryRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, payload_json, status, created_at, updated_at
         FROM outbox
         WHERE id = ? AND kind = ?`,
      )
      .get(deliveryId, CHANNEL_REPLY_DELIVERY_KIND) as ChannelReplyOutboxRow | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  require(deliveryId: string): ChannelReplyDeliveryRecord {
    const record = this.get(deliveryId);
    if (!record) throw new Error(`Channel reply delivery not found: ${deliveryId}`);
    return record;
  }

  private finishAttempt(
    deliveryId: string,
    input: { status: "pending" | "acked"; now: string; error?: string },
  ): ChannelReplyDeliveryRecord {
    const current = this.require(deliveryId);
    const payload: ChannelReplyDeliveryPayload = {
      version: 1,
      invocationId: current.invocationId,
      sessionId: current.sessionId,
      workspaceId: current.workspaceId,
      adapterId: current.adapterId,
      target: current.target,
      text: current.text,
      deliveryMode: current.deliveryMode,
      ...(current.recovery ? { recovery: current.recovery } : {}),
      attemptCount: current.attemptCount + 1,
      lastAttemptAt: input.now,
      ...(input.status === "acked" ? { deliveredAt: input.now } : {}),
      ...(input.status === "pending"
        ? {
            nextAttemptAt: new Date(
              Date.parse(input.now) + channelReplyRetryDelayMs(current.attemptCount + 1),
            ).toISOString(),
          }
        : {}),
      ...(input.error ? { lastError: input.error } : {}),
    };
    const changed = Number(
      this.db
        .prepare(
          `UPDATE outbox
           SET payload_json = ?, status = ?, updated_at = ?
           WHERE id = ? AND kind = ? AND status = 'sending'`,
        )
        .run(
          JSON.stringify(payload),
          input.status,
          input.now,
          deliveryId,
          CHANNEL_REPLY_DELIVERY_KIND,
        ).changes,
    );
    if (changed !== 1) {
      throw new Error(`Channel reply delivery is not claimed: ${deliveryId}`);
    }
    const record = this.require(deliveryId);
    this.appendStateEvent(record);
    return record;
  }

  private appendStateEvent(record: ChannelReplyDeliveryRecord): void {
    try {
      this.invocations.appendEvent(record.invocationId, "channel.reply.delivery", {
        deliveryId: record.deliveryId,
        status: record.status,
        deliveryMode: record.deliveryMode,
        attemptCount: record.attemptCount,
        ...(record.lastAttemptAt ? { lastAttemptAt: record.lastAttemptAt } : {}),
        ...(record.nextAttemptAt ? { nextAttemptAt: record.nextAttemptAt } : {}),
        ...(record.deliveredAt ? { deliveredAt: record.deliveredAt } : {}),
        ...(record.lastError ? { lastError: record.lastError } : {}),
      });
    } catch (error) {
      // Delivery remains the source of truth even if invocation history has
      // already been retained away or its projection cannot be appended.
      console.error("[spark-daemon] channel reply delivery event append failed", error);
    }
  }
}

export async function reconcileChannelReplyDeliveries(input: {
  store: ChannelReplyDeliveryStore;
  channelIngress: Pick<DaemonChannelIngressRuntime, "sendReply" | "recoverReply"> &
    Partial<Pick<DaemonChannelIngressRuntime, "replyDeliveryFacts">>;
  limit?: number;
  now?: () => string;
}): Promise<{ attempted: number; delivered: number; pending: number; uncertain: number }> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
  let attempted = 0;
  let delivered = 0;
  let pending = 0;
  let uncertain = 0;
  const attemptedIds: string[] = [];
  while (attempted < limit) {
    const delivery = input.store.claimNext(input.now?.() ?? new Date().toISOString(), attemptedIds);
    if (!delivery) break;
    attemptedIds.push(delivery.deliveryId);
    attempted += 1;
    try {
      if (delivery.deliveryMode === "inline-stream") {
        if (!delivery.recovery) {
          input.store.markUncertain(
            delivery.deliveryId,
            new Error(
              `Interrupted streamed reply has no platform recovery handle: ${delivery.deliveryId}`,
            ),
            input.now?.() ?? new Date().toISOString(),
          );
          uncertain += 1;
          continue;
        }
        await input.channelIngress.recoverReply(delivery.workspaceId, delivery.adapterId, {
          ...delivery.target,
          text: delivery.text,
          deliveryId: delivery.deliveryId,
          recovery: delivery.recovery,
        });
      } else {
        const replaySafety =
          input.channelIngress.replyDeliveryFacts?.(
            delivery.workspaceId,
            delivery.adapterId,
            delivery.target,
          ).replaySafety ?? "unsafe";
        if (replaySafety === "unsafe") {
          input.store.markUncertain(
            delivery.deliveryId,
            new Error(
              "legacy ordinary reply has no provably safe replay boundary; automatic retry stopped",
            ),
            input.now?.() ?? new Date().toISOString(),
          );
          uncertain += 1;
          continue;
        }
        await input.channelIngress.sendReply(delivery.workspaceId, delivery.adapterId, {
          ...delivery.target,
          text: delivery.text,
          deliveryId: delivery.deliveryId,
        });
      }
      input.store.acknowledge(delivery.deliveryId, input.now?.() ?? new Date().toISOString());
      delivered += 1;
    } catch (error) {
      input.store.defer(delivery.deliveryId, error, input.now?.() ?? new Date().toISOString());
      pending += 1;
    }
  }
  return { attempted, delivered, pending, uncertain };
}

export function channelReplyDeliveryId(invocationId: string): string {
  const normalized = invocationId.trim();
  if (!normalized) throw new Error("invocationId is required for channel reply delivery");
  return `channel.reply:${normalized}`;
}

export function channelReplyRetryDelayMs(attemptCount: number): number {
  const boundedAttempt = Math.max(1, Math.min(20, Math.floor(attemptCount)));
  return Math.min(1_000 * 2 ** (boundedAttempt - 1), 5 * 60_000);
}

function recordFromRow(row: ChannelReplyOutboxRow): ChannelReplyDeliveryRecord {
  if (!isDeliveryStatus(row.status)) {
    throw new Error(`Invalid channel reply delivery status: ${row.status}`);
  }
  const payload = parsePayload(row.payload_json);
  return {
    deliveryId: row.id,
    status: row.status,
    invocationId: payload.invocationId,
    sessionId: payload.sessionId,
    workspaceId: payload.workspaceId,
    adapterId: payload.adapterId,
    target: payload.target,
    text: payload.text,
    deliveryMode: payload.deliveryMode,
    ...(payload.recovery ? { recovery: payload.recovery } : {}),
    attemptCount: payload.attemptCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(payload.lastAttemptAt ? { lastAttemptAt: payload.lastAttemptAt } : {}),
    ...(payload.nextAttemptAt ? { nextAttemptAt: payload.nextAttemptAt } : {}),
    ...(payload.deliveredAt ? { deliveredAt: payload.deliveredAt } : {}),
    ...(payload.lastError ? { lastError: payload.lastError } : {}),
  };
}

function parsePayload(value: string): ChannelReplyDeliveryPayload {
  const payload = JSON.parse(value) as Partial<ChannelReplyDeliveryPayload>;
  if (
    payload.version !== 1 ||
    typeof payload.invocationId !== "string" ||
    typeof payload.sessionId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.adapterId !== "string" ||
    typeof payload.text !== "string" ||
    typeof payload.attemptCount !== "number" ||
    (payload.deliveryMode !== undefined && !isDeliveryMode(payload.deliveryMode)) ||
    (payload.recovery !== undefined && !isRecovery(payload.recovery)) ||
    !payload.target ||
    typeof payload.target.recipient !== "string"
  ) {
    throw new Error("Invalid channel reply delivery payload");
  }
  return {
    ...(payload as ChannelReplyDeliveryPayload),
    deliveryMode: payload.deliveryMode ?? "message",
  };
}

function assertSameDelivery(
  existing: ChannelReplyDeliveryRecord,
  input: ChannelReplyDeliveryInput,
): void {
  if (
    existing.invocationId !== input.invocationId ||
    existing.sessionId !== input.sessionId ||
    existing.workspaceId !== input.workspaceId ||
    existing.adapterId !== input.adapterId ||
    existing.text !== input.text ||
    existing.deliveryMode !== (input.deliveryMode ?? "message") ||
    JSON.stringify(existing.recovery) !== JSON.stringify(input.recovery) ||
    JSON.stringify(existing.target) !== JSON.stringify(input.target)
  ) {
    throw new Error(`Channel reply delivery conflict: ${existing.deliveryId}`);
  }
}

function payloadFromRecord(
  record: ChannelReplyDeliveryRecord,
  overrides: Partial<ChannelReplyDeliveryPayload>,
): ChannelReplyDeliveryPayload {
  return {
    version: 1,
    invocationId: record.invocationId,
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    adapterId: record.adapterId,
    target: record.target,
    text: record.text,
    deliveryMode: record.deliveryMode,
    ...(record.recovery ? { recovery: record.recovery } : {}),
    attemptCount: record.attemptCount,
    ...(record.lastAttemptAt ? { lastAttemptAt: record.lastAttemptAt } : {}),
    ...(record.nextAttemptAt ? { nextAttemptAt: record.nextAttemptAt } : {}),
    ...(record.deliveredAt ? { deliveredAt: record.deliveredAt } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...overrides,
  };
}

function isDeliveryMode(value: unknown): value is ChannelReplyDeliveryMode {
  return value === "message" || value === "inline-stream";
}

function isRecovery(value: unknown): value is ChannelReplyRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recovery = value as Partial<ChannelReplyRecovery>;
  if (
    typeof recovery.kind !== "string" ||
    !recovery.data ||
    typeof recovery.data !== "object" ||
    Array.isArray(recovery.data)
  ) {
    return false;
  }
  return Object.values(recovery.data).every(
    (entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
}

function isDeliveryStatus(value: string): value is ChannelReplyDeliveryStatus {
  return value === "sending" || value === "pending" || value === "acked" || value === "uncertain";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
