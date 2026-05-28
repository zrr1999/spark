import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RoleRegistry, RoleRunMode } from "pi-roles";
import type { ArtifactStore } from "spark-artifacts";
import {
  newRef,
  nowIso,
  type RoleRef,
  type RunRef,
  type Task,
  type TaskRef,
  type TaskRun,
  type TaskRunCompletionSummary,
  type ThreadRef,
} from "spark-core";
import type { TaskGraph } from "spark-tasks";
import { RoleRunTimeoutError, runSparkTask } from "spark-runtime";

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

export type SparkDagRunRetentionCandidateReason = "old-succeeded" | "old-acknowledged-problem";

export type SparkDagRunRetentionKeepReason =
  | "active-run"
  | "running"
  | "non-terminal"
  | "global-recent-window"
  | "thread-recent-window"
  | "within-retention-age"
  | "unacknowledged-problem"
  | "unsafe-status"
  | "invalid-timestamp";

export interface SparkDagRunRetentionEntry {
  ref: RunRef;
  threadRef?: ThreadRef;
  status: SparkDagRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  acknowledgedAt?: string;
  retentionDate: string;
  ageDays?: number;
  reason: SparkDagRunRetentionCandidateReason | SparkDagRunRetentionKeepReason;
}

export interface SparkDagRunPruneOptions {
  dryRun?: boolean;
  olderThanDays?: number;
  keepRecent?: number;
  keepRecentPerThread?: number;
  activeRunRefs?: Iterable<RunRef>;
  now?: string;
}

export interface SparkDagRunPruneResult {
  snapshot: SparkDagRunStoreSnapshot;
  dryRun: boolean;
  olderThanDays: number;
  keepRecent: number;
  keepRecentPerThread: number;
  cutoffIso: string;
  before: number;
  after: number;
  candidates: SparkDagRunRetentionEntry[];
  deleted: SparkDagRunRetentionEntry[];
  kept: SparkDagRunRetentionEntry[];
}

export interface SparkDagRunRecord {
  ref: RunRef;
  threadRef?: ThreadRef;
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
  threadRef?: ThreadRef;
  ownerSessionId?: string;
  dryRun: boolean;
  maxConcurrency: number;
  timeoutMs: number;
}

interface NormalizedSparkDagRunPruneOptions {
  dryRun: boolean;
  olderThanDays: number;
  keepRecent: number;
  keepRecentPerThread: number;
  activeRunRefs: Set<RunRef>;
  nowMs: number;
  cutoffMs: number;
  cutoffIso: string;
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
      for (const record of snapshot.runs) {
        if (record.status !== "running") continue;
        if (record.taskRunRefs.some((runRef) => activeRunRefs.has(runRef))) continue;
        reconcileStaleDagRun(record, input.graph, now);
      }
      if (
        snapshot.manager.activeRunRef &&
        !snapshot.runs.some(
          (run) => run.ref === snapshot.manager.activeRunRef && run.status === "running",
        )
      ) {
        snapshot.manager.activeRunRef = undefined;
      }
      snapshot.manager.status = snapshot.manager.activeRunRef ? "running" : "idle";
      snapshot.manager.updatedAt = now;
      reconciled = snapshot;
    });
    return reconciled ?? (await this.load());
  }

  async load(): Promise<SparkDagRunStoreSnapshot> {
    try {
      const raw = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<SparkDagRunStoreSnapshot>;
      return normalizeSparkDagRunSnapshot(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySparkDagRunSnapshot();
      throw error;
    }
  }

  async save(snapshot: SparkDagRunStoreSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = join(
      dirname(this.filePath),
      `.${Date.now()}-${Math.random().toString(16).slice(2)}-${this.filePath.split("/").at(-1)}.tmp`,
    );
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }

  async startRun(input: SparkDagRunStartInput): Promise<SparkDagRunRecord> {
    let created: SparkDagRunRecord | undefined;
    await this.updateSnapshot((snapshot) => {
      const now = nowIso();
      const record: SparkDagRunRecord = {
        ref: newRef("run"),
        threadRef: input.threadRef,
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
    if (!created) throw new Error("failed to start Spark DAG run");
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
    result: Pick<SparkReadyTaskRunnerResult, "scheduled" | "completed" | "timedOut"> &
      Partial<
        Pick<
          SparkReadyTaskRunnerResult,
          "failed" | "cancelled" | "foregroundTimedOut" | "detached" | "runs"
        >
      >,
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
              ? `Spark DAG child runs failed: failed=${failedChildren} cancelled=${cancelledChildren}`
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

function isTerminalDagRunStatus(status: SparkDagRunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "timed_out" || status === "stale"
  );
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

function normalizeSparkDagRunPruneOptions(
  options: SparkDagRunPruneOptions,
): NormalizedSparkDagRunPruneOptions {
  const olderThanDays = Number.isFinite(options.olderThanDays ?? 30)
    ? Math.max(0, Math.floor(options.olderThanDays ?? 30))
    : 30;
  const keepRecent = Number.isFinite(options.keepRecent ?? 10)
    ? Math.max(0, Math.floor(options.keepRecent ?? 10))
    : 10;
  const keepRecentPerThread = Number.isFinite(options.keepRecentPerThread ?? 10)
    ? Math.max(0, Math.floor(options.keepRecentPerThread ?? 10))
    : 10;
  const nowMs = Date.parse(options.now ?? nowIso());
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cutoffMs = safeNowMs - olderThanDays * 24 * 60 * 60 * 1_000;
  return {
    dryRun: options.dryRun ?? true,
    olderThanDays,
    keepRecent,
    keepRecentPerThread,
    activeRunRefs: new Set(options.activeRunRefs ?? []),
    nowMs: safeNowMs,
    cutoffMs,
    cutoffIso: new Date(cutoffMs).toISOString(),
  };
}

function planSparkDagRunPrune(
  snapshot: SparkDagRunStoreSnapshot,
  options: NormalizedSparkDagRunPruneOptions,
): SparkDagRunPruneResult {
  const activeRunRefs = new Set(options.activeRunRefs);
  if (snapshot.manager.activeRunRef) activeRunRefs.add(snapshot.manager.activeRunRef);
  const terminalRuns = snapshot.runs
    .filter((run) => isTerminalDagRunStatus(run.status))
    .sort(compareSparkDagRunRetentionDateDesc);
  const globallyRecent = new Set(terminalRuns.slice(0, options.keepRecent).map((run) => run.ref));
  const recentlyByThread = new Set<RunRef>();
  const byThread = new Map<string, SparkDagRunRecord[]>();
  for (const run of terminalRuns) {
    const threadKey = run.threadRef ?? "__unthreaded__";
    byThread.set(threadKey, [...(byThread.get(threadKey) ?? []), run]);
  }
  for (const runs of byThread.values())
    for (const run of runs.slice(0, options.keepRecentPerThread)) recentlyByThread.add(run.ref);

  const candidates: SparkDagRunRetentionEntry[] = [];
  const kept: SparkDagRunRetentionEntry[] = [];
  for (const run of snapshot.runs) {
    const decision = sparkDagRunRetentionDecision(run, options, {
      activeRunRefs,
      globallyRecent,
      recentlyByThread,
    });
    if (decision.reason === "old-succeeded" || decision.reason === "old-acknowledged-problem")
      candidates.push(decision);
    else kept.push(decision);
  }
  return {
    snapshot,
    dryRun: options.dryRun,
    olderThanDays: options.olderThanDays,
    keepRecent: options.keepRecent,
    keepRecentPerThread: options.keepRecentPerThread,
    cutoffIso: options.cutoffIso,
    before: snapshot.runs.length,
    after: options.dryRun ? snapshot.runs.length : snapshot.runs.length - candidates.length,
    candidates,
    deleted: [],
    kept,
  };
}

function sparkDagRunRetentionDecision(
  run: SparkDagRunRecord,
  options: NormalizedSparkDagRunPruneOptions,
  windows: {
    activeRunRefs: Set<RunRef>;
    globallyRecent: Set<RunRef>;
    recentlyByThread: Set<RunRef>;
  },
): SparkDagRunRetentionEntry {
  const retentionDate = sparkDagRunRetentionDate(run);
  const retentionMs = Date.parse(retentionDate);
  const ageDays = Number.isFinite(retentionMs)
    ? Math.max(0, (options.nowMs - retentionMs) / (24 * 60 * 60 * 1_000))
    : undefined;
  const entry = (reason: SparkDagRunRetentionEntry["reason"]): SparkDagRunRetentionEntry => ({
    ref: run.ref,
    threadRef: run.threadRef,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    acknowledgedAt: run.acknowledgedAt,
    retentionDate,
    ageDays,
    reason,
  });
  if (
    windows.activeRunRefs.has(run.ref) ||
    run.taskRunRefs.some((ref) => windows.activeRunRefs.has(ref))
  )
    return entry("active-run");
  if (run.status === "running") return entry("running");
  if (!isTerminalDagRunStatus(run.status)) return entry("non-terminal");
  if (windows.globallyRecent.has(run.ref)) return entry("global-recent-window");
  if (windows.recentlyByThread.has(run.ref)) return entry("thread-recent-window");
  if (!Number.isFinite(retentionMs)) return entry("invalid-timestamp");
  if (retentionMs >= options.cutoffMs) return entry("within-retention-age");
  if (run.status === "succeeded") return entry("old-succeeded");
  if (isAcknowledgeableDagRun(run)) {
    if (!run.acknowledgedAt) return entry("unacknowledged-problem");
    return entry("old-acknowledged-problem");
  }
  return entry("unsafe-status");
}

function sparkDagRunRetentionDate(run: SparkDagRunRecord): string {
  return run.finishedAt ?? run.updatedAt ?? run.startedAt;
}

function compareSparkDagRunRetentionDateDesc(a: SparkDagRunRecord, b: SparkDagRunRecord): number {
  const byDate = sparkDagRunRetentionDate(b).localeCompare(sparkDagRunRetentionDate(a));
  if (byDate !== 0) return byDate;
  return b.ref.localeCompare(a.ref);
}

function isAcknowledgeableDagRun(run: SparkDagRunRecord): run is SparkDagRunRecord & {
  status: Extract<SparkDagRunStatus, "failed" | "stale" | "timed_out">;
} {
  return run.status === "failed" || run.status === "stale" || run.status === "timed_out";
}

function isAcknowledgedDagRunProblem(run: SparkDagRunRecord): boolean {
  return isAcknowledgeableDagRun(run) && Boolean(run.acknowledgedAt);
}

function isActionableDagRunProblem(run: SparkDagRunRecord): boolean {
  return isAcknowledgeableDagRun(run) && !isAcknowledgedDagRunProblem(run);
}

function reconcileDagRunCounters(
  record: SparkDagRunRecord,
  fallbacks: { scheduledFallback?: number; completedFallback?: number } = {},
): void {
  record.scheduledTaskRefs = uniqueRefs(record.scheduledTaskRefs);
  record.completedTaskRefs = uniqueRefs(record.completedTaskRefs);
  record.taskRunRefs = uniqueRefs(record.taskRunRefs);
  const scheduledSet = new Set(record.scheduledTaskRefs);
  if (scheduledSet.size > 0) {
    record.completedTaskRefs = record.completedTaskRefs.filter((taskRef) =>
      scheduledSet.has(taskRef),
    );
    record.scheduled = scheduledSet.size;
    record.completed = record.completedTaskRefs.length;
    return;
  }
  record.scheduled = Math.max(0, record.scheduled, fallbacks.scheduledFallback ?? 0);
  record.completed = Math.min(
    record.scheduled,
    Math.max(0, record.completed, fallbacks.completedFallback ?? 0),
  );
}

function uniqueRefs<T extends string>(refs: T[]): T[] {
  return [...new Set(refs)];
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

export function defaultSparkDagRunStore(cwd: string): SparkDagRunStore {
  return new SparkDagRunStore(join(cwd, ".spark", "dag-runs.json"));
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

function emptySparkDagRunSnapshot(): SparkDagRunStoreSnapshot {
  const now = nowIso();
  return { version: 1, manager: { status: "idle", updatedAt: now }, runs: [] };
}

function normalizeSparkDagRunSnapshot(
  raw: Partial<SparkDagRunStoreSnapshot>,
): SparkDagRunStoreSnapshot {
  const fallback = emptySparkDagRunSnapshot();
  return {
    version: 1,
    manager: {
      status:
        raw.manager?.status === "running" || raw.manager?.status === "failed"
          ? raw.manager.status
          : "idle",
      activeRunRef: raw.manager?.activeRunRef,
      lastRunRef: raw.manager?.lastRunRef,
      updatedAt: raw.manager?.updatedAt ?? fallback.manager.updatedAt,
    },
    runs: (raw.runs ?? []).map(normalizeSparkDagRunRecord),
  };
}

function normalizeSparkDagRunRecord(raw: Partial<SparkDagRunRecord>): SparkDagRunRecord {
  const now = nowIso();
  const ref = raw.ref ?? newRef("run");
  const status =
    raw.status === "succeeded" ||
    raw.status === "failed" ||
    raw.status === "timed_out" ||
    raw.status === "stale"
      ? raw.status
      : "running";
  const scheduled = raw.scheduled ?? raw.scheduledTaskRefs?.length ?? 0;
  const completed = raw.completed ?? raw.completedTaskRefs?.length ?? 0;
  const record: SparkDagRunRecord = {
    ref,
    threadRef: raw.threadRef,
    ownerSessionId: raw.ownerSessionId,
    dryRun: raw.dryRun ?? false,
    maxConcurrency: raw.maxConcurrency ?? DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
    timeoutMs: raw.timeoutMs ?? DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
    status,
    startedAt: raw.startedAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    finishedAt: raw.finishedAt,
    scheduled,
    completed,
    timedOut: raw.timedOut ?? raw.status === "timed_out",
    scheduledTaskRefs: [...(raw.scheduledTaskRefs ?? [])],
    completedTaskRefs: [...(raw.completedTaskRefs ?? [])],
    taskRunRefs: [...(raw.taskRunRefs ?? [])],
    errorMessage: raw.errorMessage,
    acknowledgedAt: typeof raw.acknowledgedAt === "string" ? raw.acknowledgedAt : undefined,
    acknowledgedBySession:
      typeof raw.acknowledgedBySession === "string" ? raw.acknowledgedBySession : undefined,
    completionDigest: normalizeTaskRunCompletionSummaries(raw.completionDigest),
    completionFollowUp: raw.completionFollowUp
      ? {
          createdAt: raw.completionFollowUp.createdAt ?? raw.finishedAt ?? now,
          runRef: raw.completionFollowUp.runRef ?? ref,
          status: raw.completionFollowUp.status ?? status,
          scheduled: raw.completionFollowUp.scheduled ?? scheduled,
          completed: raw.completionFollowUp.completed ?? completed,
          summary: raw.completionFollowUp.summary ?? "Spark orchestrator run finished.",
          nextActions: [...(raw.completionFollowUp.nextActions ?? [])],
          completionDigest: normalizeTaskRunCompletionSummaries(
            raw.completionFollowUp.completionDigest ?? raw.completionDigest,
          ),
        }
      : undefined,
  };
  reconcileDagRunCounters(record);
  return record;
}

function reconcileStaleDagRun(
  record: SparkDagRunRecord,
  graph: TaskGraph | undefined,
  now: string,
): void {
  const taskRuns = graph
    ? record.taskRunRefs.flatMap((runRef) => graph.runs().filter((run) => run.ref === runRef))
    : [];
  const runningRuns = taskRuns.filter((run) => run.status === "queued" || run.status === "running");
  if (runningRuns.length > 0) return;
  for (const run of taskRuns.filter(
    (candidate) => candidate.status !== "queued" && candidate.status !== "running",
  )) {
    if (!record.completedTaskRefs.includes(run.taskRef)) record.completedTaskRefs.push(run.taskRef);
  }
  reconcileDagRunCounters(record, {
    completedFallback: taskRuns.filter((run) => run.status !== "queued" && run.status !== "running")
      .length,
  });
  if (taskRuns.some((run) => run.status === "failed")) record.status = "failed";
  else if (taskRuns.length > 0 && taskRuns.every((run) => run.status === "succeeded"))
    record.status = "succeeded";
  else if (taskRuns.some((run) => run.status === "cancelled")) record.status = "failed";
  else record.status = "stale";
  record.errorMessage ??= `Spark orchestrator run was reconciled as ${record.status} after no active child process was found.`;
  record.finishedAt ??= now;
  record.updatedAt = now;
  if (record.completionDigest.length === 0)
    record.completionDigest = completionDigestFromTaskRuns(taskRuns);
  record.completionFollowUp ??= createSparkDagCompletionFollowUp(record);
}

function createSparkDagCompletionFollowUp(run: SparkDagRunRecord): SparkDagCompletionFollowUp {
  const digest = run.completionDigest;
  const digestSuffix =
    digest.length > 0 ? ` Digest: ${formatSparkDagCompletionDigest(digest)}.` : "";
  return {
    createdAt: nowIso(),
    runRef: run.ref,
    status: run.status,
    scheduled: run.scheduled,
    completed: run.completed,
    summary: `Spark DAG ${run.ref} ${run.status}: scheduled ${run.scheduled}, completed ${run.completed}.${digestSuffix}`,
    nextActions: sparkDagRunNextActions(run),
    completionDigest: digest.map(cloneTaskRunCompletionSummary),
  };
}

function completionDigestFromTaskRuns(runs: TaskRun[]): TaskRunCompletionSummary[] {
  return runs
    .flatMap((run) => (run.completionSummary ? [run.completionSummary] : []))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10)
    .map(cloneTaskRunCompletionSummary);
}

function formatSparkDagCompletionDigest(summaries: TaskRunCompletionSummary[]): string {
  const visible = summaries.slice(0, 3).map((summary) => {
    const role = summary.roleRef ? ` role=${summary.roleRef.replace(/^role:/u, "")}` : "";
    const artifacts =
      summary.artifactRefs.length > 0 ? ` artifacts=${summary.artifactRefs.join(",")}` : "";
    return `task=${summary.taskRef} run=${summary.runRef} status=${summary.status}${role}: ${summary.summary}${artifacts}`;
  });
  const hidden = summaries.length - visible.length;
  if (hidden > 0) visible.push(`… ${hidden} more role-run completion(s)`);
  return visible.join("; ");
}

function normalizeTaskRunCompletionSummaries(
  summaries: TaskRunCompletionSummary[] | undefined,
): TaskRunCompletionSummary[] {
  return (summaries ?? []).map(cloneTaskRunCompletionSummary);
}

function cloneTaskRunCompletionSummary(
  summary: TaskRunCompletionSummary,
): TaskRunCompletionSummary {
  return { ...summary, artifactRefs: [...summary.artifactRefs] };
}

function collectSparkDagRunNextSteps(
  runs: Array<SparkDagRunRecord | undefined>,
): SparkDagRunNextSteps[] {
  const seen = new Set<RunRef>();
  const nextSteps: SparkDagRunNextSteps[] = [];
  for (const run of runs) {
    const steps = run ? sparkDagRunNextSteps(run) : undefined;
    if (!steps || seen.has(steps.runRef)) continue;
    seen.add(steps.runRef);
    nextSteps.push(steps);
  }
  return nextSteps;
}

export function sparkDagRunNextSteps(run: SparkDagRunRecord): SparkDagRunNextSteps | undefined {
  if (!isAcknowledgeableDagRun(run) || isAcknowledgedDagRunProblem(run)) return undefined;
  return {
    runRef: run.ref,
    status: run.status,
    summary: `Next steps for ${run.status} Spark DAG ${run.ref}`,
    nextActions: sparkDagRunNextActions(run),
  };
}

function sparkDagRunNextActions(run: SparkDagRunRecord): string[] {
  const nextActions: string[] = [];
  if (run.status === "failed") {
    nextActions.push(
      "failed: inspect spark_background_runs inspect plus child task-run artifacts/logs to find the failed or cancelled role-run.",
      "failed: fix the task, role, model, or dependency error, then rerun ready background work for the remaining ready frontier.",
    );
  } else if (run.status === "stale") {
    nextActions.push(
      "stale: run spark_background_runs reconcile and compare background records with task runs/claims; the manager lost track of child process completion.",
      "stale: preserve useful evidence, acknowledge known stale failures with spark_background_runs ack if no more action is needed, then retry ready tasks only after the task graph state is consistent.",
    );
  } else if (run.status === "timed_out") {
    nextActions.push(
      "timed_out: legacy foreground timeout record; inspect spark_background_runs status for active role-runs or reconcile before retrying.",
      "timed_out: if child work is still active, kill stuck children with spark_background_runs kill only when you explicitly want to stop it.",
    );
  }
  if (run.scheduled === 0)
    nextActions.push(
      "No tasks were scheduled; check pending tasks for dependency or plan-readiness blockers.",
    );
  if (run.completed < run.scheduled)
    nextActions.push(
      "Review incomplete scheduled task runs in spark_status view=full before launching another DAG wave.",
    );
  if (nextActions.length === 0)
    nextActions.push("Review task outputs and continue with newly unblocked ready tasks if any.");
  return nextActions;
}

export interface SparkReadyTaskRunnerOptions {
  graph: TaskGraph;
  registry: RoleRegistry;
  /** Role assigned when a ready task has no task-level role hint. Defaults by task kind, then worker. */
  defaultRoleRef?: RoleRef;
  artifactStore?: ArtifactStore;
  threadRef?: ThreadRef;
  cwd?: string;
  piCommand?: string;
  dryRun?: boolean;
  /** Maximum number of role runs running at the same time. Default: 4. */
  maxConcurrency?: number;
  /** Foreground wait budget for this scheduler call. Expiry detaches active children instead of terminating the DAG run. */
  timeoutMs?: number;
  /** Per-role-run timeout. Defaults to no per-task timeout; use only when deliberately bounding each child. */
  taskTimeoutMs?: number;
  sessionDir?: string;
  mode?: RoleRunMode;
  forkFromSession?: string;
  heartbeatIntervalMs?: number;
  onHeartbeat?: (graph: TaskGraph) => void | Promise<void>;
  onSchedule?: (result: SparkReadyTaskRunnerSchedule) => void | Promise<void>;
  onProgress?: (result: SparkReadyTaskRunnerProgress) => void | Promise<void>;
  claim?: {
    sessionId?: string;
    leaseMs?: number;
  };
}

export interface SparkReadyTaskRunnerSchedule {
  taskRef: TaskRef;
  runRef?: RunRef;
  running: number;
  scheduled: number;
}

export interface SparkReadyTaskRunnerProgress {
  taskRef: TaskRef;
  run: TaskRun;
  running: number;
  completed: number;
}

export interface SparkReadyTaskRunnerResult {
  runs: TaskRun[];
  scheduled: number;
  completed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** Legacy DAG timeout flag. New foreground wait expiry is reported via foregroundTimedOut/detached. */
  timedOut: boolean;
  foregroundTimedOut: boolean;
  detached: boolean;
  detachedRunRefs: RunRef[];
  maxConcurrency: number;
}

export const DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY = 4;
export const DEFAULT_SPARK_READY_TASK_TIMEOUT_MS = 3_600_000;

export async function runReadySparkTasks(
  input: SparkReadyTaskRunnerOptions,
): Promise<SparkReadyTaskRunnerResult> {
  const dryRun = input.dryRun ?? true;
  const maxConcurrency = normalizeMaxConcurrency(input.maxConcurrency);
  const timeoutMs = normalizeReadyTaskRunnerTimeoutMs(input.timeoutMs);
  const taskTimeoutMs = normalizeTaskTimeoutMs(input.taskTimeoutMs);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const runs: TaskRun[] = [];
  const running = new Set<Promise<TaskRun>>();
  const scheduled = new Set<TaskRef>();
  const promiseRunRefs = new Map<Promise<TaskRun>, RunRef>();
  let foregroundTimedOut = false;

  const schedule = (task: Task): void => {
    const assignedRoleRef = assignedRoleRefForTask(task, input.defaultRoleRef);
    scheduled.add(task.ref);
    const preexistingRunRefs = new Set(input.graph.runs(task.threadRef).map((run) => run.ref));
    const runPromise = runSparkTask({
      graph: input.graph,
      taskRef: task.ref,
      registry: input.registry,
      assignedRoleRef,
      artifactStore: input.artifactStore,
      cwd: input.cwd,
      piCommand: input.piCommand,
      dryRun,
      timeoutMs: taskTimeoutMs ?? 0,
      sessionDir: input.sessionDir,
      mode: input.mode,
      forkFromSession: input.forkFromSession,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      onHeartbeat: input.onHeartbeat,
      claim: dryRun
        ? undefined
        : {
            sessionId: input.claim?.sessionId,
            leaseMs: input.claim?.leaseMs ?? timeoutMs,
          },
    })
      .catch((error: unknown) => taskRunFromError(input.graph.getTask(task.ref), error))
      .then(async (run) => {
        runs.push(run);
        await input.onProgress?.({
          taskRef: task.ref,
          run,
          running: Math.max(0, running.size - 1),
          completed: runs.length,
        });
        return run;
      })
      .finally(() => {
        running.delete(runPromise);
      });
    running.add(runPromise);
    const claimedRunRef = input.graph.getTask(task.ref).claim?.runRef;
    const recordedRunRef = input.graph
      .runs(task.threadRef)
      .find((run) => !preexistingRunRefs.has(run.ref) && run.taskRef === task.ref)?.ref;
    const runRef = claimedRunRef ?? recordedRunRef;
    if (runRef) promiseRunRefs.set(runPromise, runRef);
    void input.onSchedule?.({
      taskRef: task.ref,
      runRef,
      running: running.size,
      scheduled: scheduled.size,
    });
  };

  while (true) {
    if (Date.now() >= deadline) {
      foregroundTimedOut = true;
      break;
    }

    const ready = input.graph
      .readyTasks(input.threadRef)
      .filter((task) => !scheduled.has(task.ref))
      .slice(0, Math.max(0, maxConcurrency - running.size));
    for (const task of ready) schedule(task);

    if (running.size === 0) {
      const hasMoreReady = input.graph
        .readyTasks(input.threadRef)
        .some((task) => !scheduled.has(task.ref));
      if (!hasMoreReady) break;
      continue;
    }

    await Promise.race([
      Promise.race(running),
      sleep(Math.max(0, deadline - Date.now())).then(() => {
        foregroundTimedOut = true;
      }),
    ]);
    if (foregroundTimedOut) break;
  }

  const detachedRunRefs =
    foregroundTimedOut && running.size > 0
      ? detachForegroundTimedOutTasks(input.graph, [...running], promiseRunRefs, timeoutMs, runs)
      : [];
  if (!foregroundTimedOut) {
    await Promise.allSettled(running);
  }

  return {
    runs,
    scheduled: scheduled.size,
    completed: runs.filter((run) => run.status !== "running" && run.status !== "queued").length,
    succeeded: runs.filter((run) => run.status === "succeeded").length,
    failed: runs.filter((run) => run.status === "failed").length,
    cancelled: runs.filter((run) => run.status === "cancelled").length,
    timedOut: false,
    foregroundTimedOut,
    detached: detachedRunRefs.length > 0,
    detachedRunRefs,
    maxConcurrency,
  };
}

function detachForegroundTimedOutTasks(
  graph: TaskGraph,
  running: Array<Promise<TaskRun>>,
  promiseRunRefs: Map<Promise<TaskRun>, RunRef>,
  timeoutMs: number,
  runs: TaskRun[],
): RunRef[] {
  const timedOutRunRefs = new Set(
    running
      .map((runPromise) => promiseRunRefs.get(runPromise))
      .filter((runRef): runRef is RunRef => Boolean(runRef)),
  );
  for (const task of graph.tasks()) {
    const runRef = task.claim?.runRef;
    if (!runRef || !timedOutRunRefs.has(runRef)) continue;

    const run = graph.runs(task.threadRef).find((candidate) => candidate.ref === runRef);
    if (run?.status !== "running" && run?.status !== "queued") continue;
    const background: TaskRun = {
      ...run,
      status: "running",
      failureKind: undefined,
      errorMessage: `Spark foreground wait expired after ${timeoutMs}ms; keeping role-run claim in background`,
    };
    graph.recordRun(background);
    graph.setTaskStatus(task.ref, "running");
    runs.push(background);
  }
  return [...timedOutRunRefs];
}

function normalizeMaxConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value ?? DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY))
    return DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY;
  return Math.max(1, Math.floor(value ?? DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY));
}

function normalizeReadyTaskRunnerTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value ?? DEFAULT_SPARK_READY_TASK_TIMEOUT_MS))
    return DEFAULT_SPARK_READY_TASK_TIMEOUT_MS;
  return Math.max(1, Math.floor(value ?? DEFAULT_SPARK_READY_TASK_TIMEOUT_MS));
}

function normalizeTaskTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function assignedRoleRefForTask(task: Task, defaultRoleRef?: RoleRef): RoleRef {
  return (
    normalizeRoleRefCompat(task.roleRef) ?? defaultRoleRef ?? defaultRoleRefForTaskKind(task.kind)
  );
}

function defaultRoleRefForTaskKind(kind: Task["kind"]): RoleRef {
  if (kind === "research") return "role:builtin-scout" as RoleRef;
  if (kind === "plan") return "role:builtin-planner" as RoleRef;
  if (kind === "review") return "role:builtin-reviewer" as RoleRef;
  return "role:builtin-worker" as RoleRef;
}

function taskRunFromError(task: Task, error: unknown): TaskRun {
  const latest = task.claim?.runRef ? task.claim.runRef : task.ref.replace(/^task:/, "run:error-");
  const errorMessage = error instanceof Error ? error.message : String(error);
  const finishedAt = nowIso();
  const run: TaskRun = {
    ref: latest as RunRef,
    threadRef: task.threadRef,
    taskRef: task.ref,
    roleRef: task.claim?.roleRef ?? task.roleRef,
    runName: task.claim?.runName,
    ownerSessionId: task.claim?.sessionId,
    status: "failed",
    failureKind: error instanceof RoleRunTimeoutError ? "runtime_timeout" : "runtime_error",
    errorMessage,
    startedAt: finishedAt,
    finishedAt,
    outputArtifacts: [],
  };
  return {
    ...run,
    completionSummary: {
      runRef: run.ref,
      taskRef: run.taskRef,
      roleRef: run.roleRef,
      runName: run.runName,
      status: run.status,
      summary: errorMessage,
      artifactRefs: [],
      createdAt: finishedAt,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function normalizeRoleRefCompat(
  value: RoleRef | `agent:${string}` | undefined,
): RoleRef | undefined {
  if (!value) return undefined;
  return (value.startsWith("agent:") ? `role:${value.slice("agent:".length)}` : value) as RoleRef;
}
