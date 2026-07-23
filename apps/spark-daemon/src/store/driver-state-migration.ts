import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stableId } from "@zendev-lab/spark-core";
import {
  sessionGoalStorePathV2,
  sessionLoopStorePathV2,
  sessionReproStorePathV2,
  sessionStateStorePath,
} from "@zendev-lab/spark-loop";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { defaultWorkflowRunStore } from "@zendev-lab/spark-workflows";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import { SparkDriverStore } from "./drivers.ts";

const MIGRATION_KEY = "migration.daemon-autonomous-drivers-v1";

export interface DriverStateMigrationReport {
  sessions: number;
  imported: Record<"goal" | "loop" | "repro" | "implement" | "workflow", number>;
  strippedLegacyRuntimeFields: number;
}

/**
 * One-way hard cut from frontend-owned cadence fields to daemon wakeups.
 * The marker is written only after every state file and wakeup transition
 * succeeds, so a crash reruns the migration without creating duplicate ticks.
 */
export async function migrateLegacyDriverState(input: {
  db: DatabaseSync;
  driverStore: SparkDriverStore;
  sessionRegistry?: Pick<DaemonSessionRegistry, "list">;
  resolveWorkspaceCwd?: (workspaceId: string) => string | undefined;
  now?: string;
}): Promise<DriverStateMigrationReport | undefined> {
  if (!input.sessionRegistry) return undefined;
  const migrateRuntimeFields = !migrationComplete(input.db);
  const now = input.now ?? new Date().toISOString();
  const sessions = await input.sessionRegistry.list({ includeArchived: false });
  const report: DriverStateMigrationReport = {
    sessions: sessions.length,
    imported: { goal: 0, loop: 0, repro: 0, implement: 0, workflow: 0 },
    strippedLegacyRuntimeFields: 0,
  };
  const migratedWorkflowCwds = new Set<string>();

  for (const session of sessions) {
    const cwd = sessionCwd(session, input.resolveWorkspaceCwd);
    if (!cwd) continue;
    const ctx = { sessionId: session.sessionId };
    const goalPath = sessionGoalStorePathV2(cwd, ctx);
    const loopPath = sessionLoopStorePathV2(cwd, ctx);
    const reproPath = sessionReproStorePathV2(cwd, ctx);
    const statePath = sessionStateStorePath(cwd, ctx);
    const goalSnapshot = await readObject(goalPath);
    const loopSnapshot = await readObject(loopPath);
    const reproSnapshot = await readObject(reproPath);
    const stateSnapshot = await readObject(statePath);
    const goal = objectField(goalSnapshot, "goal");
    const loop = objectField(loopSnapshot, "loop");
    const repro = objectField(reproSnapshot, "repro");

    // Preserve the old precedence while materializing every legacy driver row:
    // implement < loop < goal < repro. Starting later foreground drivers
    // atomically stops the earlier row.
    if (stateSnapshot?.phase === "implement") {
      if (
        importDriver(input.driverStore, {
          driverId: `implement:${session.sessionId}`,
          kind: "implement",
          ownerSessionId: session.sessionId,
          cwd,
          prompt: renderImplementPrompt(),
          dueAt: now,
          reason: "migrated standalone implement phase",
        })
      )
        report.imported.implement += 1;
    }
    if (loop?.status === "active" && stringField(loop, "loopId")) {
      const retry = legacyRetryState(loop, now, 0);
      if (
        importDriver(input.driverStore, {
          driverId: stringField(loop, "loopId")!,
          kind: "loop",
          ownerSessionId: session.sessionId,
          cwd,
          prompt: renderLoopPrompt(stringField(loop, "objective") ?? "Continue the active loop."),
          dueAt: legacyLoopDueAt(loop, now),
          initialStatus: retry.status,
          initialAttempt: retry.attempt,
          reason: "migrated active loop",
        })
      )
        report.imported.loop += 1;
    }
    if (goal?.status === "active" && stringField(goal, "goalId")) {
      const retry = legacyRetryState(goal, now, 30_000);
      if (
        importDriver(input.driverStore, {
          driverId: stringField(goal, "goalId")!,
          kind: "goal",
          ownerSessionId: session.sessionId,
          cwd,
          prompt: renderGoalPrompt(stringField(goal, "objective") ?? "Complete the active goal."),
          dueAt: retry.dueAt,
          initialStatus: retry.status,
          initialAttempt: retry.attempt,
          reason: "migrated active goal",
        })
      )
        report.imported.goal += 1;
    }
    if (repro?.status === "active" && stringField(repro, "reproId")) {
      const retry = legacyRetryState(repro, now, 30_000);
      if (
        importDriver(input.driverStore, {
          driverId: stringField(repro, "reproId")!,
          kind: "repro",
          ownerSessionId: session.sessionId,
          cwd,
          prompt: renderReproPrompt(stringField(repro, "objective")),
          dueAt: retry.dueAt,
          initialStatus: retry.status,
          initialAttempt: retry.attempt,
          reason: "migrated active repro",
        })
      )
        report.imported.repro += 1;
    }

    if (migrateRuntimeFields) {
      report.strippedLegacyRuntimeFields += await stripRuntimeFields(
        goalPath,
        goalSnapshot,
        "goal",
      );
      report.strippedLegacyRuntimeFields += await stripRuntimeFields(
        loopPath,
        loopSnapshot,
        "loop",
      );
      report.strippedLegacyRuntimeFields += await stripRuntimeFields(
        reproPath,
        reproSnapshot,
        "repro",
      );
    }

    if (!migratedWorkflowCwds.has(cwd)) {
      const control = await defaultWorkflowRunStore(cwd).loadControl();
      if (control?.status === "running") {
        if (
          importDriver(input.driverStore, {
            driverId: `workflow:${stableId(`${cwd}:${session.sessionId}`)}`,
            kind: "workflow",
            ownerSessionId: session.sessionId,
            cwd,
            prompt: renderWorkflowPrompt(),
            dueAt: now,
            reason: "migrated running workflow",
          })
        )
          report.imported.workflow += 1;
      }
      migratedWorkflowCwds.add(cwd);
    }
  }

  if (migrateRuntimeFields) {
    writeMigrationReport(input.db, report, now);
    return report;
  }
  return undefined;
}

function importDriver(
  store: SparkDriverStore,
  input: Parameters<SparkDriverStore["start"]>[0],
): boolean {
  if (store.get(input.driverId!)) return false;
  store.start(input);
  return true;
}

async function stripRuntimeFields(
  path: string,
  snapshot: Record<string, unknown> | undefined,
  field: "goal" | "loop" | "repro",
): Promise<number> {
  const state = objectField(snapshot, field);
  if (!snapshot || !state) return 0;
  let changed = false;
  const canonical = { ...state };
  for (const key of ["schedule", "retryState"]) {
    if (key in canonical) {
      delete canonical[key];
      changed = true;
    }
  }
  if (!changed) return 0;
  await writeJsonAtomic(path, { ...snapshot, [field]: canonical });
  return 1;
}

function legacyLoopDueAt(loop: Record<string, unknown>, now: string): string {
  const schedule = objectField(loop, "schedule");
  return stringField(schedule, "nextRunAt") ?? now;
}

function legacyRetryState(
  state: Record<string, unknown>,
  now: string,
  fallbackDelayMs: number,
): {
  dueAt: string;
  status: "scheduled" | "retry_wait";
  attempt: number;
} {
  const retry = objectField(state, "retryState");
  const attempt = Math.max(0, Math.trunc(numberField(retry, "consecutiveFailures") ?? 0));
  const lastFailureAt = stringField(retry, "lastFailureAt");
  const nextDelayMs = numberField(retry, "nextDelayMs");
  if (lastFailureAt && nextDelayMs !== undefined) {
    const base = Date.parse(lastFailureAt);
    if (Number.isFinite(base)) {
      return {
        dueAt: new Date(base + Math.max(0, nextDelayMs)).toISOString(),
        status: attempt > 0 ? "retry_wait" : "scheduled",
        attempt,
      };
    }
  }
  return {
    dueAt: new Date(Date.parse(now) + fallbackDelayMs).toISOString(),
    status: attempt > 0 ? "retry_wait" : "scheduled",
    attempt,
  };
}

function renderGoalPrompt(objective: string): string {
  return [
    "Continue the daemon-owned Spark goal by one concrete turn.",
    `Goal: ${objective}`,
    'When fully verified, call goal({ action: "complete", reason, requirements, validationRuns, unresolved }) for reviewer gating.',
  ].join("\n");
}

function renderLoopPrompt(objective: string): string {
  return [
    "Continue the daemon-owned Spark loop by one concrete turn.",
    `Loop objective: ${objective}`,
    'Before ending, call loop({ action: "schedule", delayMs, reason }); otherwise the driver becomes dormant.',
  ].join("\n");
}

function renderReproPrompt(objective: string | undefined): string {
  return [
    "Advance the daemon-owned Spark reproduction contract by one evidence-backed turn.",
    objective ? `Objective: ${objective}` : undefined,
    'Use repro({ action: "status" }) and persist proof before advancing.',
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderImplementPrompt(): string {
  return [
    "Continue the current Spark implementation frontier by one turn.",
    "Work through ready tasks until no safe ready work remains.",
    'Before ending, call driver({ action: "schedule", delayMs: 0, reason }) only if concrete ready work remains; otherwise call driver({ action: "stop", reason }). Omitting both leaves the driver dormant.',
  ].join("\n");
}

function renderWorkflowPrompt(): string {
  return [
    "Advance the active Spark workflow scheduler by exactly one daemon-owned tick.",
    'Call workflow_driver({ action: "tick" }) exactly once.',
  ].join("\n");
}

function sessionCwd(
  session: SparkSessionRegistryRecord,
  resolveWorkspaceCwd: ((workspaceId: string) => string | undefined) | undefined,
): string | undefined {
  const cwd = session.cwd?.trim();
  if (cwd && cwd !== "/") return cwd;
  if (session.scope.kind !== "workspace") return undefined;
  return resolveWorkspaceCwd?.(session.scope.workspaceId);
}

async function readObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isObject(value) ? value : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.driver-migration-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function objectField(
  value: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | undefined {
  const nested = value?.[field];
  return isObject(nested) ? nested : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const nested = value?.[field];
  return typeof nested === "string" && nested.trim() ? nested : undefined;
}

function numberField(
  value: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const nested = value?.[field];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function migrationComplete(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM daemon_meta WHERE key = ?").get(MIGRATION_KEY));
}

function writeMigrationReport(
  db: DatabaseSync,
  report: DriverStateMigrationReport,
  now: string,
): void {
  db.prepare(
    `INSERT INTO daemon_meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(MIGRATION_KEY, JSON.stringify(report), now);
}
