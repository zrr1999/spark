import type { RoleRegistry, RoleRunMode } from "pi-roles";
import type { ArtifactStore } from "spark-artifacts";
import {
  DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
  type RoleRef,
  type RunRef,
  type Task,
  type TaskRef,
  type TaskRun,
  type ProjectRef,
} from "spark-core";
import { killActiveSparkRoleRunProcesses, runSparkTask } from "spark-runtime";
import type { TaskGraph } from "spark-tasks";

export interface SparkReadyTaskRunnerOptions {
  graph: TaskGraph;
  registry: RoleRegistry;
  /** Role assigned when a ready task has no task-level role hint. Defaults by task kind, then worker. */
  defaultRoleRef?: RoleRef;
  artifactStore?: ArtifactStore;
  projectRef?: ProjectRef;
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
  const schedulerAbort = new AbortController();
  let foregroundTimedOut = false;

  const schedule = async (task: Task): Promise<void> => {
    scheduled.add(task.ref);
    const preexistingRunRefs = new Set(input.graph.runs(task.projectRef).map((run) => run.ref));
    const runPromise = runSparkTask({
      graph: input.graph,
      taskRef: task.ref,
      registry: input.registry,
      defaultRoleRef: input.defaultRoleRef,
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
      signal: schedulerAbort.signal,
      claim: dryRun
        ? undefined
        : {
            sessionId: input.claim?.sessionId,
            leaseMs: input.claim?.leaseMs ?? timeoutMs,
          },
    })
      .catch((error: unknown) => taskRunRecordedForTaskError(input.graph, task, error))
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
      .runs(task.projectRef)
      .find((run) => !preexistingRunRefs.has(run.ref) && run.taskRef === task.ref)?.ref;
    const runRef = claimedRunRef ?? recordedRunRef;
    if (runRef) promiseRunRefs.set(runPromise, runRef);
    await input.onSchedule?.({
      taskRef: task.ref,
      runRef,
      running: running.size,
      scheduled: scheduled.size,
    });
  };

  try {
    while (true) {
      if (Date.now() >= deadline) {
        foregroundTimedOut = true;
        break;
      }

      const ready = input.graph
        .readyTasks(input.projectRef)
        .filter((task) => !scheduled.has(task.ref))
        .slice(0, Math.max(0, maxConcurrency - running.size));
      for (const task of ready) await schedule(task);

      if (running.size === 0) {
        const hasMoreReady = input.graph
          .readyTasks(input.projectRef)
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
  } catch (error) {
    await abortRunningReadyTaskRuns({
      running,
      promiseRunRefs,
      schedulerAbort,
      reason: `Spark ready task scheduler aborted: ${unknownErrorMessage(error)}`,
    });
    throw error;
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

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function abortRunningReadyTaskRuns(input: {
  running: Set<Promise<TaskRun>>;
  promiseRunRefs: Map<Promise<TaskRun>, RunRef>;
  schedulerAbort: AbortController;
  reason: string;
}): Promise<void> {
  if (input.running.size === 0) return;
  input.schedulerAbort.abort(input.reason);
  const runRefs = [
    ...new Set([...input.running].flatMap((run) => input.promiseRunRefs.get(run) ?? [])),
  ];
  if (runRefs.length > 0) {
    await killActiveSparkRoleRunProcesses({
      runRefs,
      reason: input.reason,
    });
  }
  await Promise.allSettled(input.running);
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

    const run = graph.runs(task.projectRef).find((candidate) => candidate.ref === runRef);
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

function taskRunRecordedForTaskError(graph: TaskGraph, task: Task, error: unknown): TaskRun {
  const latest = graph
    .runs(task.projectRef)
    .filter((run) => run.taskRef === task.ref)
    .at(-1);
  if (latest && latest.status !== "running" && latest.status !== "queued") return latest;
  throw error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
