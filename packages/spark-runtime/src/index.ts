import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  buildRoleRunArgs as buildGenericRoleRunArgs,
  parsePiJsonlEvents,
  RoleRunCancelledError,
  RoleRunTimeoutError as PiRoleRunTimeoutError,
  runRole,
  type RoleRegistry,
  type RoleRunMode,
} from "pi-roles";
import type { ArtifactStore } from "spark-artifacts";
import {
  DependencyError,
  type ArtifactRef,
  type JsonValue,
  newRef,
  nowIso,
  refId,
  type RoleRef,
  type RunRef,
  type Task,
  type TaskRef,
  type TaskRun,
  type ThreadRef,
} from "spark-core";
import type { RoleInstruction, RoleRunRecord, RoleRunStatus } from "pi-roles";
import type { TaskGraph, TaskGraphStore } from "spark-tasks";

export type SparkDagManagerStatus = "idle" | "running" | "failed";
export type SparkDagRunStatus = "running" | "succeeded" | "failed" | "timed_out" | "stale";
const EMPTY_ROLE_RUN_FAILURE_KIND = "runtime_error";

export interface SparkDagManagerState {
  status: SparkDagManagerStatus;
  activeRunRef?: RunRef;
  lastRunRef?: RunRef;
  updatedAt: string;
}

export interface SparkDagCompletionFollowUp {
  createdAt: string;
  summary: string;
  nextActions: string[];
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
  lastRun?: SparkDagRunRecord;
  recentRuns: SparkDagRunRecord[];
  running: number;
  succeeded: number;
  failed: number;
  timedOut: number;
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

export interface SparkRoleRunResult {
  record: RoleRunRecord;
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export { type RoleRunMode } from "pi-roles";

export interface ActiveSparkRoleRunProcess {
  runRef: RunRef;
  roleRef: RoleRef;
  runName?: string;
  pid?: number;
  cwd: string;
  startedAt: string;
  timedOutAt?: string;
}

export interface KillSparkRoleRunProcessOptions {
  runRef?: RunRef;
  runRefs?: RunRef[];
  runName?: string;
  runNames?: string[];
  reason?: string;
  signal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  forceAfterMs?: number;
  waitMs?: number;
}

export interface KillSparkRoleRunProcessResult extends ActiveSparkRoleRunProcess {
  signal: NodeJS.Signals;
  forceSignal: NodeJS.Signals;
  signalSent: boolean;
  forceScheduled: boolean;
  closed: boolean;
  errorMessage?: string;
}

interface TrackedSparkRoleRunProcess extends ActiveSparkRoleRunProcess {
  child: ChildProcess;
  closed: boolean;
  forceKillTimer?: ReturnType<typeof setTimeout>;
  terminationReason?: string;
}

export class SparkDagRunStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async status(options: SparkDagStatusQueryOptions = {}): Promise<SparkDagStatusSummary> {
    return summarizeSparkDagRuns(await this.load(), options);
  }

  async clearInactiveRuns(): Promise<SparkDagRunStoreSnapshot> {
    let cleared: SparkDagRunStoreSnapshot | undefined;
    await this.updateSnapshot((snapshot) => {
      snapshot.runs = snapshot.runs.filter((run) => run.status === "running");
      snapshot.manager.lastRunRef = snapshot.runs.at(-1)?.ref;
      if (
        snapshot.manager.activeRunRef &&
        !snapshot.runs.some((run) => run.ref === snapshot.manager.activeRunRef)
      ) {
        snapshot.manager.activeRunRef = undefined;
      }
      snapshot.manager.status = snapshot.manager.activeRunRef ? "running" : "idle";
      snapshot.manager.updatedAt = nowIso();
      cleared = snapshot;
    });
    return cleared ?? (await this.load());
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
    const snapshot = await this.load();
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
    };
    snapshot.manager = {
      status: "running",
      activeRunRef: record.ref,
      lastRunRef: record.ref,
      updatedAt: now,
    };
    snapshot.runs = [...snapshot.runs, record];
    await this.save(snapshot);
    return record;
  }

  async recordSchedule(runRef: RunRef, input: SparkDagRunScheduleInput): Promise<void> {
    await this.updateRun(runRef, (record) => {
      record.scheduled = input.scheduled;
      if (!record.scheduledTaskRefs.includes(input.taskRef))
        record.scheduledTaskRefs.push(input.taskRef);
      if (input.runRef && !record.taskRunRefs.includes(input.runRef))
        record.taskRunRefs.push(input.runRef);
    });
  }

  async recordProgress(runRef: RunRef, input: SparkDagRunProgressInput): Promise<void> {
    await this.updateRun(runRef, (record) => {
      record.completed = input.completed;
      if (!record.completedTaskRefs.includes(input.taskRef))
        record.completedTaskRefs.push(input.taskRef);
      if (!record.taskRunRefs.includes(input.run.ref)) record.taskRunRefs.push(input.run.ref);
    });
  }

  async finishRun(
    runRef: RunRef,
    result: Pick<SparkReadyTaskRunnerResult, "scheduled" | "completed" | "timedOut">,
    error?: unknown,
  ): Promise<SparkDagCompletionFollowUp | undefined> {
    let followUp: SparkDagCompletionFollowUp | undefined;
    await this.updateSnapshot((snapshot) => {
      const now = nowIso();
      const record = snapshot.runs.find((candidate) => candidate.ref === runRef);
      if (!record) return;
      record.scheduled = result.scheduled;
      record.completed = result.completed;
      record.timedOut = result.timedOut;
      record.status = error ? "failed" : result.timedOut ? "timed_out" : "succeeded";
      record.errorMessage =
        error instanceof Error ? error.message : error ? JSON.stringify(error) : undefined;
      record.finishedAt = now;
      record.updatedAt = now;
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
    update: (record: SparkDagRunRecord) => void,
  ): Promise<void> {
    await this.updateSnapshot((snapshot) => {
      const record = snapshot.runs.find((candidate) => candidate.ref === runRef);
      if (!record) return;
      update(record);
      record.updatedAt = nowIso();
    });
  }

  private async updateSnapshot(
    update: (snapshot: SparkDagRunStoreSnapshot) => void,
  ): Promise<void> {
    const snapshot = await this.load();
    update(snapshot);
    await this.save(snapshot);
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
  return {
    manager: snapshot.manager,
    activeRun: snapshot.manager.activeRunRef
      ? snapshot.runs.find((run) => run.ref === snapshot.manager.activeRunRef)
      : undefined,
    lastRun: snapshot.manager.lastRunRef
      ? snapshot.runs.find((run) => run.ref === snapshot.manager.lastRunRef)
      : sorted[0],
    recentRuns: sorted.slice(0, limit),
    running: snapshot.runs.filter((run) => run.status === "running").length,
    succeeded: snapshot.runs.filter((run) => run.status === "succeeded").length,
    failed: snapshot.runs.filter((run) => run.status === "failed" || run.status === "stale").length,
    timedOut: snapshot.runs.filter((run) => run.status === "timed_out").length,
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
  return {
    ref: raw.ref ?? newRef("run"),
    threadRef: raw.threadRef,
    ownerSessionId: raw.ownerSessionId,
    dryRun: raw.dryRun ?? false,
    maxConcurrency: raw.maxConcurrency ?? DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
    timeoutMs: raw.timeoutMs ?? DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
    status:
      raw.status === "succeeded" ||
      raw.status === "failed" ||
      raw.status === "timed_out" ||
      raw.status === "stale"
        ? raw.status
        : "running",
    startedAt: raw.startedAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    finishedAt: raw.finishedAt,
    scheduled: raw.scheduled ?? raw.scheduledTaskRefs?.length ?? 0,
    completed: raw.completed ?? raw.completedTaskRefs?.length ?? 0,
    timedOut: raw.timedOut ?? raw.status === "timed_out",
    scheduledTaskRefs: [...(raw.scheduledTaskRefs ?? [])],
    completedTaskRefs: [...(raw.completedTaskRefs ?? [])],
    taskRunRefs: [...(raw.taskRunRefs ?? [])],
    errorMessage: raw.errorMessage,
    completionFollowUp: raw.completionFollowUp
      ? {
          createdAt: raw.completionFollowUp.createdAt ?? raw.finishedAt ?? now,
          summary: raw.completionFollowUp.summary ?? "Spark DAG manager run finished.",
          nextActions: [...(raw.completionFollowUp.nextActions ?? [])],
        }
      : undefined,
  };
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
  record.completed = Math.max(
    record.completed,
    taskRuns.filter((run) => run.status !== "queued" && run.status !== "running").length,
  );
  if (taskRuns.some((run) => run.status === "failed")) record.status = "failed";
  else if (taskRuns.length > 0 && taskRuns.every((run) => run.status === "succeeded"))
    record.status = "succeeded";
  else if (taskRuns.some((run) => run.status === "cancelled")) record.status = "failed";
  else record.status = "stale";
  record.errorMessage ??= `Spark DAG manager run was reconciled as ${record.status} after no active child process was found.`;
  record.finishedAt ??= now;
  record.updatedAt = now;
  record.completionFollowUp ??= createSparkDagCompletionFollowUp(record);
}

function createSparkDagCompletionFollowUp(run: SparkDagRunRecord): SparkDagCompletionFollowUp {
  const nextActions: string[] = [];
  if (run.status === "timed_out")
    nextActions.push("Inspect or kill background role runs that remain claimed as running.");
  if (run.status === "failed" || run.status === "stale")
    nextActions.push("Inspect the DAG manager error and retry ready tasks.");
  if (run.scheduled === 0)
    nextActions.push("Check for pending tasks blocked by dependencies or missing role specs.");
  if (run.completed < run.scheduled)
    nextActions.push("Review incomplete scheduled task runs before launching another DAG wave.");
  if (nextActions.length === 0)
    nextActions.push("Review task outputs and continue with newly unblocked ready tasks if any.");
  return {
    createdAt: nowIso(),
    summary: `Spark DAG ${run.ref} ${run.status}: scheduled ${run.scheduled}, completed ${run.completed}.`,
    nextActions,
  };
}

const DEFAULT_ROLE_RUN_FORCE_KILL_AFTER_MS = 1_000;
const DEFAULT_ROLE_RUN_SHUTDOWN_WAIT_MS = 3_000;
const activeSparkRoleRunProcesses = new Map<RunRef, TrackedSparkRoleRunProcess>();

export function listActiveSparkRoleRunProcesses(): ActiveSparkRoleRunProcess[] {
  return [...activeSparkRoleRunProcesses.values()].map(snapshotSparkRoleRunProcess);
}

export async function killActiveSparkRoleRunProcesses(
  options: KillSparkRoleRunProcessOptions = {},
): Promise<KillSparkRoleRunProcessResult[]> {
  const hasRunFilter = options.runRef !== undefined || options.runRefs !== undefined;
  const hasNameFilter = options.runName !== undefined || options.runNames !== undefined;
  const runRefs = new Set([
    ...(options.runRefs ?? []),
    ...(options.runRef ? [options.runRef] : []),
  ]);
  const runNames = new Set([
    ...(options.runNames ?? []),
    ...(options.runName ? [options.runName] : []),
  ]);
  const targets = [...activeSparkRoleRunProcesses.values()].filter((record) => {
    if (hasRunFilter && !runRefs.has(record.runRef)) return false;
    if (hasNameFilter && !runNames.has(record.runName ?? "")) return false;
    return true;
  });
  return Promise.all(targets.map((record) => killTrackedSparkRoleRunProcess(record, options)));
}

function trackSparkRoleRunProcess(input: {
  child: ChildProcess;
  runRef: RunRef;
  roleRef: RoleRef;
  runName?: string;
  cwd: string;
  startedAt: string;
}): TrackedSparkRoleRunProcess {
  const tracked: TrackedSparkRoleRunProcess = {
    runRef: input.runRef,
    roleRef: input.roleRef,
    runName: input.runName,
    pid: input.child.pid,
    cwd: input.cwd,
    startedAt: input.startedAt,
    child: input.child,
    closed: input.child.exitCode !== null || input.child.signalCode !== null,
  };
  if (tracked.closed) return tracked;
  activeSparkRoleRunProcesses.set(input.runRef, tracked);
  input.child.once("close", () => {
    tracked.closed = true;
    if (tracked.forceKillTimer) clearTimeout(tracked.forceKillTimer);
    activeSparkRoleRunProcesses.delete(input.runRef);
  });
  input.child.once("error", () => {
    tracked.closed = true;
    if (tracked.forceKillTimer) clearTimeout(tracked.forceKillTimer);
    activeSparkRoleRunProcesses.delete(input.runRef);
  });
  return tracked;
}

function untrackSparkRoleRunProcess(runRef: RunRef): void {
  const tracked = activeSparkRoleRunProcesses.get(runRef);
  if (tracked?.forceKillTimer) clearTimeout(tracked.forceKillTimer);
  activeSparkRoleRunProcesses.delete(runRef);
}

function snapshotSparkRoleRunProcess(
  record: TrackedSparkRoleRunProcess,
): ActiveSparkRoleRunProcess {
  return {
    runRef: record.runRef,
    roleRef: record.roleRef,
    runName: record.runName,
    pid: record.pid,
    cwd: record.cwd,
    startedAt: record.startedAt,
    timedOutAt: record.timedOutAt,
  };
}

async function killTrackedSparkRoleRunProcess(
  record: TrackedSparkRoleRunProcess,
  options: KillSparkRoleRunProcessOptions,
): Promise<KillSparkRoleRunProcessResult> {
  const signal = options.signal ?? "SIGTERM";
  const forceSignal = options.forceSignal ?? "SIGKILL";
  const forceAfterMs = options.forceAfterMs ?? DEFAULT_ROLE_RUN_FORCE_KILL_AFTER_MS;
  const waitMs = options.waitMs ?? DEFAULT_ROLE_RUN_SHUTDOWN_WAIT_MS;
  record.terminationReason = options.reason;
  let signalSent = false;
  let errorMessage: string | undefined;

  if (!record.closed) {
    try {
      signalSent = record.child.kill(signal);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  let forceScheduled = false;
  if (!record.closed && forceAfterMs >= 0) {
    forceScheduled = true;
    record.forceKillTimer = setTimeout(() => {
      if (!record.closed) record.child.kill(forceSignal);
    }, forceAfterMs);
    record.forceKillTimer.unref?.();
  }

  const closed = await waitForTrackedSparkRoleRunClose(record, waitMs);
  return {
    ...snapshotSparkRoleRunProcess(record),
    signal,
    forceSignal,
    signalSent,
    forceScheduled,
    closed,
    errorMessage,
  };
}

async function waitForTrackedSparkRoleRunClose(
  record: TrackedSparkRoleRunProcess,
  waitMs: number,
): Promise<boolean> {
  if (record.closed) return true;
  return new Promise<boolean>((resolve) => {
    const done = () => {
      cleanup();
      resolve(true);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(record.closed);
    }, waitMs);
    const cleanup = () => {
      clearTimeout(timeout);
      record.child.off("close", done);
      record.child.off("error", done);
    };
    timeout.unref?.();
    record.child.once("close", done);
    record.child.once("error", done);
  });
}

export function createRoleRunName(roleRef: RoleRef, runRef: RunRef, roleId?: string): string {
  const base = sanitizeRoleRunName(
    roleId?.trim() || refId(roleRef).replace(/^(builtin-|project-|user-)/, ""),
  );
  const suffix = sanitizeRoleRunName(refId(runRef)).slice(0, 8) || "run";
  return `${base}-${suffix}`;
}

function sanitizeRoleRunName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-") || "role"
  );
}

export function createRoleRunClaimId(sessionId: string | undefined, runName: string): string {
  const sessionPart = sanitizeClaimPart(sessionId?.trim() || "session:unknown");
  const runPart = sanitizeClaimPart(runName.trim() || "role");
  return `${sessionPart}+${runPart}`;
}

function sanitizeClaimPart(value: string): string {
  return value.replace(/\+/g, "-").replace(/\s+/g, "-") || "unknown";
}

export interface PiRoleCommandInput {
  roleRef?: RoleRef;
  /** @deprecated use roleRef. */
  specRef?: RoleRef;
  systemPrompt: string;
  instruction: string;
  sessionDir?: string;
  mode?: RoleRunMode;
  forkFromSession?: string;
}

export function buildRoleRunArgs(input: PiRoleCommandInput): string[] {
  return buildGenericRoleRunArgs({
    roleRef: (input.roleRef ?? input.specRef) as `role:${string}`,
    mode: input.mode,
    systemPrompt: input.systemPrompt,
    instruction: input.instruction,
    runGuidance: sparkRoleRunGuidance(),
    sessionDir: input.sessionDir,
    forkFromSession: input.forkFromSession,
  });
}

export interface RoleRunnerOptions {
  cwd: string;
  piCommand?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  sessionDir?: string;
  runName?: string;
  mode?: RoleRunMode;
  forkFromSession?: string;
}

export interface SparkReadyTaskRunnerOptions {
  graph: TaskGraph;
  registry: RoleRegistry;
  artifactStore?: ArtifactStore;
  threadRef?: ThreadRef;
  cwd?: string;
  piCommand?: string;
  dryRun?: boolean;
  /** Maximum number of role runs running at the same time. Default: 4. */
  maxConcurrency?: number;
  /** Overall scheduler timeout for the DAG run. Individual role runs do not get this timeout. */
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
  timedOut: boolean;
  maxConcurrency: number;
}

export const DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY = 4;
export const DEFAULT_SPARK_READY_TASK_TIMEOUT_MS = 3_600_000;

export interface SparkTaskRunOptions {
  graph: TaskGraph;
  taskRef: TaskRef;
  registry: RoleRegistry;
  artifactStore?: ArtifactStore;
  cwd?: string;
  piCommand?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  sessionDir?: string;
  mode?: RoleRunMode;
  forkFromSession?: string;
  heartbeatIntervalMs?: number;
  onHeartbeat?: (graph: TaskGraph) => void | Promise<void>;
  claim?: {
    kind?: "main" | "role-run";
    /** Concrete claimant identity. Defaults to `${sessionId}+${runName}` for role runs. */
    claimedBy?: string;
    /** Human-readable name for this concrete role run; roleRef remains the spec/type. */
    runName?: string;
    sessionId?: string;
    leaseMs?: number;
  };
}

export interface ExpiredTaskClaimSweepResult {
  graph: TaskGraph | null;
  expired: Task[];
  saved: boolean;
}

export function findResumableBackgroundRoleRunTasks(
  graph: TaskGraph,
  ownerSessionId: string,
): Task[] {
  return graph
    .tasks()
    .filter(
      (task) =>
        task.claim?.kind === "role-run" &&
        task.claim.sessionId === ownerSessionId &&
        Boolean(task.roleRef) &&
        (task.status === "running" || task.status === "pending" || task.status === "ready"),
    );
}

export async function sweepExpiredTaskClaims(
  store: Pick<TaskGraphStore, "update">,
  now = nowIso(),
): Promise<ExpiredTaskClaimSweepResult> {
  const result = await store.update((graph) => graph.expireTaskClaims(now), {
    createIfMissing: false,
  });
  if (!result.graph) return { graph: null, expired: [], saved: false };
  const expired = result.result ?? [];
  return { graph: result.graph, expired, saved: expired.length > 0 };
}

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
  let timedOut = false;

  const schedule = (task: Task): void => {
    scheduled.add(task.ref);
    const preexistingRunRefs = new Set(input.graph.runs(task.threadRef).map((run) => run.ref));
    const runPromise = runSparkTask({
      graph: input.graph,
      taskRef: task.ref,
      registry: input.registry,
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
      timedOut = true;
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
        timedOut = true;
      }),
    ]);
    if (timedOut) break;
  }

  if (timedOut && running.size > 0) {
    detachTimedOutTasks(input.graph, [...running], promiseRunRefs, timeoutMs, runs);
  } else {
    await Promise.allSettled(running);
  }

  return {
    runs,
    scheduled: scheduled.size,
    completed: runs.filter((run) => run.status !== "running" && run.status !== "queued").length,
    timedOut,
    maxConcurrency,
  };
}

function detachTimedOutTasks(
  graph: TaskGraph,
  running: Array<Promise<TaskRun>>,
  promiseRunRefs: Map<Promise<TaskRun>, RunRef>,
  timeoutMs: number,
  runs: TaskRun[],
): void {
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
      failureKind: "runtime_timeout",
      errorMessage: `Spark ready-task DAG timed out after ${timeoutMs}ms; keeping role-run claim in background`,
    };
    graph.recordRun(background);
    graph.setTaskStatus(task.ref, "running");
    runs.push(background);
  }
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

function taskRunFromError(task: Task, error: unknown): TaskRun {
  const latest = task.claim?.runRef ? task.claim.runRef : task.ref.replace(/^task:/, "run:error-");
  return {
    ref: latest as RunRef,
    threadRef: task.threadRef,
    taskRef: task.ref,
    roleRef: task.roleRef,
    runName: task.claim?.runName,
    ownerSessionId: task.claim?.sessionId,
    status: "failed",
    failureKind: error instanceof RoleRunTimeoutError ? "runtime_timeout" : "runtime_error",
    errorMessage: error instanceof Error ? error.message : String(error),
    startedAt: nowIso(),
    finishedAt: nowIso(),
    outputArtifacts: [],
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

export async function runSparkTask(input: SparkTaskRunOptions): Promise<TaskRun> {
  const task = input.graph.getTask(input.taskRef);
  const taskRoleRef = normalizeRoleRefCompat(task.roleRef);
  if (!taskRoleRef) throw new DependencyError(`task has no role binding: ${task.ref}`);
  const unmet = input.graph
    .dependencies(task.threadRef)
    .filter(
      (dep) => dep.taskRef === task.ref && input.graph.getTask(dep.dependsOn).status !== "done",
    );
  if (unmet.length > 0) throw new DependencyError(`task has unmet dependencies: ${task.ref}`);

  const runRef = newRef("run");
  const dryRun = input.dryRun ?? true;
  const originalStatus = task.status;
  const roleSpec = input.registry.get(taskRoleRef);
  const runName =
    input.claim?.runName?.trim() || createRoleRunName(taskRoleRef, runRef, roleSpec.id);
  const claimKind = input.claim?.kind ?? "role-run";
  const claimedBy =
    input.claim?.claimedBy?.trim() ||
    (claimKind === "role-run" ? createRoleRunClaimId(input.claim?.sessionId, runName) : runName);
  const ownerSessionId = input.claim?.sessionId;
  const leaseMs = input.claim?.leaseMs ?? input.timeoutMs ?? 600_000;
  if (!dryRun) {
    input.graph.claimTask(task.ref, {
      kind: claimKind,
      claimedBy,
      roleRef: taskRoleRef,
      runName,
      sessionId: input.claim?.sessionId,
      runRef,
      leaseMs,
    });
  }

  const run: TaskRun = {
    ref: runRef,
    threadRef: task.threadRef,
    taskRef: task.ref,
    roleRef: taskRoleRef,
    runName,
    ownerSessionId,
    status: "running",
    startedAt: nowIso(),
    outputArtifacts: [],
  };
  input.graph.recordRun(run);
  const stopHeartbeat = dryRun
    ? undefined
    : startTaskClaimHeartbeat({
        graph: input.graph,
        taskRef: task.ref,
        claimedBy,
        leaseMs,
        intervalMs: input.heartbeatIntervalMs,
        onHeartbeat: input.onHeartbeat,
      });

  try {
    const result = await runRoleInstructionOnly(
      input.registry,
      {
        roleRef: taskRoleRef,
        instruction: task.description,
        inputs: task.inputArtifacts,
      },
      {
        cwd: input.cwd ?? process.cwd(),
        piCommand: input.piCommand,
        dryRun,
        timeoutMs: input.timeoutMs,
        sessionDir: input.sessionDir,
        runName,
        mode: input.mode,
        forkFromSession: input.forkFromSession,
      },
      runRef,
    );

    let outputArtifactRef: ArtifactRef | undefined;
    if (input.artifactStore) {
      const artifact = await input.artifactStore.put({
        kind: "role-run",
        title: `Role run ${runName} for ${task.title}`,
        format: "json",
        body: {
          record: result.record,
          stdout: result.stdout,
          stderr: result.stderr,
          jsonEvents: result.jsonEvents,
        } as unknown as JsonValue,
        provenance: {
          producer: "task",
          threadRef: task.threadRef,
          taskRef: task.ref,
          roleRef: taskRoleRef,
          note: `runName=${runName}`,
        },
      });
      outputArtifactRef = artifact.ref;
      input.graph.attachOutputArtifact(task.ref, artifact.ref);
    }

    const completionFailure = roleRunCompletionFailure(result, dryRun);
    const succeeded = !completionFailure;
    const finished: TaskRun = {
      ...run,
      status: succeeded ? "succeeded" : "failed",
      failureKind: completionFailure ? EMPTY_ROLE_RUN_FAILURE_KIND : undefined,
      errorMessage: completionFailure,
      finishedAt: nowIso(),
      outputArtifacts: outputArtifactRef ? [outputArtifactRef] : [],
    };
    input.graph.recordRun(finished);
    if (dryRun) input.graph.setTaskStatus(task.ref, originalStatus);
    else input.graph.setTaskStatus(task.ref, succeeded ? "done" : "failed");
    return finished;
  } catch (error) {
    if (error instanceof RoleRunTimeoutError && !dryRun) {
      const background: TaskRun = {
        ...run,
        status: "running",
        failureKind: "runtime_timeout",
        errorMessage: `${error.message}; keeping role-run claim in background`,
        outputArtifacts: [],
      };
      input.graph.recordRun(background);
      input.graph.setTaskStatus(task.ref, "running");
      return background;
    }
    const failed: TaskRun = {
      ...run,
      status: "failed",
      failureKind: error instanceof RoleRunTimeoutError ? "runtime_timeout" : "runtime_error",
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt: nowIso(),
      outputArtifacts: [],
    };
    input.graph.recordRun(failed);
    input.graph.setTaskStatus(task.ref, dryRun ? originalStatus : "failed");
    throw error;
  } finally {
    stopHeartbeat?.();
  }
}

function roleRunCompletionFailure(result: SparkRoleRunResult, dryRun: boolean): string | undefined {
  if (result.record.status === "succeeded") {
    if (dryRun) return undefined;
    const emptyOutput =
      result.stdout.trim().length === 0 &&
      result.stderr.trim().length === 0 &&
      result.jsonEvents.length === 0;
    return emptyOutput ? "role run succeeded without producing output" : undefined;
  }
  if (result.record.status === "not_started") {
    if (dryRun) return undefined;
    const emptyOutput =
      result.stdout.trim().length === 0 &&
      result.stderr.trim().length === 0 &&
      result.jsonEvents.length === 0;
    return emptyOutput ? "role run did not start and produced no output" : "role run did not start";
  }
  return `role run finished with status ${result.record.status}`;
}

export interface TaskClaimHeartbeatOptions {
  graph: TaskGraph;
  taskRef: TaskRef;
  claimedBy: string;
  leaseMs: number;
  intervalMs?: number;
  onHeartbeat?: (graph: TaskGraph) => void | Promise<void>;
}

export function startTaskClaimHeartbeat(options: TaskClaimHeartbeatOptions): () => void {
  const intervalMs =
    options.intervalMs ?? Math.max(1_000, Math.min(30_000, Math.floor(options.leaseMs / 3)));
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      options.graph.heartbeatTaskClaim(options.taskRef, {
        claimedBy: options.claimedBy,
        leaseMs: options.leaseMs,
      });
      await options.onHeartbeat?.(options.graph);
    } catch {
      stopped = true;
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export class RoleRunTimeoutError extends PiRoleRunTimeoutError {
  constructor(timeoutMs: number) {
    super(timeoutMs);
    this.name = "RoleRunTimeoutError";
  }
}

export async function runRoleInstructionOnly(
  registry: RoleRegistry,
  instruction: RoleInstruction,
  options: Partial<RoleRunnerOptions> = {},
  runRef: RunRef = newRef("run"),
): Promise<SparkRoleRunResult> {
  const role = registry.get(instruction.roleRef);
  if (!instruction.instruction.trim()) throw new Error("role instruction is required");
  const startedAt = nowIso();
  const baseRecord: RoleRunRecord = {
    ref: runRef,
    roleRef: role.ref,
    runName: options.runName?.trim() || createRoleRunName(role.ref, runRef),

    instruction: instruction.instruction,
    status: (options.dryRun ?? true) ? "not_started" : "running",
    startedAt,
  };

  if (options.dryRun ?? true) {
    return {
      record: { ...baseRecord, status: "not_started", finishedAt: nowIso() },
      stdout: "",
      stderr: "",
      jsonEvents: [],
    };
  }

  return runPiJsonRole(
    role,
    instruction,
    {
      cwd: options.cwd ?? process.cwd(),
      piCommand: options.piCommand ?? "pi",
      timeoutMs: options.timeoutMs ?? 600_000,
      sessionDir: options.sessionDir,
      runName: baseRecord.runName,
      mode: options.mode,
      forkFromSession: options.forkFromSession,
    },
    baseRecord.ref,
  );
}

export function parseJsonlEvents(text: string): unknown[] {
  return parsePiJsonlEvents(text);
}

async function runPiJsonRole(
  role: { ref: RoleRef; systemPrompt: string },
  instruction: RoleInstruction,
  options: Required<Pick<RoleRunnerOptions, "cwd" | "piCommand" | "timeoutMs">> &
    Pick<RoleRunnerOptions, "sessionDir" | "runName" | "mode" | "forkFromSession">,
  runRef: RunRef,
): Promise<SparkRoleRunResult> {
  let tracked: TrackedSparkRoleRunProcess | undefined;
  try {
    const result = await runRole({
      runRef: runRef as `run:${string}`,
      roleRef: role.ref as `role:${string}`,
      systemPrompt: role.systemPrompt,
      instruction: instruction.instruction,
      runGuidance: sparkRoleRunGuidance(),
      sessionDir: options.sessionDir,
      mode: options.mode,
      forkFromSession: options.forkFromSession,
      piCommand: options.piCommand,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      onChildProcess(child, startedAt) {
        tracked = trackSparkRoleRunProcess({
          child,
          runRef,
          roleRef: role.ref,
          runName: options.runName,

          cwd: options.cwd,
          startedAt,
        });
      },
      onTimeout() {
        if (tracked) tracked.timedOutAt = nowIso();
      },
    });
    untrackSparkRoleRunProcess(runRef);
    return {
      record: {
        ref: runRef,
        roleRef: role.ref,
        runName: options.runName,
        instruction: instruction.instruction,
        status: result.record.status as RoleRunStatus,
        startedAt: result.record.startedAt,
        finishedAt: result.record.finishedAt,
      },
      stdout: result.stdout,
      stderr: result.stderr,
      jsonEvents: result.jsonEvents,
    };
  } catch (error) {
    if (error instanceof PiRoleRunTimeoutError) throw new RoleRunTimeoutError(error.timeoutMs);
    if (error instanceof RoleRunCancelledError) throw error;
    untrackSparkRoleRunProcess(runRef);
    throw error;
  }
}

function sparkRoleRunGuidance(): string {
  return [
    "Spark role-run ask policy:",
    "- You have access to Spark ask tools in this run. If the task is blocked by missing user intent, an approval gate, or a real ambiguity that cannot be resolved from repository context, use the available Spark ask tools rather than only writing questions in your final response.",
    "- Do not ask for routine implementation choices you can safely infer from the assigned task and repository context; proceed and document the decision.",
    "- If an ask times out or returns no selection for a decision/approval gate, stop and report the blocked state rather than continuing.",
    "",
    "Spark naming quality policy:",
    "- Judge whether the active thread title and your task @name/title are placeholder, generic, stale, too broad, or inconsistent with the current instruction.",
    "- When the improvement is obvious, update Spark display names without asking: use spark_rename_thread for the thread, and spark_claim_task with the existing task ref/name intent to improve your claimed task @name/title/description. Stable refs must remain unchanged.",
    "- Preserve user-specific intentional names and distinctive project/code names; ask only if multiple plausible names require a real user decision.",
  ].join("\n");
}
