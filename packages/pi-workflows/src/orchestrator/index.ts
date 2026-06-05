import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  newRef,
  nowIso,
  type RunRef,
  type TaskRef,
  type TaskRun,
  type TaskRunCompletionSummary,
  type ProjectRef,
  writeJsonFileAtomic,
} from "pi-extension-api";
import type { TaskGraph } from "pi-tasks";

import {
  collectSparkDagRunNextSteps,
  completionDigestFromTaskRuns,
  createSparkDagCompletionFollowUp,
} from "./dag-run-completion.ts";
import { reconcileDagRunCounters } from "./dag-run-counters.ts";
import { reconcileSparkDagRunSnapshot } from "./dag-run-reconcile.ts";
import {
  normalizeSparkDagRunPruneOptions,
  planSparkDagRunPrune,
  type SparkDagRunPruneOptions,
  type SparkDagRunPruneResult,
} from "./dag-run-retention.ts";
import {
  isAcknowledgeableDagRun,
  isAcknowledgedDagRunProblem,
  isActionableDagRunProblem,
  isTerminalDagRunStatus,
} from "./dag-run-status.ts";
import { emptySparkDagRunSnapshot, loadSparkDagRunStoreSnapshot } from "./dag-run-serialization.ts";

export {
  DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
} from "pi-extension-api";
export { sparkDagRunNextSteps } from "./dag-run-completion.ts";
export { SparkDagRunStoreFormatError } from "./dag-run-serialization.ts";
export type {
  SparkDagRunPruneOptions,
  SparkDagRunPruneResult,
  SparkDagRunRetentionCandidateReason,
  SparkDagRunRetentionEntry,
  SparkDagRunRetentionKeepReason,
} from "./dag-run-retention.ts";
export {
  runReadySparkTasks,
  type SparkReadyTaskRun,
  type SparkReadyTaskRunInput,
  type SparkReadyTaskRunKiller,
  type SparkReadyTaskRunKillerInput,
  type SparkReadyTaskRunnerOptions,
  type SparkReadyTaskRunnerProgress,
  type SparkReadyTaskRunnerResult,
  type SparkReadyTaskRunnerSchedule,
} from "./ready-task-runner.ts";

export type SparkDagManagerStatus = "idle" | "running" | "failed";
export type SparkDagRunStatus = "running" | "succeeded" | "failed" | "timed_out" | "stale";

export interface SparkDagManagerState {
  status: SparkDagManagerStatus;
  activeRunRef?: RunRef;
  lastRunRef?: RunRef;
  updatedAt: string;
}

export interface SparkDagCompletionFollowUp {
  createdAt: string;
  runRef: RunRef;
  status: SparkDagRunStatus;
  scheduled: number;
  completed: number;
  summary: string;
  nextActions: string[];
  completionDigest: TaskRunCompletionSummary[];
}

export interface SparkDagRunNextSteps {
  runRef: RunRef;
  status: Extract<SparkDagRunStatus, "failed" | "stale" | "timed_out">;
  summary: string;
  nextActions: string[];
}

export interface SparkDagRunAcknowledgeInput {
  runRef?: RunRef;
  sessionId: string;
  now?: string;
}

export interface SparkDagRunAcknowledgeResult {
  snapshot: SparkDagRunStoreSnapshot;
  acknowledged: RunRef[];
  alreadyAcknowledged: RunRef[];
  skipped: RunRef[];
  missing: RunRef[];
}

export interface SparkDagRunRecord {
  ref: RunRef;
  projectRef?: ProjectRef;
  ownerSessionId?: string;
  dryRun: boolean;
  maxConcurrency: number;
  timeoutMs: number;
  status: SparkDagRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  scheduled: number;
  completed: number;
  timedOut: boolean;
  scheduledTaskRefs: TaskRef[];
  completedTaskRefs: TaskRef[];
  taskRunRefs: RunRef[];
  errorMessage?: string;
  acknowledgedAt?: string;
  acknowledgedBySession?: string;
  completionDigest: TaskRunCompletionSummary[];
  completionFollowUp?: SparkDagCompletionFollowUp;
}

export interface SparkDagRunStoreSnapshot {
  version: 1;
  manager: SparkDagManagerState;
  runs: SparkDagRunRecord[];
}

export interface SparkDagStatusSummary {
  manager: SparkDagManagerState;
  activeRun?: SparkDagRunRecord;
  actionableRun?: SparkDagRunRecord;
  lastRun?: SparkDagRunRecord;
  recentRuns: SparkDagRunRecord[];
  running: number;
  succeeded: number;
  failed: number;
  stale: number;
  timedOut: number;
  acknowledged: number;
  actionable: number;
  nextSteps: SparkDagRunNextSteps[];
}

export interface SparkDagStatusQueryOptions {
  limit?: number;
}

export interface SparkDagRunReconcileInput {
  graph?: TaskGraph;
  activeRunRefs?: Iterable<RunRef>;
  now?: string;
}

export interface SparkDagRunStartInput {
  projectRef?: ProjectRef;
  ownerSessionId?: string;
  dryRun: boolean;
  maxConcurrency: number;
  timeoutMs: number;
}

export interface SparkDagRunScheduleInput {
  taskRef: TaskRef;
  runRef?: RunRef;
  scheduled: number;
}

export interface SparkDagRunProgressInput {
  taskRef: TaskRef;
  run: TaskRun;
  completed: number;
}

export interface SparkDagRunFinishInput {
  scheduled: number;
  completed: number;
  timedOut: boolean;
  failed?: number;
  cancelled?: number;
  foregroundTimedOut?: boolean;
  detached?: boolean;
  runs?: TaskRun[];
}

export class SparkDagRunStore {
  readonly filePath: string;
  readonly lockPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  async status(options: SparkDagStatusQueryOptions = {}): Promise<SparkDagStatusSummary> {
    return summarizeSparkDagRuns(await this.load(), options);
  }

  async clearInactiveRuns(): Promise<SparkDagRunStoreSnapshot> {
    let cleared: SparkDagRunStoreSnapshot | undefined;
    await this.updateSnapshot((snapshot) => {
      snapshot.runs = snapshot.runs.filter(shouldKeepDagRunWhenClearingInactive);
      const activeRun =
        snapshot.manager.activeRunRef &&
        snapshot.runs.find(
          (run) => run.ref === snapshot.manager.activeRunRef && run.status === "running",
        );
      const runningRun = activeRun ?? latestRunningDagRun(snapshot.runs);
      snapshot.manager.activeRunRef = runningRun?.ref;
      snapshot.manager.lastRunRef = runningRun?.ref ?? snapshot.runs.at(-1)?.ref;
      snapshot.manager.status = runningRun ? "running" : "idle";
      snapshot.manager.updatedAt = nowIso();
      cleared = snapshot;
    });
    return cleared ?? (await this.load());
  }

  async pruneRuns(options: SparkDagRunPruneOptions = {}): Promise<SparkDagRunPruneResult> {
    const normalized = normalizeSparkDagRunPruneOptions(options);
    if (normalized.dryRun) {
      const snapshot = await this.load();
      return planSparkDagRunPrune(snapshot, normalized);
    }
    let result: SparkDagRunPruneResult | undefined;
    await this.updateSnapshot((snapshot) => {
      result = planSparkDagRunPrune(snapshot, normalized);
      const deletedRefs = new Set(result.candidates.map((candidate) => candidate.ref));
      snapshot.runs = snapshot.runs.filter((run) => !deletedRefs.has(run.ref));
      if (
        snapshot.manager.activeRunRef &&
        !snapshot.runs.some((run) => run.ref === snapshot.manager.activeRunRef)
      ) {
        snapshot.manager.activeRunRef = undefined;
      }
      if (
        snapshot.manager.lastRunRef &&
        !snapshot.runs.some((run) => run.ref === snapshot.manager.lastRunRef)
      ) {
        snapshot.manager.lastRunRef = snapshot.runs.at(-1)?.ref;
      }
      if (!snapshot.manager.activeRunRef && deletedRefs.has(result.snapshot.manager.lastRunRef!))
        snapshot.manager.status = "idle";
      if (snapshot.manager.activeRunRef) snapshot.manager.status = "running";
      if (deletedRefs.size > 0) snapshot.manager.updatedAt = nowIso();
      result = {
        ...result,
        snapshot,
        after: snapshot.runs.length,
        deleted: result.candidates,
      };
    });
    return result ?? planSparkDagRunPrune(await this.load(), normalized);
  }

  async acknowledgeFailures(
    input: SparkDagRunAcknowledgeInput,
  ): Promise<SparkDagRunAcknowledgeResult> {
    const now = input.now ?? nowIso();
    const result: SparkDagRunAcknowledgeResult = {
      snapshot: emptySparkDagRunSnapshot(),
      acknowledged: [],
      alreadyAcknowledged: [],
      skipped: [],
      missing: [],
    };
    await this.updateSnapshot((snapshot) => {
      const targets = input.runRef
        ? snapshot.runs.filter((run) => run.ref === input.runRef)
        : snapshot.runs.filter(isAcknowledgeableDagRun);
      if (input.runRef && targets.length === 0) result.missing.push(input.runRef);
      for (const record of targets) {
        if (!isAcknowledgeableDagRun(record)) {
          result.skipped.push(record.ref);
          continue;
        }
        if (record.acknowledgedAt) {
          result.alreadyAcknowledged.push(record.ref);
          continue;
        }
        record.acknowledgedAt = now;
        record.acknowledgedBySession = input.sessionId;
        record.updatedAt = now;
        result.acknowledged.push(record.ref);
      }
      if (result.acknowledged.length > 0) {
        if (!snapshot.manager.activeRunRef) snapshot.manager.status = "idle";
        snapshot.manager.updatedAt = now;
      }
      result.snapshot = snapshot;
    });
    return result;
  }

  async reconcile(input: SparkDagRunReconcileInput = {}): Promise<SparkDagRunStoreSnapshot> {
    const activeRunRefs = new Set(input.activeRunRefs ?? []);
    const now = input.now ?? nowIso();
    let reconciled: SparkDagRunStoreSnapshot | undefined;
    await this.updateSnapshot((snapshot) => {
      reconcileSparkDagRunSnapshot(snapshot, {
        graph: input.graph,
        activeRunRefs,
        now,
      });
      reconciled = snapshot;
    });
    return reconciled ?? (await this.load());
  }

  async load(): Promise<SparkDagRunStoreSnapshot> {
    return loadSparkDagRunStoreSnapshot(this.filePath);
  }

  async save(snapshot: SparkDagRunStoreSnapshot): Promise<void> {
    await writeJsonFileAtomic(this.filePath, snapshot);
  }

  async startRun(input: SparkDagRunStartInput): Promise<SparkDagRunRecord> {
    let created: SparkDagRunRecord | undefined;
    await this.updateSnapshot((snapshot) => {
      const now = nowIso();
      const record: SparkDagRunRecord = {
        ref: newRef("run"),
        projectRef: input.projectRef,
        ownerSessionId: input.ownerSessionId,
        dryRun: input.dryRun,
        maxConcurrency: input.maxConcurrency,
        timeoutMs: input.timeoutMs,
        status: "running",
        startedAt: now,
        updatedAt: now,
        scheduled: 0,
        completed: 0,
        timedOut: false,
        scheduledTaskRefs: [],
        completedTaskRefs: [],
        taskRunRefs: [],
        completionDigest: [],
      };
      snapshot.manager = {
        status: "running",
        activeRunRef: record.ref,
        lastRunRef: record.ref,
        updatedAt: now,
      };
      snapshot.runs = [...snapshot.runs, record];
      created = record;
    });
    if (!created) throw new Error("failed to start Spark workflow run");
    return created;
  }

  async recordSchedule(runRef: RunRef, input: SparkDagRunScheduleInput): Promise<void> {
    await this.updateRun(runRef, (record) => {
      if (isTerminalDagRunStatus(record.status)) return false;
      if (!record.scheduledTaskRefs.includes(input.taskRef))
        record.scheduledTaskRefs.push(input.taskRef);
      if (input.runRef && !record.taskRunRefs.includes(input.runRef))
        record.taskRunRefs.push(input.runRef);
      reconcileDagRunCounters(record, { scheduledFallback: input.scheduled });
      return true;
    });
  }

  async recordProgress(runRef: RunRef, input: SparkDagRunProgressInput): Promise<void> {
    await this.updateRun(runRef, (record) => {
      if (isTerminalDagRunStatus(record.status)) return false;
      if (!record.completedTaskRefs.includes(input.taskRef))
        record.completedTaskRefs.push(input.taskRef);
      if (!record.taskRunRefs.includes(input.run.ref)) record.taskRunRefs.push(input.run.ref);
      reconcileDagRunCounters(record, { completedFallback: input.completed });
      return true;
    });
  }

  async finishRun(
    runRef: RunRef,
    result: SparkDagRunFinishInput,
    error?: unknown,
  ): Promise<SparkDagCompletionFollowUp | undefined> {
    let followUp: SparkDagCompletionFollowUp | undefined;
    await this.updateSnapshot((snapshot) => {
      const now = nowIso();
      const record = snapshot.runs.find((candidate) => candidate.ref === runRef);
      if (!record) return;
      const failedChildren = result.failed ?? 0;
      const cancelledChildren = result.cancelled ?? 0;
      const hasFailedChildren = failedChildren > 0 || cancelledChildren > 0;
      if (isTerminalDagRunStatus(record.status)) {
        followUp = record.completionFollowUp;
        return;
      }
      const foregroundDetached =
        Boolean(result.foregroundTimedOut || result.detached) && !error && !hasFailedChildren;
      record.timedOut = result.timedOut && !foregroundDetached;
      reconcileDagRunCounters(record, {
        scheduledFallback: result.scheduled,
        completedFallback: result.completed,
      });
      if (foregroundDetached && record.completed < record.scheduled) {
        record.status = "running";
        record.errorMessage = undefined;
        record.finishedAt = undefined;
        record.updatedAt = now;
        snapshot.manager = {
          status: "running",
          activeRunRef: runRef,
          lastRunRef: runRef,
          updatedAt: now,
        };
        return;
      }
      record.status = error
        ? "failed"
        : record.timedOut
          ? "timed_out"
          : hasFailedChildren
            ? "failed"
            : "succeeded";
      record.errorMessage =
        error instanceof Error
          ? error.message
          : error
            ? JSON.stringify(error)
            : hasFailedChildren
              ? `Spark workflow child runs failed: failed=${failedChildren} cancelled=${cancelledChildren}`
              : undefined;
      record.finishedAt = now;
      record.updatedAt = now;
      record.completionDigest = completionDigestFromTaskRuns(result.runs ?? []);
      followUp = createSparkDagCompletionFollowUp(record);
      record.completionFollowUp = followUp;
      snapshot.manager = {
        status: error ? "failed" : "idle",
        activeRunRef:
          snapshot.manager.activeRunRef === runRef ? undefined : snapshot.manager.activeRunRef,
        lastRunRef: runRef,
        updatedAt: now,
      };
    });
    return followUp;
  }

  private async updateRun(
    runRef: RunRef,
    update: (record: SparkDagRunRecord) => boolean | void,
  ): Promise<void> {
    await this.updateSnapshot((snapshot) => {
      const record = snapshot.runs.find((candidate) => candidate.ref === runRef);
      if (!record) return;
      const changed = update(record);
      if (changed === false) return;
      record.updatedAt = nowIso();
    });
  }

  private async updateSnapshot(
    update: (snapshot: SparkDagRunStoreSnapshot) => void,
  ): Promise<void> {
    await this.withLock(async () => {
      const snapshot = await this.load();
      update(snapshot);
      for (const record of snapshot.runs) reconcileDagRunCounters(record);
      await this.save(snapshot);
    });
  }

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await acquireSparkDagRunStoreLock(this.lockPath);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

function shouldKeepDagRunWhenClearingInactive(run: SparkDagRunRecord): boolean {
  return run.status === "running" || isActionableDagRunProblem(run);
}

function latestRunningDagRun(runs: SparkDagRunRecord[]): SparkDagRunRecord | undefined {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run?.status === "running") return run;
  }
  return undefined;
}

async function acquireSparkDagRunStoreLock(lockPath: string): Promise<() => Promise<void>> {
  const timeoutMs = 10_000;
  const retryIntervalMs = 25;
  const staleMs = 60_000;
  const started = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleSparkDagRunStoreLock(lockPath, staleMs);
      if (Date.now() - started >= timeoutMs)
        throw new Error(`timed out waiting for Spark DAG run store lock: ${lockPath}`);
      await sleep(retryIntervalMs);
    }
  }
}

async function removeStaleSparkDagRunStoreLock(lockPath: string, staleMs: number): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs >= staleMs) await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function defaultSparkDagRunStore(cwd: string): SparkDagRunStore {
  return new SparkDagRunStore(join(cwd, ".spark", "workflow-runs.json"));
}

export function summarizeSparkDagRuns(
  snapshot: SparkDagRunStoreSnapshot,
  options: SparkDagStatusQueryOptions = {},
): SparkDagStatusSummary {
  const sorted = [...snapshot.runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const limit = Number.isFinite(options.limit ?? 5)
    ? Math.max(1, Math.floor(options.limit ?? 5))
    : 5;
  const activeRun = snapshot.manager.activeRunRef
    ? snapshot.runs.find((run) => run.ref === snapshot.manager.activeRunRef)
    : undefined;
  const lastRun = snapshot.manager.lastRunRef
    ? snapshot.runs.find((run) => run.ref === snapshot.manager.lastRunRef)
    : sorted[0];
  const recentRuns = sorted.slice(0, limit);
  const actionableRuns = sorted.filter(isActionableDagRunProblem);
  const actionableRun = actionableRuns[0];
  return {
    manager: snapshot.manager,
    activeRun,
    actionableRun,
    lastRun,
    recentRuns,
    running: snapshot.runs.filter((run) => run.status === "running").length,
    succeeded: snapshot.runs.filter((run) => run.status === "succeeded").length,
    failed: snapshot.runs.filter((run) => run.status === "failed").length,
    stale: snapshot.runs.filter((run) => run.status === "stale").length,
    timedOut: snapshot.runs.filter((run) => run.status === "timed_out").length,
    acknowledged: snapshot.runs.filter(isAcknowledgedDagRunProblem).length,
    actionable: actionableRuns.length,
    nextSteps: collectSparkDagRunNextSteps([actionableRun, lastRun, ...recentRuns]),
  };
}
