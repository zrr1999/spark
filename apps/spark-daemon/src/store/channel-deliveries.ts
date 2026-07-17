import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const sparkChannelDeliveryKinds = [
  "reply",
  "ask",
  "interaction_ack",
  "inbound",
  "notification",
] as const;
export type SparkChannelDeliveryKind = (typeof sparkChannelDeliveryKinds)[number];

export const sparkChannelDeliveryStatuses = ["pending", "retry_wait", "delivered"] as const;
export type SparkChannelDeliveryStatus = (typeof sparkChannelDeliveryStatuses)[number];

export const DEFAULT_CHANNEL_DELIVERY_LEASE_MS = 30_000;
export const MAX_CHANNEL_DELIVERY_RETRY_MS = 60_000;
const BASE_CHANNEL_DELIVERY_RETRY_MS = 1_000;

export interface SparkChannelDeliveryRecord {
  deliveryId: string;
  kind: SparkChannelDeliveryKind;
  idempotencyKey: string;
  payload: unknown;
  status: SparkChannelDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  claimedAt?: string;
  lastError?: string;
  receipt?: unknown;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SparkChannelDeliverySummary {
  pending: number;
  retrying: number;
  inFlight: number;
  delivered: number;
  oldestPendingAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface EnqueueSparkChannelDeliveryInput {
  deliveryId?: string;
  kind: SparkChannelDeliveryKind;
  idempotencyKey: string;
  payload: unknown;
}

export interface ClaimSparkChannelDeliveryOptions {
  leaseMs?: number;
}

export type RenewSparkChannelDeliveryOptions = ClaimSparkChannelDeliveryOptions;

export interface SparkChannelDeliveryStoreOptions {
  now?: () => string;
  random?: () => number;
}

interface ChannelDeliveryRow {
  id: string;
  kind: string;
  idempotency_key: string;
  payload_json: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  claimed_at: string | null;
  last_error: string | null;
  receipt_json: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

const channelDeliverySelect = `SELECT
  id, kind, idempotency_key, payload_json, status, attempt_count, next_attempt_at,
  lease_owner, lease_token, lease_expires_at, claimed_at, last_error, receipt_json,
  delivered_at, created_at, updated_at
FROM channel_deliveries`;

export class SparkChannelDeliveryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly random: () => number;

  constructor(db: DatabaseSync, options: SparkChannelDeliveryStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.random = options.random ?? Math.random;
  }

  enqueue(input: EnqueueSparkChannelDeliveryInput): SparkChannelDeliveryRecord {
    assertNonEmpty(input.idempotencyKey, "channel delivery idempotencyKey");
    if (!isChannelDeliveryKind(input.kind)) {
      throw new Error(`Unsupported channel delivery kind: ${String(input.kind)}`);
    }
    const payloadJson = serializeJson(input.payload, "channel delivery payload");
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      assertIdempotentEnqueue(existing, input.kind, payloadJson);
      return existing;
    }

    const now = this.now();
    const deliveryId = input.deliveryId ?? `chd_${randomUUID().replaceAll("-", "")}`;
    try {
      this.db
        .prepare(
          `INSERT INTO channel_deliveries
            (id, kind, idempotency_key, payload_json, status, attempt_count,
             next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(deliveryId, input.kind, input.idempotencyKey, payloadJson, now, now, now);
    } catch (error) {
      const raced = this.findByIdempotencyKey(input.idempotencyKey);
      if (raced) {
        assertIdempotentEnqueue(raced, input.kind, payloadJson);
        return raced;
      }
      throw error;
    }
    return this.require(deliveryId);
  }

  get(deliveryId: string): SparkChannelDeliveryRecord | undefined {
    const row = this.db.prepare(`${channelDeliverySelect} WHERE id = ?`).get(deliveryId) as
      | ChannelDeliveryRow
      | undefined;
    return row ? channelDeliveryRecord(row) : undefined;
  }

  require(deliveryId: string): SparkChannelDeliveryRecord {
    const record = this.get(deliveryId);
    if (!record) throw new Error(`Unknown channel delivery: ${deliveryId}`);
    return record;
  }

  findByIdempotencyKey(idempotencyKey: string): SparkChannelDeliveryRecord | undefined {
    const row = this.db
      .prepare(`${channelDeliverySelect} WHERE idempotency_key = ?`)
      .get(idempotencyKey) as ChannelDeliveryRow | undefined;
    return row ? channelDeliveryRecord(row) : undefined;
  }

  summary(): SparkChannelDeliverySummary {
    const now = this.now();
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status != 'delivered' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'retry_wait' THEN 1 ELSE 0 END) AS retrying,
           SUM(CASE WHEN status != 'delivered' AND lease_expires_at > ? THEN 1 ELSE 0 END) AS inFlight,
           SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           MIN(CASE WHEN status != 'delivered' THEN created_at END) AS oldestPendingAt
         FROM channel_deliveries`,
      )
      .get(now) as {
      pending: number | null;
      retrying: number | null;
      inFlight: number | null;
      delivered: number | null;
      oldestPendingAt: string | null;
    };
    const failure = this.db
      .prepare(
        `SELECT last_error AS lastError, updated_at AS lastErrorAt
         FROM channel_deliveries
         WHERE last_error IS NOT NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get() as { lastError: string; lastErrorAt: string } | undefined;
    return {
      pending: Number(counts.pending ?? 0),
      retrying: Number(counts.retrying ?? 0),
      inFlight: Number(counts.inFlight ?? 0),
      delivered: Number(counts.delivered ?? 0),
      ...(counts.oldestPendingAt ? { oldestPendingAt: counts.oldestPendingAt } : {}),
      ...(failure ? { lastError: failure.lastError, lastErrorAt: failure.lastErrorAt } : {}),
    };
  }

  claimDue(
    workerId: string,
    options: ClaimSparkChannelDeliveryOptions = {},
  ): SparkChannelDeliveryRecord | undefined {
    assertNonEmpty(workerId, "channel delivery workerId");
    const now = this.now();
    const leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_CHANNEL_DELIVERY_LEASE_MS);
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const leaseToken = `chlease_${randomUUID().replaceAll("-", "")}`;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db
        .prepare(
          `SELECT id
           FROM channel_deliveries
           WHERE status IN ('pending', 'retry_wait')
             AND next_attempt_at <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY next_attempt_at, created_at, id
           LIMIT 1`,
        )
        .get(now, now) as { id: string } | undefined;
      if (!candidate) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const claimed = this.db
        .prepare(
          `UPDATE channel_deliveries
           SET lease_owner = ?, lease_token = ?, lease_expires_at = ?, claimed_at = ?,
               attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ?
             AND status IN ('pending', 'retry_wait')
             AND next_attempt_at <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .run(workerId, leaseToken, leaseExpiresAt, now, now, candidate.id, now, now);
      if (Number(claimed.changes) !== 1) {
        throw new Error(`CHANNEL_DELIVERY_CLAIM_RACE: ${candidate.id}`);
      }
      const record = this.require(candidate.id);
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewLease(
    deliveryId: string,
    leaseToken: string,
    options: RenewSparkChannelDeliveryOptions = {},
  ): SparkChannelDeliveryRecord {
    assertNonEmpty(leaseToken, "channel delivery leaseToken");
    const now = this.now();
    const leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_CHANNEL_DELIVERY_LEASE_MS);
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE channel_deliveries
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_token = ? AND lease_expires_at > ?
           AND status IN ('pending', 'retry_wait')`,
      )
      .run(leaseExpiresAt, now, deliveryId, leaseToken, now);
    if (Number(result.changes) !== 1) throw leaseLost(deliveryId);
    return this.require(deliveryId);
  }

  recordFailure(deliveryId: string, leaseToken: string, error: string): SparkChannelDeliveryRecord {
    assertNonEmpty(leaseToken, "channel delivery leaseToken");
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const leased = this.requireActiveLease(deliveryId, leaseToken, now);
      const delayMs = channelDeliveryRetryDelayMs(leased.attemptCount, this.random);
      const nextAttemptAt = new Date(Date.parse(now) + delayMs).toISOString();
      const result = this.db
        .prepare(
          `UPDATE channel_deliveries
           SET status = 'retry_wait', next_attempt_at = ?, lease_owner = NULL,
               lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
           WHERE id = ? AND lease_token = ? AND lease_expires_at > ?
             AND status IN ('pending', 'retry_wait')`,
        )
        .run(nextAttemptAt, error, now, deliveryId, leaseToken, now);
      if (Number(result.changes) !== 1) throw leaseLost(deliveryId);
      const record = this.require(deliveryId);
      this.db.exec("COMMIT");
      return record;
    } catch (caught) {
      this.db.exec("ROLLBACK");
      throw caught;
    }
  }

  recordDelivered(
    deliveryId: string,
    leaseToken: string,
    receipt?: unknown,
  ): SparkChannelDeliveryRecord {
    assertNonEmpty(leaseToken, "channel delivery leaseToken");
    const now = this.now();
    const receiptJson = receipt === undefined ? null : serializeJson(receipt, "delivery receipt");
    const result = this.db
      .prepare(
        `UPDATE channel_deliveries
         SET status = 'delivered', receipt_json = ?, delivered_at = ?, last_error = NULL,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND lease_token = ? AND lease_expires_at > ?
           AND status IN ('pending', 'retry_wait')`,
      )
      .run(receiptJson, now, now, deliveryId, leaseToken, now);
    if (Number(result.changes) !== 1) throw leaseLost(deliveryId);
    return this.require(deliveryId);
  }

  private requireActiveLease(
    deliveryId: string,
    leaseToken: string,
    now: string,
  ): SparkChannelDeliveryRecord {
    const row = this.db
      .prepare(
        `${channelDeliverySelect}
         WHERE id = ? AND lease_token = ? AND lease_expires_at > ?
           AND status IN ('pending', 'retry_wait')`,
      )
      .get(deliveryId, leaseToken, now) as ChannelDeliveryRow | undefined;
    if (!row) throw leaseLost(deliveryId);
    return channelDeliveryRecord(row);
  }
}

export function channelDeliveryRetryDelayMs(
  attemptCount: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(30, Math.max(0, Math.floor(attemptCount) - 1));
  const ceiling = Math.min(
    MAX_CHANNEL_DELIVERY_RETRY_MS,
    BASE_CHANNEL_DELIVERY_RETRY_MS * 2 ** exponent,
  );
  const sample = Math.max(0, Math.min(1, random()));
  return Math.min(MAX_CHANNEL_DELIVERY_RETRY_MS, Math.floor(ceiling * (0.5 + sample * 0.5)));
}

function channelDeliveryRecord(row: ChannelDeliveryRow): SparkChannelDeliveryRecord {
  if (!isChannelDeliveryKind(row.kind)) {
    throw new Error(`Invalid persisted channel delivery kind: ${row.kind}`);
  }
  if (!isChannelDeliveryStatus(row.status)) {
    throw new Error(`Invalid persisted channel delivery status: ${row.status}`);
  }
  return {
    deliveryId: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as unknown,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) as unknown } : {}),
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertIdempotentEnqueue(
  existing: SparkChannelDeliveryRecord,
  kind: SparkChannelDeliveryKind,
  payloadJson: string,
): void {
  if (existing.kind !== kind || JSON.stringify(existing.payload) !== payloadJson) {
    throw new Error(`CHANNEL_DELIVERY_IDEMPOTENCY_CONFLICT: ${existing.idempotencyKey}`);
  }
}

function isChannelDeliveryKind(value: string): value is SparkChannelDeliveryKind {
  return (sparkChannelDeliveryKinds as readonly string[]).includes(value);
}

function isChannelDeliveryStatus(value: string): value is SparkChannelDeliveryStatus {
  return (sparkChannelDeliveryStatuses as readonly string[]).includes(value);
}

function serializeJson(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable`);
  return serialized;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function positiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("channel delivery leaseMs must be a positive finite number");
  }
  return Math.max(1, Math.floor(value));
}

function leaseLost(deliveryId: string): Error {
  return new Error(`CHANNEL_DELIVERY_LEASE_LOST: ${deliveryId}`);
}
