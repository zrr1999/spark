import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
    result: Pick<SparkReadyTaskRunnerResult, "scheduled" | "completed" | "timedOut"> &
      Partial<Pick<SparkReadyTaskRunnerResult, "failed" | "cancelled">>,
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
      record.scheduled = result.scheduled;
      record.completed = result.completed;
      record.timedOut = result.timedOut;
      record.status = error
        ? "failed"
        : result.timedOut
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
    nextActions.push("Check for pending tasks blocked by dependencies or plan readiness.");
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
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: boolean;
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
  let timedOut = false;

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
    succeeded: runs.filter((run) => run.status === "succeeded").length,
    failed: runs.filter((run) => run.status === "failed").length,
    cancelled: runs.filter((run) => run.status === "cancelled").length,
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
  return {
    ref: latest as RunRef,
    threadRef: task.threadRef,
    taskRef: task.ref,
    roleRef: task.claim?.roleRef ?? task.roleRef,
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
