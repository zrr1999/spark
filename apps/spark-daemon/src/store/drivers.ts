import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import {
  SPARK_PROTOCOL_VERSION,
  sparkDriverMutationResultSchema,
  sparkDriverViewSchema,
  type SparkDriverContinuity,
  type SparkDriverKind,
  type SparkDriverListResult,
  type SparkDriverMutationResult,
  type SparkDriverScheduleRequest,
  type SparkDriverStatus,
  type SparkDriverView,
  type SparkDaemonEvent,
} from "@zendev-lab/spark-protocol";
import {
  SparkInvocationStore,
  isRetryableInvocationError,
  type CompleteSparkInvocationInput,
  type SparkInvocationRecord,
} from "./invocations.ts";
import type { SparkDaemonDriverTickTask } from "../core/types.ts";
import { sparkDriverPolicy } from "./driver-policies.ts";

export interface SparkDriverRoute {
  cwd: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
}

export interface StartSparkDriverInput extends SparkDriverRoute {
  driverId?: string;
  kind: SparkDriverKind;
  ownerSessionId: string;
  continuity?: SparkDriverContinuity;
  prompt: string;
  dueAt?: string;
  reason?: string;
  domainStateDigest?: string;
  wakePrompt?: string;
  initialStatus?: Extract<SparkDriverStatus, "scheduled" | "retry_wait">;
  initialAttempt?: number;
  cancellationReason?: string;
  now?: string;
}

export interface SparkDriverRecord extends SparkDriverView {
  lane: "foreground" | "background" | "fallback";
  generation: number;
  prompt: string;
  wakePrompt?: string;
  route: SparkDriverRoute;
  domainStateDigest?: string;
  createdAt: string;
  updatedAt: string;
}

interface DriverRow {
  driver_id: string;
  kind: SparkDriverKind;
  lane: SparkDriverRecord["lane"];
  owner_session_id: string;
  continuity: SparkDriverContinuity;
  status: SparkDriverStatus;
  generation: number;
  due_at: string | null;
  attempt: number;
  last_invocation_id: string | null;
  reason: string | null;
  error: string | null;
  prompt: string;
  wake_prompt: string | null;
  route_json: string;
  domain_state_digest: string | null;
  created_at: string;
  updated_at: string;
}

const driverSelect = `SELECT driver_id, kind, lane, owner_session_id, continuity, status,
  generation, due_at, attempt, last_invocation_id, reason, error, prompt, route_json,
  wake_prompt, domain_state_digest, created_at, updated_at
  FROM driver_wakeups`;

interface HiddenSessionGcRow {
  execution_session_id: string;
  session_path: string | null;
}

export interface SparkDriverHiddenSessionGcResult {
  examined: number;
  deleted: number;
  errors: Array<{ executionSessionId: string; message: string }>;
}

export class SparkDriverStore {
  readonly #db: DatabaseSync;
  readonly #invocations: SparkInvocationStore;

  constructor(db: DatabaseSync, invocations = new SparkInvocationStore(db)) {
    this.#db = db;
    this.#invocations = invocations;
  }

  start(input: StartSparkDriverInput): SparkDriverRecord {
    const now = input.now ?? new Date().toISOString();
    const ownerSessionId = required(input.ownerSessionId, "ownerSessionId");
    const prompt = required(input.prompt, "prompt");
    const route = normalizeRoute(input);
    const initialAttempt = Math.max(0, Math.trunc(input.initialAttempt ?? 0));
    const driverId = input.driverId?.trim() || `drv_${randomUUID().replaceAll("-", "")}`;
    const lane = driverLane(input.kind);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (lane === "fallback") {
        const foreground = this.#db
          .prepare(
            `SELECT driver_id FROM driver_wakeups
             WHERE owner_session_id = ? AND lane = 'foreground' AND status <> 'stopped'
             LIMIT 1`,
          )
          .get(ownerSessionId) as { driver_id: string } | undefined;
        if (foreground) {
          throw new Error(
            `DRIVER_FOREGROUND_LANE_ACTIVE: ${ownerSessionId} is owned by ${foreground.driver_id}`,
          );
        }
      }
      const existing = this.get(driverId);
      if (existing?.lastInvocationId) {
        this.#invocations.requestCancellation(
          existing.lastInvocationId,
          input.cancellationReason ?? "driver restarted by driver.start",
          now,
        );
      }
      if (lane === "foreground") {
        const superseded = this.#db
          .prepare(
            `${driverSelect}
             WHERE owner_session_id = ? AND lane IN ('foreground', 'fallback')
               AND driver_id <> ? AND status <> 'stopped'`,
          )
          .all(ownerSessionId, driverId) as unknown as DriverRow[];
        for (const row of superseded) {
          if (row.last_invocation_id) {
            this.#invocations.requestCancellation(
              row.last_invocation_id,
              "driver superseded by another foreground driver",
              now,
            );
          }
        }
        this.#db
          .prepare(
            `UPDATE driver_wakeups
             SET status = 'stopped', generation = generation + 1, due_at = NULL,
                 reason = 'superseded by another foreground driver', updated_at = ?
             WHERE owner_session_id = ? AND lane IN ('foreground', 'fallback') AND driver_id <> ?
               AND status <> 'stopped'`,
          )
          .run(now, ownerSessionId, driverId);
      }
      this.#db
        .prepare(
          `INSERT INTO driver_wakeups
            (driver_id, kind, lane, owner_session_id, continuity, status, generation,
             due_at, attempt, reason, prompt, wake_prompt, route_json, domain_state_digest,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(driver_id) DO UPDATE SET
             kind = excluded.kind,
             lane = excluded.lane,
             owner_session_id = excluded.owner_session_id,
             continuity = excluded.continuity,
             status = excluded.status,
             generation = driver_wakeups.generation + 1,
             due_at = excluded.due_at,
             attempt = excluded.attempt,
             last_invocation_id = NULL,
             reason = excluded.reason,
             error = NULL,
             prompt = excluded.prompt,
             wake_prompt = excluded.wake_prompt,
             route_json = excluded.route_json,
             domain_state_digest = excluded.domain_state_digest,
             updated_at = excluded.updated_at`,
        )
        .run(
          driverId,
          input.kind,
          lane,
          ownerSessionId,
          input.continuity ?? "session",
          input.initialStatus ?? "scheduled",
          input.dueAt ?? now,
          initialAttempt,
          input.reason ?? null,
          prompt,
          input.wakePrompt ?? null,
          JSON.stringify(route),
          input.domainStateDigest ?? null,
          now,
          now,
        );
      this.#db.exec("COMMIT");
      return this.require(driverId);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  get(driverId: string): SparkDriverRecord | undefined {
    const row = this.#db.prepare(`${driverSelect} WHERE driver_id = ?`).get(driverId) as
      | DriverRow
      | undefined;
    return row ? driverRecord(row) : undefined;
  }

  require(driverId: string): SparkDriverRecord {
    const record = this.get(driverId);
    if (!record) throw new Error(`DRIVER_NOT_FOUND: ${driverId}`);
    return record;
  }

  list(
    input: {
      driverId?: string;
      ownerSessionId?: string;
      includeStopped?: boolean;
    } = {},
  ): SparkDriverRecord[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (input.driverId?.trim()) {
      conditions.push("driver_id = ?");
      values.push(input.driverId.trim());
    }
    if (input.ownerSessionId?.trim()) {
      conditions.push("owner_session_id = ?");
      values.push(input.ownerSessionId.trim());
    }
    if (!input.includeStopped) conditions.push("status <> 'stopped'");
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return (
      this.#db
        .prepare(`${driverSelect}${where} ORDER BY created_at, driver_id`)
        .all(...values) as unknown as DriverRow[]
    ).map(driverRecord);
  }

  listResult(
    input: {
      driverId?: string;
      ownerSessionId?: string;
      includeStopped?: boolean;
    } = {},
  ): SparkDriverListResult {
    return {
      drivers: this.list(input).map(driverView),
      observedAt: new Date().toISOString(),
    };
  }

  stop(
    driverId: string,
    reason?: string,
    now = new Date().toISOString(),
    options: { cancelInvocation?: boolean } = {},
  ): SparkDriverRecord {
    const current = this.require(driverId);
    if (current.lastInvocationId && options.cancelInvocation !== false) {
      this.#invocations.requestCancellation(
        current.lastInvocationId,
        reason ?? "driver stopped",
        now,
      );
    }
    return this.transition(driverId, "stopped", {
      reason,
      clearDue: true,
      incrementGeneration: true,
      now,
    });
  }

  restart(driverId: string, reason?: string, now = new Date().toISOString()): SparkDriverRecord {
    const current = this.require(driverId);
    return this.start({
      ...current.route,
      driverId,
      kind: current.kind,
      ownerSessionId: current.ownerSessionId,
      continuity: current.continuity,
      prompt: current.prompt,
      reason,
      dueAt: now,
      domainStateDigest: current.domainStateDigest,
      cancellationReason: reason ?? "driver restarted",
      now,
    });
  }

  wake(
    driverId: string,
    input: { prompt?: string; reason?: string; now?: string } = {},
  ): SparkDriverRecord {
    const current = this.require(driverId);
    const now = input.now ?? new Date().toISOString();
    return this.start({
      ...current.route,
      driverId,
      kind: current.kind,
      ownerSessionId: current.ownerSessionId,
      continuity: current.continuity,
      prompt: current.prompt,
      wakePrompt: input.prompt,
      reason: input.reason,
      dueAt: now,
      domainStateDigest: current.domainStateDigest,
      cancellationReason: input.reason ?? "driver manually woken",
      now,
    });
  }

  schedule(input: SparkDriverScheduleRequest, now = new Date().toISOString()): SparkDriverRecord {
    if (input.dueAt === undefined && input.delayMs === undefined) {
      throw new Error("DRIVER_SCHEDULE_INVALID: dueAt or delayMs is required");
    }
    const dueAt =
      input.dueAt ?? new Date(Date.parse(now) + Math.max(0, input.delayMs ?? 0)).toISOString();
    const changes = Number(
      this.#db
        .prepare(
          `UPDATE driver_wakeups
           SET generation = generation + 1, status = 'scheduled', due_at = ?,
               attempt = 0, reason = ?, error = NULL,
               prompt = COALESCE(?, prompt), updated_at = ?
           WHERE driver_id = ? AND generation = ? AND status = 'running'`,
        )
        .run(
          dueAt,
          input.reason ?? null,
          input.prompt ?? null,
          now,
          input.driverId,
          input.generation,
        ).changes,
    );
    if (changes !== 1) {
      throw new Error(
        `DRIVER_GENERATION_CONFLICT: ${input.driverId} generation ${input.generation}`,
      );
    }
    return this.require(input.driverId);
  }

  /**
   * Atomically coalesce one due wake into one ordinary scheduler invocation.
   * A busy owner remains overdue; no second tick is accumulated.
   */
  materializeDue(now = new Date().toISOString()): SparkInvocationRecord | undefined {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.#db
        .prepare(
          `${driverSelect}
           WHERE status IN ('scheduled', 'retry_wait') AND due_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM invocations AS pending
               WHERE pending.session_id = driver_wakeups.owner_session_id
                 AND pending.status IN ('queued', 'running')
             )
           ORDER BY due_at, updated_at
           LIMIT 1`,
        )
        .get(now) as DriverRow | undefined;
      if (!candidate) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      const record = driverRecord(candidate);
      const task = driverTickTask(record);
      const invocation = this.#invocations.submit({
        workspaceBindingId: record.route.workspaceBindingId,
        sessionId: record.ownerSessionId,
        idempotencyKey: `driver.tick:${record.driverId}:${record.generation}`,
        prompt: task.prompt,
        task,
        sourceKind: "driver.tick",
        sourceRef: record.driverId,
        now,
      });
      const changes = Number(
        this.#db
          .prepare(
            `UPDATE driver_wakeups
             SET status = 'running', due_at = NULL, last_invocation_id = ?,
                 wake_prompt = NULL, updated_at = ?
             WHERE driver_id = ? AND generation = ? AND status IN ('scheduled', 'retry_wait')`,
          )
          .run(invocation.invocationId, now, record.driverId, record.generation).changes,
      );
      if (changes !== 1) throw new Error(`DRIVER_MATERIALIZE_CONFLICT: ${record.driverId}`);
      if (record.continuity === "fresh") {
        const executionSessionId = driverExecutionSessionId(record);
        this.#db
          .prepare(
            `INSERT INTO driver_hidden_sessions
              (execution_session_id, driver_id, generation, invocation_id, status, created_at)
             VALUES (?, ?, ?, ?, 'active', ?)
             ON CONFLICT(execution_session_id) DO UPDATE SET
               invocation_id = excluded.invocation_id`,
          )
          .run(
            executionSessionId,
            record.driverId,
            record.generation,
            invocation.invocationId,
            now,
          );
      }
      this.#db.exec("COMMIT");
      return invocation;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Commit invocation terminal state and the default driver transition in one
   * transaction. A schedule/stop that advanced generation wins the CAS.
   */
  completeTick(
    invocation: SparkInvocationRecord,
    task: SparkDaemonDriverTickTask,
    completion: CompleteSparkInvocationInput,
  ): { invocation: SparkInvocationRecord; driver: SparkDriverRecord } {
    const now = completion.now ?? new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const completed = this.#invocations.complete(invocation.invocationId, {
        ...completion,
        now,
      });
      if (task.continuity === "fresh" && task.executionSessionId) {
        this.#db
          .prepare(
            `UPDATE driver_hidden_sessions
             SET status = 'archived', session_path = COALESCE(?, session_path),
                 archived_at = ?, gc_after = ?
             WHERE execution_session_id = ? AND invocation_id = ?`,
          )
          .run(
            resultSessionPath(completion.result) ?? null,
            now,
            new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
            task.executionSessionId,
            invocation.invocationId,
          );
      }
      const current = this.require(task.driverId);
      if (
        current.generation === task.generation &&
        current.lastInvocationId === invocation.invocationId &&
        current.status === "running"
      ) {
        const transition = completionTransition(current, completion, now);
        this.#db
          .prepare(
            `UPDATE driver_wakeups
             SET generation = generation + 1, status = ?, due_at = ?, attempt = ?,
                 reason = ?, error = ?, updated_at = ?
             WHERE driver_id = ? AND generation = ? AND last_invocation_id = ? AND status = 'running'`,
          )
          .run(
            transition.status,
            transition.dueAt ?? null,
            transition.attempt,
            transition.reason ?? null,
            transition.error ?? null,
            now,
            task.driverId,
            task.generation,
            invocation.invocationId,
          );
      }
      this.#db.exec("COMMIT");
      return { invocation: completed, driver: this.require(task.driverId) };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Reconcile a terminal invocation left beside a running wake after a process
   * exit between executor settlement and driver transition.
   */
  reconcileTerminalTicks(now = new Date().toISOString()): SparkDriverRecord[] {
    const rows = this.#db
      .prepare(
        `${driverSelect}
         WHERE status = 'running' AND last_invocation_id IN (
           SELECT id FROM invocations WHERE status IN ('succeeded', 'failed', 'cancelled')
         )`,
      )
      .all() as unknown as DriverRow[];
    const repaired: SparkDriverRecord[] = [];
    for (const row of rows) {
      const record = driverRecord(row);
      const invocation = this.#invocations.require(record.lastInvocationId!);
      const completion: CompleteSparkInvocationInput = {
        status: invocation.status as CompleteSparkInvocationInput["status"],
        cancelReason: invocation.cancelReason,
        errorCode: invocation.errorCode,
        errorMessage: invocation.errorMessage,
        result: invocation.result,
        now,
      };
      const transition = completionTransition(record, completion, now);
      this.#db
        .prepare(
          `UPDATE driver_wakeups SET generation = generation + 1, status = ?, due_at = ?,
             attempt = ?, reason = ?, error = ?, updated_at = ?
           WHERE driver_id = ? AND generation = ? AND status = 'running'`,
        )
        .run(
          transition.status,
          transition.dueAt ?? null,
          transition.attempt,
          transition.reason ?? null,
          transition.error ?? null,
          now,
          record.driverId,
          record.generation,
        );
      repaired.push(this.require(record.driverId));
    }
    return repaired;
  }

  async gcHiddenSessions(
    now = new Date().toISOString(),
    removeSessionPath: (path: string) => Promise<void> = async (path) => {
      await rm(path, { force: true });
    },
  ): Promise<SparkDriverHiddenSessionGcResult> {
    const rows = this.#db
      .prepare(
        `SELECT execution_session_id, session_path
         FROM driver_hidden_sessions
         WHERE status = 'archived' AND gc_after IS NOT NULL AND gc_after <= ?
         ORDER BY gc_after, execution_session_id`,
      )
      .all(now) as unknown as HiddenSessionGcRow[];
    const result: SparkDriverHiddenSessionGcResult = {
      examined: rows.length,
      deleted: 0,
      errors: [],
    };
    for (const row of rows) {
      try {
        if (row.session_path) await removeSessionPath(row.session_path);
        result.deleted += Number(
          this.#db
            .prepare(
              `DELETE FROM driver_hidden_sessions
               WHERE execution_session_id = ? AND status = 'archived'
                 AND gc_after IS NOT NULL AND gc_after <= ?`,
            )
            .run(row.execution_session_id, now).changes,
        );
      } catch (error) {
        result.errors.push({
          executionSessionId: row.execution_session_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  mutationResult(record: SparkDriverRecord): SparkDriverMutationResult {
    return sparkDriverMutationResultSchema.parse({
      driver: driverView(record),
      observedAt: new Date().toISOString(),
    });
  }

  private transition(
    driverId: string,
    status: SparkDriverStatus,
    options: {
      reason?: string;
      dueAt?: string;
      prompt?: string;
      clearDue?: boolean;
      clearError?: boolean;
      resetAttempt?: boolean;
      incrementGeneration?: boolean;
      now?: string;
    },
  ): SparkDriverRecord {
    const now = options.now ?? new Date().toISOString();
    this.require(driverId);
    this.#db
      .prepare(
        `UPDATE driver_wakeups SET status = ?,
           generation = generation + ?,
           due_at = ?,
           attempt = CASE WHEN ? THEN 0 ELSE attempt END,
           reason = ?,
           error = CASE WHEN ? THEN NULL ELSE error END,
           prompt = COALESCE(?, prompt),
           updated_at = ?
         WHERE driver_id = ?`,
      )
      .run(
        status,
        options.incrementGeneration ? 1 : 0,
        options.clearDue ? null : (options.dueAt ?? null),
        options.resetAttempt ? 1 : 0,
        options.reason ?? null,
        options.clearError ? 1 : 0,
        options.prompt ?? null,
        now,
        driverId,
      );
    return this.require(driverId);
  }
}

export function driverUpdateEvent(
  record: SparkDriverRecord | SparkDriverView,
  invocationId?: string,
): SparkDaemonEvent {
  const driver = "route" in record ? driverView(record) : sparkDriverViewSchema.parse(record);
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.view_event",
    source: "daemon",
    emittedAt: new Date().toISOString(),
    sessionId: driver.ownerSessionId,
    ...(invocationId ? { invocationId } : {}),
    view: {
      version: SPARK_PROTOCOL_VERSION,
      type: "driver.update",
      sessionId: driver.ownerSessionId,
      driver,
    },
    metadata: { stateOwnerSessionId: driver.ownerSessionId },
  };
}

function driverTickTask(record: SparkDriverRecord): SparkDaemonDriverTickTask {
  const executionSessionId =
    record.continuity === "fresh" ? driverExecutionSessionId(record) : record.ownerSessionId;
  return {
    type: "driver.tick",
    sessionId: record.ownerSessionId,
    driverId: record.driverId,
    kind: record.kind,
    ownerSessionId: record.ownerSessionId,
    generation: record.generation,
    continuity: record.continuity,
    prompt: record.wakePrompt ?? record.prompt,
    cwd: record.route.cwd,
    workspaceBindingId: record.route.workspaceBindingId,
    workspaceId: record.route.workspaceId,
    projectId: record.route.projectId,
    stateOwnerSessionId: record.ownerSessionId,
    ...(record.continuity === "fresh" ? { executionSessionId, reset: true } : {}),
  };
}

function driverExecutionSessionId(
  record: Pick<SparkDriverRecord, "driverId" | "generation">,
): string {
  const driverHash = createHash("sha256").update(record.driverId).digest("hex").slice(0, 24);
  return `driver_${driverHash}_${record.generation}`;
}

function resultSessionPath(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = (result as Record<string, unknown>).sessionPath;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function completionTransition(
  record: SparkDriverRecord,
  completion: CompleteSparkInvocationInput,
  now: string,
): {
  status: SparkDriverStatus;
  dueAt?: string;
  attempt: number;
  reason?: string;
  error?: string;
} {
  if (completion.status === "cancelled") {
    return {
      status: "blocked",
      attempt: record.attempt,
      reason: "manual abort",
      error: completion.cancelReason ?? "driver tick cancelled",
    };
  }
  if (completion.status === "failed") {
    const error = completion.errorMessage ?? completion.errorCode ?? "driver tick failed";
    if (!safeToRetry(completion.errorCode)) {
      return {
        status: "blocked",
        attempt: record.attempt,
        reason: "failure outcome is not safe to replay",
        error,
      };
    }
    const attempt = record.attempt + 1;
    const policy = sparkDriverPolicy(record.kind);
    return {
      status: "retry_wait",
      dueAt: new Date(
        Date.parse(now) +
          policy.retryDelaysMs[
            Math.min(Math.max(0, attempt - 1), policy.retryDelaysMs.length - 1)
          ]!,
      ).toISOString(),
      attempt,
      reason: "safe transient failure",
      error,
    };
  }
  const success = sparkDriverPolicy(record.kind).success;
  return {
    status: success.status,
    ...(success.status === "dormant"
      ? {}
      : { dueAt: new Date(Date.parse(now) + success.delayMs).toISOString() }),
    attempt: 0,
    reason:
      record.kind === "loop"
        ? "tick completed without an explicit driver.schedule"
        : "tick completed",
  };
}

function safeToRetry(errorCode: string | undefined): boolean {
  return isRetryableInvocationError(errorCode);
}

function driverLane(kind: SparkDriverKind): SparkDriverRecord["lane"] {
  if (kind === "workflow") return "background";
  if (kind === "session_todo") return "fallback";
  return "foreground";
}

function normalizeRoute(input: SparkDriverRoute): SparkDriverRoute {
  return {
    cwd: required(input.cwd, "cwd"),
    ...(input.workspaceBindingId?.trim()
      ? { workspaceBindingId: input.workspaceBindingId.trim() }
      : {}),
    ...(input.workspaceId?.trim() ? { workspaceId: input.workspaceId.trim() } : {}),
    ...(input.projectId?.trim() ? { projectId: input.projectId.trim() } : {}),
  };
}

function driverRecord(row: DriverRow): SparkDriverRecord {
  const route = JSON.parse(row.route_json) as SparkDriverRoute;
  return {
    driverId: row.driver_id,
    kind: row.kind,
    lane: row.lane,
    ownerSessionId: row.owner_session_id,
    status: row.status,
    continuity: row.continuity,
    ...(row.due_at ? { dueAt: row.due_at } : {}),
    attempt: Number(row.attempt),
    ...(row.last_invocation_id ? { lastInvocationId: row.last_invocation_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.error ? { error: row.error } : {}),
    generation: Number(row.generation),
    prompt: row.prompt,
    ...(row.wake_prompt ? { wakePrompt: row.wake_prompt } : {}),
    route,
    ...(row.domain_state_digest ? { domainStateDigest: row.domain_state_digest } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function driverView(record: SparkDriverRecord): SparkDriverView {
  return sparkDriverViewSchema.parse({
    driverId: record.driverId,
    kind: record.kind,
    ownerSessionId: record.ownerSessionId,
    status: record.status,
    continuity: record.continuity,
    dueAt: record.dueAt,
    attempt: record.attempt,
    lastInvocationId: record.lastInvocationId,
    reason: record.reason,
    error: record.error,
  });
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`DRIVER_INVALID: ${field} is required`);
  return normalized;
}
