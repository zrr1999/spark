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
} from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";

import {
  collectWorkflowRunNextSteps,
  completionDigestFromTaskRuns,
  createWorkflowRunCompletionFollowUp,
} from "./workflow-run-completion.ts";
import { reconcileWorkflowRunCounters } from "./workflow-run-counters.ts";
import { reconcileWorkflowRunSnapshot } from "./workflow-run-reconcile.ts";
import {
  normalizeWorkflowRunPruneOptions,
  planWorkflowRunPrune,
  type WorkflowRunPruneOptions,
  type WorkflowRunPruneResult,
} from "./workflow-run-retention.ts";
import {
  isAcknowledgeableWorkflowRun,
  isAcknowledgedWorkflowRunProblem,
  isActionableWorkflowRunProblem,
  isTerminalWorkflowRunStatus,
} from "./workflow-run-status.ts";
import {
  emptyWorkflowRunSnapshot,
  loadWorkflowRunStoreSnapshot,
} from "./workflow-run-serialization.ts";

export {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
} from "@zendev-lab/pi-extension-api";
export { workflowRunNextSteps } from "./workflow-run-completion.ts";
export { WorkflowRunStoreFormatError } from "./workflow-run-serialization.ts";
export type {
  WorkflowRunPruneOptions,
  WorkflowRunPruneResult,
  WorkflowRunRetentionCandidateReason,
  WorkflowRunRetentionEntry,
  WorkflowRunRetentionKeepReason,
} from "./workflow-run-retention.ts";
export {
  runReadyTasks,
  type ReadyTaskRun,
  type ReadyTaskRunInput,
  type ReadyTaskRunKiller,
  type ReadyTaskRunKillerInput,
  type ReadyTaskRunnerOptions,
  type ReadyTaskRunnerProgress,
  type ReadyTaskRunnerResult,
  type ReadyTaskRunnerSchedule,
} from "./ready-task-runner.ts";

export type WorkflowRunManagerStatus = "idle" | "running" | "failed";
export type WorkflowRunStatus = "running" | "succeeded" | "failed" | "timed_out" | "stale";

export interface WorkflowRunManagerState {
  status: WorkflowRunManagerStatus;
  activeRunRef?: RunRef;
  lastRunRef?: RunRef;
  updatedAt: string;
}

export interface WorkflowRunCompletionFollowUp {
  createdAt: string;
  runRef: RunRef;
  status: WorkflowRunStatus;
  scheduled: number;
  completed: number;
  summary: string;
  nextActions: string[];
  completionDigest: TaskRunCompletionSummary[];
}

export interface WorkflowRunNextSteps {
  runRef: RunRef;
  status: Extract<WorkflowRunStatus, "failed" | "stale" | "timed_out">;
  summary: string;
  nextActions: string[];
}

export interface WorkflowRunAcknowledgeInput {
  runRef?: RunRef;
  sessionId: string;
  now?: string;
}

export interface WorkflowRunAcknowledgeResult {
  snapshot: WorkflowRunStoreSnapshot;
  acknowledged: RunRef[];
  alreadyAcknowledged: RunRef[];
  skipped: RunRef[];
  missing: RunRef[];
}

export interface WorkflowRunRecord {
  ref: RunRef;
  projectRef?: ProjectRef;
  ownerSessionId?: string;
  dryRun: boolean;
  maxConcurrency: number;
  timeoutMs: number;
  status: WorkflowRunStatus;
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
  completionFollowUp?: WorkflowRunCompletionFollowUp;
}

export interface WorkflowRunStoreSnapshot {
  version: 1;
  manager: WorkflowRunManagerState;
  runs: WorkflowRunRecord[];
  /**
   * Standing background-run control intent for this store. Collapsed here from
   * the former Spark `runMode` marker so there is a single durable
   * background-run representation: the run records (data plane) plus this
   * control block (the scheduler's lifecycle/policy/focus intent).
   */
  control?: WorkflowRunControl;
}

export type WorkflowRunControlStatus =
  | "running"
  | "paused"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface WorkflowRunControl {
  projectRef: ProjectRef;
  focus?: string;
  status: WorkflowRunControlStatus;
  policy: { maxConcurrency: number; timeoutMs: number };
  enteredAt: string;
  updatedAt: string;
}

export interface WorkflowRunControlInput {
  projectRef: ProjectRef;
  focus?: string;
  status?: WorkflowRunControlStatus;
  policy: { maxConcurrency: number; timeoutMs: number };
}

export interface WorkflowRunStatusSummary {
  manager: WorkflowRunManagerState;
  activeRun?: WorkflowRunRecord;
  actionableRun?: WorkflowRunRecord;
  lastRun?: WorkflowRunRecord;
  recentRuns: WorkflowRunRecord[];
  running: number;
  succeeded: number;
  failed: number;
  stale: number;
  timedOut: number;
  acknowledged: number;
  actionable: number;
  nextSteps: WorkflowRunNextSteps[];
}

export interface WorkflowRunStatusQueryOptions {
  limit?: number;
}

export interface WorkflowRunReconcileInput {
  graph?: TaskGraph;
  activeRunRefs?: Iterable<RunRef>;
  now?: string;
}

export interface WorkflowRunStartInput {
  projectRef?: ProjectRef;
  ownerSessionId?: string;
  dryRun: boolean;
  maxConcurrency: number;
  timeoutMs: number;
}

export interface WorkflowRunScheduleInput {
  taskRef: TaskRef;
  runRef?: RunRef;
  scheduled: number;
}

export interface WorkflowRunProgressInput {
  taskRef: TaskRef;
  run: TaskRun;
  completed: number;
}

export interface WorkflowRunFinishInput {
  scheduled: number;
  completed: number;
  timedOut: boolean;
  failed?: number;
  cancelled?: number;
  foregroundTimedOut?: boolean;
  detached?: boolean;
  runs?: TaskRun[];
}

export class WorkflowRunStore {
  readonly filePath: string;
  readonly lockPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  async status(options: WorkflowRunStatusQueryOptions = {}): Promise<WorkflowRunStatusSummary> {
    return summarizeWorkflowRuns(await this.load(), options);
  }

  async clearInactiveRuns(): Promise<WorkflowRunStoreSnapshot> {
    let cleared: WorkflowRunStoreSnapshot | undefined;
    await this.updateSnapshot((snapshot) => {
      snapshot.runs = snapshot.runs.filter(shouldKeepWorkflowRunWhenClearingInactive);
      const activeRun =
        snapshot.manager.activeRunRef &&
        snapshot.runs.find(
          (run) => run.ref === snapshot.manager.activeRunRef && run.status === "running",
        );
      const runningRun = activeRun ?? latestRunningWorkflowRun(snapshot.runs);
      snapshot.manager.activeRunRef = runningRun?.ref;
      snapshot.manager.lastRunRef = runningRun?.ref ?? snapshot.runs.at(-1)?.ref;
      snapshot.manager.status = runningRun ? "running" : "idle";
      snapshot.manager.updatedAt = nowIso();
      cleared = snapshot;
    });
    return cleared ?? (await this.load());
  }

  async pruneRuns(options: WorkflowRunPruneOptions = {}): Promise<WorkflowRunPruneResult> {
    const normalized = normalizeWorkflowRunPruneOptions(options);
    if (normalized.dryRun) {
      const snapshot = await this.load();
      return planWorkflowRunPrune(snapshot, normalized);
    }
    let result: WorkflowRunPruneResult | undefined;
    await this.updateSnapshot((snapshot) => {
      result = planWorkflowRunPrune(snapshot, normalized);
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
    return result ?? planWorkflowRunPrune(await this.load(), normalized);
  }

  async acknowledgeFailures(
    input: WorkflowRunAcknowledgeInput,
  ): Promise<WorkflowRunAcknowledgeResult> {
    const now = input.now ?? nowIso();
    const result: WorkflowRunAcknowledgeResult = {
      snapshot: emptyWorkflowRunSnapshot(),
      acknowledged: [],
      alreadyAcknowledged: [],
      skipped: [],
      missing: [],
    };
    await this.updateSnapshot((snapshot) => {
      const targets = input.runRef
        ? snapshot.runs.filter((run) => run.ref === input.runRef)
        : snapshot.runs.filter(isAcknowledgeableWorkflowRun);
      if (input.runRef && targets.length === 0) result.missing.push(input.runRef);
      for (const record of targets) {
        if (!isAcknowledgeableWorkflowRun(record)) {
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

  async reconcile(input: WorkflowRunReconcileInput = {}): Promise<WorkflowRunStoreSnapshot> {
    const activeRunRefs = new Set(input.activeRunRefs ?? []);
    const now = input.now ?? nowIso();
    let reconciled: WorkflowRunStoreSnapshot | undefined;
    await this.updateSnapshot((snapshot) => {
      reconcileWorkflowRunSnapshot(snapshot, {
        graph: input.graph,
        activeRunRefs,
        now,
      });
      reconciled = snapshot;
    });
    return reconciled ?? (await this.load());
  }

  async load(): Promise<WorkflowRunStoreSnapshot> {
    return loadWorkflowRunStoreSnapshot(this.filePath);
  }

  async save(snapshot: WorkflowRunStoreSnapshot): Promise<void> {
    await writeJsonFileAtomic(this.filePath, snapshot);
  }

  /** Read the standing background-run control intent, if any. */
  async loadControl(): Promise<WorkflowRunControl | undefined> {
    return (await this.load()).control;
  }

  /** Set/replace the standing background-run control intent (status defaults to running). */
  async setControl(input: WorkflowRunControlInput): Promise<WorkflowRunControl> {
    const now = nowIso();
    let control: WorkflowRunControl | undefined;
    await this.updateSnapshot((snapshot) => {
      const existing = snapshot.control;
      const enteredAt =
        existing && existing.projectRef === input.projectRef ? existing.enteredAt : now;
      control = {
        projectRef: input.projectRef,
        focus: input.focus?.trim() || undefined,
        status: input.status ?? "running",
        policy: input.policy,
        enteredAt,
        updatedAt: now,
      };
      snapshot.control = control;
    });
    if (!control) throw new Error("failed to set workflow run control");
    return control;
  }

  /** Update only the status of the standing control intent, preserving policy/focus. */
  async updateControlStatus(
    status: WorkflowRunControlStatus,
  ): Promise<WorkflowRunControl | undefined> {
    let control: WorkflowRunControl | undefined;
    await this.updateSnapshot((snapshot) => {
      if (!snapshot.control) return;
      snapshot.control = { ...snapshot.control, status, updatedAt: nowIso() };
      control = snapshot.control;
    });
    return control;
  }

  /** Drop the standing control intent (e.g. when leaving background-run mode). */
  async clearControl(): Promise<void> {
    await this.updateSnapshot((snapshot) => {
      snapshot.control = undefined;
    });
  }

  async startRun(input: WorkflowRunStartInput): Promise<WorkflowRunRecord> {
    let created: WorkflowRunRecord | undefined;
    await this.updateSnapshot((snapshot) => {
      const now = nowIso();
      const record: WorkflowRunRecord = {
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
    if (!created) throw new Error("failed to start workflow run");
    return created;
  }

  async recordSchedule(runRef: RunRef, input: WorkflowRunScheduleInput): Promise<void> {
    await this.updateRun(runRef, (record) => {
      if (isTerminalWorkflowRunStatus(record.status)) return false;
      if (!record.scheduledTaskRefs.includes(input.taskRef))
        record.scheduledTaskRefs.push(input.taskRef);
      if (input.runRef && !record.taskRunRefs.includes(input.runRef))
        record.taskRunRefs.push(input.runRef);
      reconcileWorkflowRunCounters(record, { scheduledFallback: input.scheduled });
      return true;
    });
  }

  async recordProgress(runRef: RunRef, input: WorkflowRunProgressInput): Promise<void> {
    await this.updateRun(runRef, (record) => {
      if (isTerminalWorkflowRunStatus(record.status)) return false;
      if (!record.completedTaskRefs.includes(input.taskRef))
        record.completedTaskRefs.push(input.taskRef);
      if (!record.taskRunRefs.includes(input.run.ref)) record.taskRunRefs.push(input.run.ref);
      reconcileWorkflowRunCounters(record, { completedFallback: input.completed });
      return true;
    });
  }

  async finishRun(
    runRef: RunRef,
    result: WorkflowRunFinishInput,
    error?: unknown,
  ): Promise<WorkflowRunCompletionFollowUp | undefined> {
    let followUp: WorkflowRunCompletionFollowUp | undefined;
    await this.updateSnapshot((snapshot) => {
      const now = nowIso();
      const record = snapshot.runs.find((candidate) => candidate.ref === runRef);
      if (!record) return;
      const failedChildren = result.failed ?? 0;
      const cancelledChildren = result.cancelled ?? 0;
      const hasFailedChildren = failedChildren > 0 || cancelledChildren > 0;
      if (isTerminalWorkflowRunStatus(record.status)) {
        followUp = record.completionFollowUp;
        return;
      }
      const foregroundDetached =
        Boolean(result.foregroundTimedOut || result.detached) && !error && !hasFailedChildren;
      record.timedOut = result.timedOut && !foregroundDetached;
      reconcileWorkflowRunCounters(record, {
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
              ? `workflow child runs failed: failed=${failedChildren} cancelled=${cancelledChildren}`
              : undefined;
      record.finishedAt = now;
      record.updatedAt = now;
      record.completionDigest = completionDigestFromTaskRuns(result.runs ?? []);
      followUp = createWorkflowRunCompletionFollowUp(record);
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
    update: (record: WorkflowRunRecord) => boolean | void,
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
    update: (snapshot: WorkflowRunStoreSnapshot) => void,
  ): Promise<void> {
    await this.withLock(async () => {
      const snapshot = await this.load();
      update(snapshot);
      for (const record of snapshot.runs) reconcileWorkflowRunCounters(record);
      await this.save(snapshot);
    });
  }

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await acquireWorkflowRunStoreLock(this.lockPath);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

function shouldKeepWorkflowRunWhenClearingInactive(run: WorkflowRunRecord): boolean {
  return run.status === "running" || isActionableWorkflowRunProblem(run);
}

function latestRunningWorkflowRun(runs: WorkflowRunRecord[]): WorkflowRunRecord | undefined {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run?.status === "running") return run;
  }
  return undefined;
}

async function acquireWorkflowRunStoreLock(lockPath: string): Promise<() => Promise<void>> {
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
      await removeStaleWorkflowRunStoreLock(lockPath, staleMs);
      if (Date.now() - started >= timeoutMs)
        throw new Error(`timed out waiting for workflow run store lock: ${lockPath}`);
      await sleep(retryIntervalMs);
    }
  }
}

async function removeStaleWorkflowRunStoreLock(lockPath: string, staleMs: number): Promise<void> {
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

export function defaultWorkflowRunStore(cwd: string): WorkflowRunStore {
  return new WorkflowRunStore(join(cwd, ".spark", "workflow-runs.json"));
}

export function summarizeWorkflowRuns(
  snapshot: WorkflowRunStoreSnapshot,
  options: WorkflowRunStatusQueryOptions = {},
): WorkflowRunStatusSummary {
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
  const actionableRuns = sorted.filter(isActionableWorkflowRunProblem);
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
    acknowledged: snapshot.runs.filter(isAcknowledgedWorkflowRunProblem).length,
    actionable: actionableRuns.length,
    nextSteps: collectWorkflowRunNextSteps([actionableRun, lastRun, ...recentRuns]),
  };
}
