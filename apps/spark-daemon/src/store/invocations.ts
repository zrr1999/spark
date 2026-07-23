import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const sparkInvocationStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type SparkInvocationStatus = (typeof sparkInvocationStatuses)[number];
export type SparkInvocationTerminalStatus = Extract<
  SparkInvocationStatus,
  "succeeded" | "failed" | "cancelled"
>;

export const SPARK_INVOCATION_INTERRUPTED_ERROR_CODE = "DAEMON_EXECUTION_INTERRUPTED";
export const SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE =
  "The daemon exited while this invocation was running. The successor daemon will resume this turn from persisted session state.";

export const SPARK_INVOCATION_RESUME_SOURCE_KIND = "invocation.resume";

export interface SparkInvocationRecord {
  invocationId: string;
  commandId?: string;
  workspaceBindingId?: string;
  sessionId?: string;
  idempotencyKey?: string;
  status: SparkInvocationStatus;
  prompt?: string;
  task?: unknown;
  result?: unknown;
  sourceKind?: string;
  sourceRef?: string;
  retryOfInvocationId?: string;
  workerId?: string;
  attemptCount: number;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SparkInvocationEvent {
  invocationId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SparkInvocationEventPage {
  invocationId: string;
  events: SparkInvocationEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export interface SparkInvocationListInput {
  status?: SparkInvocationStatus;
  sessionId?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface SparkInvocationListPage {
  invocations: SparkInvocationRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface SparkInvocationSummaryRecord {
  invocationId: string;
  sessionId?: string;
  retryOfInvocationId?: string;
  status: SparkInvocationStatus;
  attemptCount: number;
  errorCode?: string;
  errorMessage?: string;
  eventCursor: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SparkInvocationSummaryPage {
  invocations: SparkInvocationSummaryRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface SparkInvocationSessionActivity {
  active: boolean;
  updatedAt?: string;
}

export interface SparkInvocationRetentionPreview {
  before: string;
  invocationIds: string[];
  eventCount: number;
  blockedByDeliveryCount: number;
}

export interface SparkInvocationPendingDelivery {
  invocation: SparkInvocationRecord;
  event: SparkInvocationEvent;
}

export interface SubmitSparkInvocationInput {
  invocationId?: string;
  commandId?: string;
  workspaceBindingId?: string;
  sessionId?: string;
  idempotencyKey?: string;
  prompt?: string;
  task?: unknown;
  sourceKind?: string;
  sourceRef?: string;
  retryOfInvocationId?: string;
  now?: string;
}

export interface ImportSparkInvocationInput extends SubmitSparkInvocationInput {
  invocationId: string;
  status: SparkInvocationStatus;
  result?: unknown;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CompleteSparkInvocationInput {
  status: SparkInvocationTerminalStatus;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  result?: unknown;
  now?: string;
}

const DEFAULT_EVENT_PAGE_LIMIT = 100;
export const MAX_INVOCATION_EVENT_PAGE_LIMIT = 500;

const allowedTransitions: Record<SparkInvocationStatus, readonly SparkInvocationStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["queued", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

interface InvocationRow {
  id: string;
  command_id: string | null;
  workspace_binding_id: string | null;
  session_id: string | null;
  idempotency_key: string | null;
  status: string;
  prompt: string | null;
  task_json: string | null;
  result_json: string | null;
  source_kind: string | null;
  source_ref: string | null;
  retry_of_invocation_id: string | null;
  worker_id: string | null;
  attempt_count: number;
  cancel_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface InvocationSummaryRow {
  id: string;
  session_id: string | null;
  retry_of_invocation_id: string | null;
  status: string;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  event_cursor: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface InvocationEventRow {
  invocation_id: string;
  sequence: number;
  kind: string;
  payload_json: string;
  created_at: string;
}

interface PendingDeliveryRow extends InvocationRow {
  event_invocation_id: string;
  event_sequence: number;
  event_kind: string;
  event_payload_json: string;
  event_created_at: string;
}

export class SparkInvocationStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  submit(input: SubmitSparkInvocationInput): SparkInvocationRecord {
    const now = input.now ?? new Date().toISOString();
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        assertIdempotentSubmission(existing, input);
        return existing;
      }
    }

    const invocationId = input.invocationId ?? `inv_${randomUUID().replaceAll("-", "")}`;
    try {
      this.db
        .prepare(
          `INSERT INTO invocations
            (id, command_id, workspace_binding_id, session_id, idempotency_key, status, prompt,
             task_json, source_kind, source_ref, retry_of_invocation_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invocationId,
          input.commandId ?? null,
          input.workspaceBindingId ?? null,
          input.sessionId ?? null,
          input.idempotencyKey ?? null,
          input.prompt ?? null,
          serializeJson(input.task),
          input.sourceKind ?? null,
          input.sourceRef ?? null,
          input.retryOfInvocationId ?? null,
          now,
          now,
        );
    } catch (error) {
      if (input.idempotencyKey) {
        const existing = this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          assertIdempotentSubmission(existing, input);
          return existing;
        }
      }
      throw error;
    }
    return this.require(invocationId);
  }

  submitIfSessionIdle(input: SubmitSparkInvocationInput): SparkInvocationRecord {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) throw new Error("SESSION_NOT_IDLE: idle admission requires sessionId");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) {
        const existing = this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          assertIdempotentSubmission(existing, input);
          this.db.exec("COMMIT");
          return existing;
        }
      }
      const pending = this.db
        .prepare(
          `SELECT id
           FROM invocations
           WHERE session_id = ? AND status IN ('queued', 'running')
           LIMIT 1`,
        )
        .get(sessionId) as { id: string } | undefined;
      if (pending) {
        throw new Error(
          `SESSION_NOT_IDLE: session ${sessionId} already has pending invocation ${pending.id}`,
        );
      }
      const invocation = this.submit({ ...input, sessionId });
      this.db.exec("COMMIT");
      return invocation;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  importRecord(input: ImportSparkInvocationInput): SparkInvocationRecord {
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }
    this.db
      .prepare(
        `INSERT INTO invocations
          (id, command_id, workspace_binding_id, session_id, idempotency_key, status, prompt,
           task_json, result_json, source_kind, source_ref, retry_of_invocation_id, worker_id,
           attempt_count, cancel_reason, error_code, error_message, created_at, updated_at,
           claimed_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        input.invocationId,
        input.commandId ?? null,
        input.workspaceBindingId ?? null,
        input.sessionId ?? null,
        input.idempotencyKey ?? null,
        input.status,
        input.prompt ?? null,
        serializeJson(input.task),
        serializeJson(input.result),
        input.sourceKind ?? null,
        input.sourceRef ?? null,
        input.retryOfInvocationId ?? null,
        input.status === "queued" ? 0 : 1,
        input.cancelReason ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.createdAt,
        input.updatedAt,
        input.startedAt ?? null,
        input.finishedAt ?? null,
      );
    return this.require(input.invocationId);
  }

  get(invocationId: string): SparkInvocationRecord | undefined {
    const row = this.db.prepare(`${invocationSelect} WHERE id = ?`).get(invocationId) as
      | InvocationRow
      | undefined;
    return row ? invocationRecord(row) : undefined;
  }

  require(invocationId: string): SparkInvocationRecord {
    const record = this.get(invocationId);
    if (!record) throw new Error(`Unknown Spark invocation: ${invocationId}`);
    return record;
  }

  counts(): Record<SparkInvocationStatus, number> {
    const counts = Object.fromEntries(
      sparkInvocationStatuses.map((status) => [status, 0]),
    ) as Record<SparkInvocationStatus, number>;
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM invocations GROUP BY status")
      .all() as unknown as Array<{ status: string; count: number }>;
    for (const row of rows) {
      if (isInvocationStatus(row.status)) counts[row.status] = Number(row.count);
    }
    return counts;
  }

  list(limit = 100): SparkInvocationRecord[] {
    return this.listPage({ limit: Math.max(1, Math.floor(limit)) }).invocations;
  }

  listPage(input: SparkInvocationListInput = {}): SparkInvocationListPage {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input.status) {
      conditions.push("status = ?");
      values.push(input.status);
    }
    if (input.sessionId?.trim()) {
      conditions.push("session_id = ?");
      values.push(input.sessionId.trim());
    }
    if (input.since) {
      conditions.push("created_at >= ?");
      values.push(input.since);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM invocations${where}`)
      .get(...values) as { count: number };
    const rows = this.db
      .prepare(`${invocationSelect}${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as unknown as InvocationRow[];
    return {
      invocations: rows.map(invocationRecord),
      total: Number(totalRow.count),
      limit,
      offset,
    };
  }

  listSummaryPage(input: SparkInvocationListInput = {}): SparkInvocationSummaryPage {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const { where, values } = invocationListFilter(input, "i");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM invocations i${where}`)
      .get(...values) as { count: number };
    const rows = this.db
      .prepare(
        `SELECT i.id,
                i.session_id,
                i.retry_of_invocation_id,
                i.status,
                i.attempt_count,
                i.error_code,
                i.error_message,
                i.event_cursor,
                i.created_at,
                i.updated_at,
                i.started_at,
                i.finished_at
         FROM invocations i${where}
         ORDER BY i.created_at DESC, i.rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as unknown as InvocationSummaryRow[];
    return {
      invocations: rows.map(invocationSummaryRecord),
      total: Number(totalRow.count),
      limit,
      offset,
    };
  }

  pendingSessionIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id
         FROM invocations
         WHERE session_id IS NOT NULL AND status IN ('queued', 'running')`,
      )
      .all() as unknown as Array<{ session_id: string }>;
    return new Set(rows.map((row) => row.session_id));
  }

  runningSessionIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id
         FROM invocations
         WHERE session_id IS NOT NULL AND status = 'running'`,
      )
      .all() as unknown as Array<{ session_id: string }>;
    return new Set(rows.map((row) => row.session_id));
  }

  /** Hydration hot path: filter in SQLite so terminal result payloads are never materialized. */
  listPendingForSession(sessionId: string): SparkInvocationRecord[] {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return [];
    return (
      this.db
        .prepare(
          `${invocationSelect}
           WHERE session_id = ? AND status IN ('queued', 'running')
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(normalizedSessionId) as unknown as InvocationRow[]
    ).map(invocationRecord);
  }

  /**
   * Return the durable execution state for one session without hydrating task
   * or result payloads. Session registry status is only a convenience mirror;
   * SQLite invocations are the execution source of truth.
   */
  sessionActivity(sessionId: string): SparkInvocationSessionActivity {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return { active: false };
    return (
      this.sessionActivities([normalizedSessionId]).get(normalizedSessionId) ?? {
        active: false,
      }
    );
  }

  /** Resolve a session list in one query. The two existing covering indexes
   * keep active-state and latest-update lookups independent of history size. */
  sessionActivities(sessionIds: string[]): Map<string, SparkInvocationSessionActivity> {
    const normalizedSessionIds = [
      ...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
    ];
    if (normalizedSessionIds.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `WITH requested_sessions(session_id) AS (
           SELECT DISTINCT CAST(value AS TEXT)
             FROM json_each(?)
         )
         SELECT requested_sessions.session_id,
                EXISTS(
                  SELECT 1
                    FROM invocations active_invocation
                   WHERE active_invocation.session_id = requested_sessions.session_id
                     AND active_invocation.status IN ('queued', 'running')
                ) AS active,
                (
                  SELECT latest_invocation.updated_at
                    FROM invocations latest_invocation
                   WHERE latest_invocation.session_id = requested_sessions.session_id
                   ORDER BY latest_invocation.updated_at DESC
                   LIMIT 1
                ) AS updated_at
           FROM requested_sessions`,
      )
      .all(JSON.stringify(normalizedSessionIds)) as unknown as Array<{
      active: number;
      session_id: string;
      updated_at: string | null;
    }>;
    return new Map(
      rows.map((row) => [
        row.session_id,
        {
          active: row.active === 1,
          ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
        },
      ]),
    );
  }

  findByIdempotencyKey(idempotencyKey: string): SparkInvocationRecord | undefined {
    const row = this.db
      .prepare(`${invocationSelect} WHERE idempotency_key = ?`)
      .get(idempotencyKey) as InvocationRow | undefined;
    return row ? invocationRecord(row) : undefined;
  }

  claimNext(
    workerId: string,
    now = new Date().toISOString(),
    blockedSessionIds: readonly string[] = [],
    options: { sourceKind?: string } = {},
  ): SparkInvocationRecord | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const blockedClause = blockedSessionIds.length
        ? `AND (session_id IS NULL OR session_id NOT IN (${blockedSessionIds.map(() => "?").join(", ")}))`
        : "";
      const sourceClause = options.sourceKind ? "AND source_kind = ?" : "";
      const candidate = this.db
        .prepare(
          `${invocationSelect}
           WHERE status = 'queued'
             ${sourceClause}
             AND (
               session_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM invocations active
                 WHERE active.session_id = invocations.session_id
                   AND active.status = 'running'
               )
             )
             ${blockedClause}
           ORDER BY CASE WHEN source_kind = 'session.question' THEN 0 ELSE 1 END,
                    created_at, rowid
           LIMIT 1`,
        )
        .get(...(options.sourceKind ? [options.sourceKind] : []), ...blockedSessionIds) as
        | InvocationRow
        | undefined;
      if (!candidate) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const changes = Number(
        this.db
          .prepare(
            `UPDATE invocations
             SET status = 'running', worker_id = ?, attempt_count = attempt_count + 1,
                 claimed_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run(workerId, now, now, now, candidate.id).changes,
      );
      if (changes !== 1) throw new Error(`Invocation claim conflict: ${candidate.id}`);
      this.db.exec("COMMIT");
      return this.require(candidate.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  requestCancellation(
    invocationId: string,
    reason: string,
    now = new Date().toISOString(),
  ): "cancelled" | "requested" | "terminal" | "not-found" {
    const current = this.get(invocationId);
    if (!current) return "not-found";
    if (current.status === "queued") {
      this.complete(invocationId, { status: "cancelled", cancelReason: reason, now });
      return "cancelled";
    }
    if (current.status !== "running") return "terminal";
    this.db
      .prepare(
        `UPDATE invocations
         SET cancel_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(reason, now, invocationId);
    return "requested";
  }

  failInterruptedRunning(now = new Date().toISOString()): number {
    return Number(
      this.db
        .prepare(
          `UPDATE invocations
           SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
           WHERE status = 'running'`,
        )
        .run(
          SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
          SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
          now,
          now,
        ).changes,
    );
  }

  /**
   * Requeue a crashed `running` invocation so the successor daemon can resume
   * the same turn against persisted session state.
   */
  requeueForResume(invocationId: string, now = new Date().toISOString()): SparkInvocationRecord {
    const current = this.require(invocationId);
    if (current.status !== "running") {
      throw new Error(`Invocation resume conflict: ${invocationId} is ${current.status}`);
    }
    assertTransition(current.status, "queued");
    const nextTask = markTaskForResume(current.task);
    const changes = Number(
      this.db
        .prepare(
          `UPDATE invocations
           SET status = 'queued',
               worker_id = NULL,
               claimed_at = NULL,
               started_at = NULL,
               finished_at = NULL,
               cancel_reason = NULL,
               error_code = NULL,
               error_message = NULL,
               result_json = NULL,
               source_kind = ?,
               task_json = ?,
               updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          SPARK_INVOCATION_RESUME_SOURCE_KIND,
          nextTask === undefined ? null : JSON.stringify(nextTask),
          now,
          invocationId,
        ).changes,
    );
    if (changes !== 1) throw new Error(`Invocation resume conflict: ${invocationId}`);
    this.appendEvent(
      invocationId,
      "invocation.resume_queued",
      {
        reason: SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
        message: SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
      },
      now,
    );
    return this.require(invocationId);
  }

  complete(invocationId: string, input: CompleteSparkInvocationInput): SparkInvocationRecord {
    const current = this.require(invocationId);
    assertTransition(current.status, input.status);
    const now = input.now ?? new Date().toISOString();
    const changes = Number(
      this.db
        .prepare(
          `UPDATE invocations
           SET status = ?, cancel_reason = ?, error_code = ?, error_message = ?, result_json = ?,
               finished_at = ?, updated_at = ?
           WHERE id = ? AND status = ?`,
        )
        .run(
          input.status,
          input.cancelReason ?? null,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          serializeJson(input.result),
          now,
          now,
          invocationId,
          current.status,
        ).changes,
    );
    if (changes !== 1) throw new Error(`Invocation transition conflict: ${invocationId}`);
    return this.require(invocationId);
  }

  appendEvent(
    invocationId: string,
    kind: string,
    payload: Record<string, unknown>,
    now = new Date().toISOString(),
  ): SparkInvocationEvent {
    this.require(invocationId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cursor = this.db
        .prepare(
          `SELECT event_cursor AS sequence
           FROM invocations
           WHERE id = ?`,
        )
        .get(invocationId) as { sequence: number } | undefined;
      const sequence = Number(cursor?.sequence ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO invocation_events
            (invocation_id, sequence, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(invocationId, sequence, kind, JSON.stringify(payload), now);
      this.db
        .prepare(
          `UPDATE invocations
           SET event_cursor = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(sequence, now, invocationId);
      this.db.exec("COMMIT");
      return { invocationId, sequence, kind, payload, createdAt: now };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  previousEvent(
    invocationId: string,
    beforeSequence: number,
    kind?: string,
  ): SparkInvocationEvent | undefined {
    this.require(invocationId);
    const row = this.db
      .prepare(
        `SELECT invocation_id, sequence, kind, payload_json, created_at
         FROM invocation_events
         WHERE invocation_id = ? AND sequence < ?
           AND (? IS NULL OR kind = ?)
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(invocationId, beforeSequence, kind ?? null, kind ?? null) as
      | InvocationEventRow
      | undefined;
    return row ? invocationEvent(row) : undefined;
  }

  pendingDeliveries(
    destination: string,
    limit = 500,
    workspaceBindingIds?: readonly string[],
  ): SparkInvocationPendingDelivery[] {
    const normalizedDestination = destination.trim();
    if (!normalizedDestination) {
      throw new Error("invocation delivery destination must not be blank");
    }
    const normalizedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    this.db
      .prepare(
        `INSERT OR IGNORE INTO invocation_event_delivery_consumers (destination, registered_at)
         VALUES (?, ?)`,
      )
      .run(normalizedDestination, new Date().toISOString());
    const normalizedBindings = workspaceBindingIds
      ? [...new Set(workspaceBindingIds.map((value) => value.trim()).filter(Boolean))]
      : undefined;
    if (normalizedBindings?.length === 0) return [];
    const bindingPlaceholders = normalizedBindings?.map(() => "?").join(", ");
    const bindingFilter = normalizedBindings
      ? ` AND (
            i.workspace_binding_id IN (${bindingPlaceholders})
            OR (
              i.workspace_binding_id IS NULL
              AND (
                SELECT COUNT(*)
                FROM daemon_workspaces unique_dw
                WHERE unique_dw.server_workspace_id = json_extract(i.task_json, '$.workspaceId')
              ) = 1
              AND EXISTS (
                SELECT 1
                FROM daemon_workspaces dw
                WHERE dw.id IN (${bindingPlaceholders})
                  AND dw.server_workspace_id = json_extract(i.task_json, '$.workspaceId')
              )
            )
          )`
      : "";
    // Pre-fix workspace turns may have a NULL binding and a very large event
    // backlog. Recover only one checkpoint without flooding a reconnected
    // Cockpit with obsolete stream deltas. A terminal invocation row is newer
    // truth than its event stream: the daemon persists completion before it
    // appends the terminal lifecycle event, so a crash can leave the latest
    // lifecycle at `running`. In that case select the latest event sequence and
    // synthesize terminal lifecycle truth below; acknowledging that sequence
    // compactly advances the durable cursor. Newly admitted turns always carry
    // workspace_binding_id and retain the full live event stream.
    const legacyRecoveryFilter = normalizedBindings
      ? ` AND (
            i.workspace_binding_id IS NOT NULL
            OR e.sequence = CASE
              WHEN i.status IN ('succeeded', 'failed', 'cancelled') THEN (
                SELECT MAX(latest.sequence)
                FROM invocation_events latest
                WHERE latest.invocation_id = i.id
              )
              ELSE COALESCE(
                (
                  SELECT MAX(lifecycle.sequence)
                  FROM invocation_events lifecycle
                  WHERE lifecycle.invocation_id = i.id
                    AND lifecycle.kind = 'daemon.task.lifecycle'
                ),
                (
                  SELECT MAX(latest.sequence)
                  FROM invocation_events latest
                  WHERE latest.invocation_id = i.id
                )
              )
            END
          )`
      : "";
    const rows = this.db
      .prepare(
        `SELECT ${invocationSelectColumns("i")},
                e.invocation_id AS event_invocation_id,
                e.sequence AS event_sequence,
                e.kind AS event_kind,
                e.payload_json AS event_payload_json,
                e.created_at AS event_created_at
         FROM invocation_events e
         JOIN invocations i ON i.id = e.invocation_id
         LEFT JOIN invocation_event_deliveries d
           ON d.destination = ? AND d.invocation_id = e.invocation_id
         WHERE e.sequence > COALESCE(d.sequence, 0)${bindingFilter}${legacyRecoveryFilter}
         ORDER BY e.created_at, e.invocation_id, e.sequence
         LIMIT ?`,
      )
      .all(
        normalizedDestination,
        ...(normalizedBindings ?? []),
        ...(normalizedBindings ?? []),
        normalizedLimit,
      ) as unknown as PendingDeliveryRow[];
    return rows.map((row) => ({
      invocation: invocationRecord(row),
      event:
        normalizedBindings &&
        row.workspace_binding_id === null &&
        isTerminalInvocationStatus(row.status)
          ? recoveredTerminalLifecycleEvent(row)
          : invocationEvent({
              invocation_id: row.event_invocation_id,
              sequence: row.event_sequence,
              kind: row.event_kind,
              payload_json: row.event_payload_json,
              created_at: row.event_created_at,
            }),
    }));
  }

  acknowledgeDelivery(
    destination: string,
    invocationId: string,
    sequence: number,
    now = new Date().toISOString(),
  ): void {
    this.require(invocationId);
    const normalizedDestination = destination.trim();
    if (!normalizedDestination) {
      throw new Error("invocation delivery destination must not be blank");
    }
    const normalizedSequence = Math.max(0, Math.floor(sequence));
    this.db
      .prepare(
        `INSERT OR IGNORE INTO invocation_event_delivery_consumers (destination, registered_at)
         VALUES (?, ?)`,
      )
      .run(normalizedDestination, now);
    if (normalizedSequence > this.latestEventSequence(invocationId)) {
      throw new Error(
        `INVOCATION_DELIVERY_CURSOR_GAP: cursor ${normalizedSequence} is beyond latest sequence`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO invocation_event_deliveries (destination, invocation_id, sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(destination, invocation_id) DO UPDATE SET
           sequence = MAX(invocation_event_deliveries.sequence, excluded.sequence),
           updated_at = excluded.updated_at`,
      )
      .run(normalizedDestination, invocationId, normalizedSequence, now);
  }

  latestEventSequence(invocationId: string): number {
    this.require(invocationId);
    const row = this.db
      .prepare(
        `SELECT event_cursor AS sequence
         FROM invocations
         WHERE id = ?`,
      )
      .get(invocationId) as { sequence: number };
    return Number(row.sequence);
  }

  retry(invocationId: string, now = new Date().toISOString()): SparkInvocationRecord {
    const original = this.require(invocationId);
    if (
      original.sourceKind === "driver.tick" ||
      (original.task &&
        typeof original.task === "object" &&
        !Array.isArray(original.task) &&
        (original.task as { type?: unknown }).type === "driver.tick")
    ) {
      throw new Error(
        `INVOCATION_NOT_RETRYABLE: ${invocationId} is a driver tick; use driver.restart or driver.wake`,
      );
    }
    if (original.status !== "failed") {
      throw new Error(`INVOCATION_NOT_RETRYABLE: ${invocationId} is ${original.status}`);
    }
    if (!isRetryableInvocationError(original.errorCode)) {
      throw new Error(
        `INVOCATION_NOT_RETRYABLE: ${original.errorCode ?? "UNKNOWN"} requires correction before resubmission`,
      );
    }
    if (!original.task) throw new Error(`INVOCATION_NOT_RETRYABLE: ${invocationId} has no task`);
    return this.submit({
      commandId: original.commandId,
      workspaceBindingId: original.workspaceBindingId,
      sessionId: original.sessionId,
      idempotencyKey: `invocation.retry:${invocationId}`,
      prompt: original.prompt,
      task: original.task,
      sourceKind: "invocation.retry",
      sourceRef: invocationId,
      retryOfInvocationId: invocationId,
      now,
    });
  }

  retentionPreview(before: string, limit = 100): SparkInvocationRetentionPreview {
    const normalizedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT i.id,
                COUNT(e.sequence) AS event_count,
                CASE WHEN COALESCE((
                  SELECT MAX(latest.sequence)
                  FROM invocation_events latest
                  WHERE latest.invocation_id = i.id
                ), 0) > 0 AND EXISTS (
                  SELECT 1
                  FROM invocation_event_delivery_consumers known
                  LEFT JOIN invocation_event_deliveries d
                    ON d.destination = known.destination
                   AND d.invocation_id = i.id
                  WHERE COALESCE(d.sequence, 0) < COALESCE((
                    SELECT MAX(latest.sequence)
                    FROM invocation_events latest
                    WHERE latest.invocation_id = i.id
                  ), 0)
                ) THEN 1 ELSE 0 END AS blocked
         FROM invocations i
         LEFT JOIN invocation_events e ON e.invocation_id = i.id
         WHERE i.status IN ('succeeded', 'failed', 'cancelled')
           AND i.finished_at IS NOT NULL
           AND i.finished_at < ?
         GROUP BY i.id, i.finished_at
         ORDER BY i.finished_at, i.id
         LIMIT ?`,
      )
      .all(before, normalizedLimit) as unknown as Array<{
      id: string;
      event_count: number;
      blocked: number;
    }>;
    return {
      before,
      invocationIds: rows.filter((row) => Number(row.blocked) === 0).map((row) => row.id),
      eventCount: rows
        .filter((row) => Number(row.blocked) === 0)
        .reduce((sum, row) => sum + Number(row.event_count), 0),
      blockedByDeliveryCount: rows.filter((row) => Number(row.blocked) !== 0).length,
    };
  }

  oldestActive(): { queued?: string; running?: string } {
    const rows = this.db
      .prepare(
        `SELECT status, MIN(created_at) AS created_at
         FROM invocations
         WHERE status IN ('queued', 'running')
         GROUP BY status`,
      )
      .all() as unknown as Array<{ status: "queued" | "running"; created_at: string }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.created_at]));
  }

  eventPage(
    invocationId: string,
    after = 0,
    limit = DEFAULT_EVENT_PAGE_LIMIT,
  ): SparkInvocationEventPage {
    const latestSequence = this.latestEventSequence(invocationId);
    const normalizedAfter = Math.max(0, Math.floor(after));
    if (normalizedAfter > latestSequence) {
      throw new Error(
        `INVOCATION_CURSOR_GAP: cursor ${normalizedAfter} is beyond latest sequence ${latestSequence}`,
      );
    }
    const normalizedLimit = Math.max(
      1,
      Math.min(MAX_INVOCATION_EVENT_PAGE_LIMIT, Math.floor(limit)),
    );
    const rows = this.db
      .prepare(
        `SELECT invocation_id, sequence, kind, payload_json, created_at
         FROM invocation_events
         WHERE invocation_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(invocationId, normalizedAfter, normalizedLimit + 1) as unknown as InvocationEventRow[];
    const hasMore = rows.length > normalizedLimit;
    const events = rows.slice(0, normalizedLimit).map(invocationEvent);
    return {
      invocationId,
      events,
      nextCursor: events.at(-1)?.sequence ?? normalizedAfter,
      hasMore,
    };
  }
}

const invocationSelect = `SELECT ${invocationSelectColumns()}
  FROM invocations`;

function invocationSelectColumns(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return [
    "id",
    "command_id",
    "workspace_binding_id",
    "session_id",
    "idempotency_key",
    "status",
    "prompt",
    "task_json",
    "result_json",
    "source_kind",
    "source_ref",
    "retry_of_invocation_id",
    "worker_id",
    "attempt_count",
    "cancel_reason",
    "error_code",
    "error_message",
    "created_at",
    "updated_at",
    "claimed_at",
    "started_at",
    "finished_at",
  ]
    .map((column) => `${prefix}${column} AS ${column}`)
    .join(", ");
}

function invocationRecord(row: InvocationRow): SparkInvocationRecord {
  if (!isInvocationStatus(row.status)) throw new Error(`Invalid invocation status: ${row.status}`);
  return {
    invocationId: row.id,
    ...(row.command_id ? { commandId: row.command_id } : {}),
    ...(row.workspace_binding_id ? { workspaceBindingId: row.workspace_binding_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    status: row.status,
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
    ...(row.task_json !== null ? { task: parseJson(row.task_json) } : {}),
    ...(row.result_json !== null ? { result: parseJson(row.result_json) } : {}),
    ...(row.source_kind ? { sourceKind: row.source_kind } : {}),
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.retry_of_invocation_id ? { retryOfInvocationId: row.retry_of_invocation_id } : {}),
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    attemptCount: Number(row.attempt_count),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function invocationSummaryRecord(row: InvocationSummaryRow): SparkInvocationSummaryRecord {
  if (!isInvocationStatus(row.status)) throw new Error(`Invalid invocation status: ${row.status}`);
  return {
    invocationId: row.id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.retry_of_invocation_id ? { retryOfInvocationId: row.retry_of_invocation_id } : {}),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    eventCursor: Number(row.event_cursor),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function invocationListFilter(
  input: SparkInvocationListInput,
  alias?: string,
): { where: string; values: Array<string | number> } {
  const prefix = alias ? `${alias}.` : "";
  const conditions: string[] = [];
  const values: Array<string | number> = [];
  if (input.status) {
    conditions.push(`${prefix}status = ?`);
    values.push(input.status);
  }
  if (input.sessionId?.trim()) {
    conditions.push(`${prefix}session_id = ?`);
    values.push(input.sessionId.trim());
  }
  if (input.since) {
    conditions.push(`${prefix}created_at >= ?`);
    values.push(input.since);
  }
  return {
    where: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

function invocationEvent(row: InvocationEventRow): SparkInvocationEvent {
  const payload = JSON.parse(row.payload_json) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid invocation event payload at sequence ${row.sequence}`);
  }
  return {
    invocationId: row.invocation_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    payload: payload as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function recoveredTerminalLifecycleEvent(row: PendingDeliveryRow): SparkInvocationEvent {
  if (!isTerminalInvocationStatus(row.status)) {
    throw new Error(`Cannot recover nonterminal invocation lifecycle: ${row.id}`);
  }
  const task = jsonObject(row.task_json === null ? undefined : parseJson(row.task_json));
  const taskType = jsonString(task, "type") ?? row.source_kind ?? "legacy.invocation";
  const workspaceId = jsonString(task, "workspaceId");
  const projectId = jsonString(task, "projectId");
  const sessionId = row.session_id ?? jsonString(task, "sessionId");
  const summary =
    row.status === "failed"
      ? (row.error_message ?? row.error_code)
      : row.status === "cancelled"
        ? row.cancel_reason
        : null;
  return {
    invocationId: row.event_invocation_id,
    sequence: Number(row.event_sequence),
    kind: "daemon.task.lifecycle",
    payload: {
      type: "daemon.task.lifecycle",
      source: "daemon",
      emittedAt: row.finished_at ?? row.updated_at,
      invocationId: row.id,
      taskType,
      status: row.status,
      ...(workspaceId ? { workspaceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(summary ? { summary } : {}),
      metadata: { recoveredFromInvocationRow: true },
    },
    createdAt: row.event_created_at,
  };
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function assertTransition(from: SparkInvocationStatus, to: SparkInvocationStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid Spark invocation transition: ${from} -> ${to}`);
  }
}

function assertIdempotentSubmission(
  existing: SparkInvocationRecord,
  input: SubmitSparkInvocationInput,
): void {
  if (
    existing.sessionId !== input.sessionId ||
    existing.prompt !== input.prompt ||
    existing.commandId !== input.commandId ||
    existing.workspaceBindingId !== input.workspaceBindingId ||
    existing.retryOfInvocationId !== input.retryOfInvocationId ||
    JSON.stringify(existing.task) !== JSON.stringify(input.task)
  ) {
    throw new Error(`Invocation idempotency conflict: ${input.idempotencyKey}`);
  }
}

export function isRetryableInvocationError(errorCode: string | undefined): boolean {
  return (
    errorCode === "EXECUTOR_TIMEOUT" ||
    errorCode === "STREAM_IDLE_TIMEOUT" ||
    errorCode === "STREAM_WALL_TIMEOUT" ||
    errorCode === "EXECUTION_TRANSIENT" ||
    errorCode === "DELIVERY_FAILED" ||
    errorCode === SPARK_INVOCATION_INTERRUPTED_ERROR_CODE
  );
}

function markTaskForResume(task: unknown): unknown {
  if (!task || typeof task !== "object" || Array.isArray(task)) return task;
  return { ...(task as Record<string, unknown>), resumeFromInterrupt: true };
}

function isInvocationStatus(value: string): value is SparkInvocationStatus {
  return sparkInvocationStatuses.includes(value as SparkInvocationStatus);
}

function isTerminalInvocationStatus(value: string): value is SparkInvocationTerminalStatus {
  return value === "succeeded" || value === "failed" || value === "cancelled";
}
