import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
  type RunRef,
  type Task,
  type TaskRef,
  type TaskRun,
  type ProjectRef,
} from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";

export interface ReadyTaskRunInput {
  graph: TaskGraph;
  taskRef: TaskRef;
  dryRun: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  claim?: {
    sessionId?: string;
    leaseMs?: number;
  };
}

export type ReadyTaskRun = (input: ReadyTaskRunInput) => Promise<TaskRun>;

export interface ReadyTaskRunKillerInput {
  runRefs: RunRef[];
  reason: string;
}

export type ReadyTaskRunKiller = (input: ReadyTaskRunKillerInput) => Promise<unknown>;

export interface ReadyTaskRunnerOptions {
  graph: TaskGraph;
  runTask: ReadyTaskRun;
  killRuns?: ReadyTaskRunKiller;
  projectRef?: ProjectRef;
  dryRun?: boolean;
  /** Maximum number of child runs running at the same time. Default: 4. */
  maxConcurrency?: number;
  /** Foreground wait budget for this scheduler call. Expiry detaches active children instead of terminating the workflow run. */
  timeoutMs?: number;
  /** Per-child timeout. Defaults to no per-task timeout; use only when deliberately bounding each child. */
  taskTimeoutMs?: number;
  onSchedule?: (result: ReadyTaskRunnerSchedule) => void | Promise<void>;
  onProgress?: (result: ReadyTaskRunnerProgress) => void | Promise<void>;
  claim?: {
    sessionId?: string;
    leaseMs?: number;
  };
}

export interface ReadyTaskRunnerSchedule {
  taskRef: TaskRef;
  runRef?: RunRef;
  running: number;
  scheduled: number;
}

export interface ReadyTaskRunnerProgress {
  taskRef: TaskRef;
  run: TaskRun;
  running: number;
  completed: number;
}

export interface ReadyTaskRunnerResult {
  runs: TaskRun[];
  scheduled: number;
  completed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** Legacy workflow-run timeout flag. New foreground wait expiry is reported via foregroundTimedOut/detached. */
  timedOut: boolean;
  foregroundTimedOut: boolean;
  detached: boolean;
  detachedRunRefs: RunRef[];
  maxConcurrency: number;
}

export async function runReadyTasks(input: ReadyTaskRunnerOptions): Promise<ReadyTaskRunnerResult> {
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
    const runPromise = input
      .runTask({
        graph: input.graph,
        taskRef: task.ref,
        dryRun,
        timeoutMs: taskTimeoutMs ?? 0,
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
      reason: `ready task scheduler aborted: ${unknownErrorMessage(error)}`,
      killRuns: input.killRuns,
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
  killRuns?: ReadyTaskRunKiller;
}): Promise<void> {
  if (input.running.size === 0) return;
  input.schedulerAbort.abort(input.reason);
  const runRefs = [
    ...new Set([...input.running].flatMap((run) => input.promiseRunRefs.get(run) ?? [])),
  ];
  if (runRefs.length > 0 && input.killRuns) {
    await input.killRuns({ runRefs, reason: input.reason });
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
      errorMessage: `foreground wait expired after ${timeoutMs}ms; keeping child run claim in background`,
    };
    graph.recordRun(background);
    graph.setTaskStatus(task.ref, "running");
    runs.push(background);
  }
  return [...timedOutRunRefs];
}

function normalizeMaxConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value ?? DEFAULT_READY_TASK_MAX_CONCURRENCY))
    return DEFAULT_READY_TASK_MAX_CONCURRENCY;
  return Math.max(1, Math.floor(value ?? DEFAULT_READY_TASK_MAX_CONCURRENCY));
}

function normalizeReadyTaskRunnerTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value ?? DEFAULT_READY_TASK_TIMEOUT_MS))
    return DEFAULT_READY_TASK_TIMEOUT_MS;
  return Math.max(1, Math.floor(value ?? DEFAULT_READY_TASK_TIMEOUT_MS));
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
