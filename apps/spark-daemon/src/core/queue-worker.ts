/** Queue worker for Spark daemon tasks. */

import {
  SPARK_PROTOCOL_VERSION,
  parseSparkDaemonEvent,
  parseSparkViewModelEvent,
  type SparkDaemonEvent,
  type SparkJsonObject,
} from "@zendev-lab/spark-protocol";
import type { SparkDaemonQueue } from "./queue.ts";
import {
  createSparkDaemonActiveTasks,
  getSparkDaemonTaskSessionId,
  type SparkDaemonActiveTasks,
  type SparkDaemonQueueEntry,
  type SparkDaemonEventSink,
  type SparkDaemonTask,
  type SparkDaemonTaskExecutor,
} from "./types.ts";

export { createSparkDaemonActiveTasks };

export const DEFAULT_SPARK_DAEMON_QUEUE_LAUNCH_LIMIT = Number.POSITIVE_INFINITY;
export const DEFAULT_SPARK_DAEMON_QUEUE_CONCURRENCY = Number.POSITIVE_INFINITY;
export const DEFAULT_SPARK_DAEMON_QUEUE_TASK_TIMEOUT_MS = 600_000;

export interface ProcessSparkDaemonQueueBatchOptions {
  queue: SparkDaemonQueue;
  active: SparkDaemonActiveTasks;
  executeTask: SparkDaemonTaskExecutor;
  emitEvent?: SparkDaemonEventSink;
  label?: string;
  limit?: number;
  concurrency?: number;
  taskTimeoutMs?: number;
}

export interface WaitForSparkDaemonActiveTasksOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export async function processSparkDaemonQueueBatch(
  options: ProcessSparkDaemonQueueBatchOptions,
): Promise<boolean> {
  const limit = normalizePositiveInteger(options.limit, DEFAULT_SPARK_DAEMON_QUEUE_LAUNCH_LIMIT);
  const concurrency = normalizePositiveInteger(
    options.concurrency,
    DEFAULT_SPARK_DAEMON_QUEUE_CONCURRENCY,
  );
  const files = await options.queue.list("inbox");
  let launched = 0;

  for (const fileName of files) {
    if (options.active.files.size >= concurrency || launched >= limit) break;
    const didLaunch = await tryLaunchQueueFile({ ...options, fileName });
    if (didLaunch) launched += 1;
  }

  return launched > 0;
}

async function tryLaunchQueueFile(
  options: ProcessSparkDaemonQueueBatchOptions & { fileName: string },
): Promise<boolean> {
  if (options.active.files.has(options.fileName)) return false;

  let entry: SparkDaemonQueueEntry | null = null;
  try {
    entry = await options.queue.readEntry(options.fileName, "inbox");
    const sessionId = getSparkDaemonTaskSessionId(entry.payload.task);
    if (sessionId && options.active.invocations.hasActiveSession(sessionId)) return false;
    launchQueueTask({ ...options, entry });
    return true;
  } catch (error) {
    await failQueueTask({ ...options, entry, error });
    return true;
  }
}

function launchQueueTask(
  options: ProcessSparkDaemonQueueBatchOptions & { fileName: string; entry: SparkDaemonQueueEntry },
): void {
  const sessionId = getSparkDaemonTaskSessionId(options.entry.payload.task);
  const invocation = options.active.invocations.start({
    invocationId: options.fileName,
    kind: options.entry.payload.task.type,
    sessionId,
  });
  options.active.files.add(options.fileName);
  if (sessionId) options.active.sessions.add(sessionId);

  emitDaemonEvent(options.emitEvent, daemonTaskLifecycleEvent(options, "running"));

  void runQueueTask({
    ...options,
    invocationId: invocation.invocationId,
    signal: invocation.signal,
    cancelInvocation: (reason?: string) => invocation.cancel(reason),
  })
    .catch((error) => {
      console.error(
        `[${options.label ?? "spark-daemon"}] queue worker crashed ${options.fileName}: ${String(error)}`,
      );
    })
    .finally(() => {
      invocation.finish();
      options.active.files.delete(options.fileName);
      if (sessionId) options.active.sessions.delete(sessionId);
    });
}

async function runQueueTask(
  options: ProcessSparkDaemonQueueBatchOptions & {
    fileName: string;
    entry: SparkDaemonQueueEntry;
    invocationId: string;
    signal: AbortSignal;
    cancelInvocation: (reason?: string) => boolean;
  },
): Promise<void> {
  try {
    const timeoutMs = normalizeQueueTaskTimeoutMs(options.taskTimeoutMs);
    const result = await executeQueueTaskWithTimeout({ ...options, timeoutMs });
    await options.queue.markProcessed(options.fileName, result);
    emitDaemonEvent(options.emitEvent, daemonTaskLifecycleEvent(options, "succeeded"));
    for (const event of daemonEventsFromResult(result, options)) {
      emitDaemonEvent(options.emitEvent, event);
    }
  } catch (error) {
    if (error instanceof SparkDaemonQueueTaskCancelledError) {
      await cancelQueueTask({ ...options, error });
      return;
    }
    await failQueueTask({ ...options, error });
  }
}

async function executeQueueTaskWithTimeout(
  options: ProcessSparkDaemonQueueBatchOptions & {
    fileName: string;
    entry: SparkDaemonQueueEntry;
    invocationId: string;
    signal: AbortSignal;
    cancelInvocation: (reason?: string) => boolean;
    timeoutMs: number;
  },
): Promise<unknown> {
  const context = {
    fileName: options.fileName,
    queueEntry: options.entry,
    invocationId: options.invocationId,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    emitEvent: options.emitEvent,
  };
  const taskPromise = options.executeTask(options.entry.payload.task, context);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let abort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abort = () => {
      if (timedOut) return;
      reject(new SparkDaemonQueueTaskCancelledError(abortSignalReason(options.signal)));
    };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  });
  const races: Array<Promise<unknown>> = [taskPromise, abortPromise];

  if (options.timeoutMs > 0) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new SparkDaemonQueueTaskTimeoutError(options.timeoutMs);
          timedOut = true;
          options.cancelInvocation(error.message);
          reject(error);
        }, options.timeoutMs);
        timer.unref?.();
      }),
    );
  }

  try {
    return await Promise.race(races);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) options.signal.removeEventListener("abort", abort);
  }
}

export class SparkDaemonQueueTaskTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Spark daemon queue task timed out after ${timeoutMs}ms`);
    this.name = "SparkDaemonQueueTaskTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class SparkDaemonQueueTaskCancelledError extends Error {
  constructor(reason: string) {
    super(`Spark daemon queue task cancelled: ${reason}`);
    this.name = "SparkDaemonQueueTaskCancelledError";
  }
}

async function cancelQueueTask(
  options: ProcessSparkDaemonQueueBatchOptions & {
    fileName: string;
    entry: SparkDaemonQueueEntry | null;
    error: SparkDaemonQueueTaskCancelledError;
  },
): Promise<void> {
  console.error(
    `[${options.label ?? "spark-daemon"}] cancelled ${options.fileName}: ${String(options.error)}`,
  );
  emitDaemonEvent(
    options.emitEvent,
    daemonTaskLifecycleEvent(options, "cancelled", errorMessage(options.error)),
  );
  await options.queue.markFailed(options.fileName, options.error);
}

async function failQueueTask(
  options: ProcessSparkDaemonQueueBatchOptions & {
    fileName: string;
    entry: SparkDaemonQueueEntry | null;
    error: unknown;
  },
): Promise<void> {
  console.error(
    `[${options.label ?? "spark-daemon"}] failed ${options.fileName}: ${String(options.error)}`,
  );
  emitDaemonEvent(
    options.emitEvent,
    daemonTaskLifecycleEvent(options, "failed", errorMessage(options.error)),
  );
  await options.queue.markFailed(options.fileName, options.error);
}

function daemonTaskLifecycleEvent(
  options: {
    fileName: string;
    entry?: SparkDaemonQueueEntry | null;
    invocationId?: string;
  },
  status: "running" | "succeeded" | "failed" | "cancelled",
  summary?: string,
): SparkDaemonEvent {
  const task = options.entry?.payload.task;
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.task.lifecycle",
    source: "daemon",
    emittedAt: new Date().toISOString(),
    sessionId: task ? (getSparkDaemonTaskSessionId(task) ?? undefined) : undefined,
    ...(task?.workspaceId ? { workspaceId: task.workspaceId } : {}),
    ...(task?.projectId ? { projectId: task.projectId } : {}),
    invocationId: options.invocationId,
    taskType: task?.type ?? "unknown",
    taskFileName: options.fileName,
    status,
    summary,
    metadata: daemonTaskRouteMetadata(task),
  };
}

function daemonEventsFromResult(
  result: unknown,
  options: { entry: SparkDaemonQueueEntry; invocationId: string },
): SparkDaemonEvent[] {
  if (
    result &&
    typeof result === "object" &&
    (result as { eventsStreamed?: unknown }).eventsStreamed
  ) {
    return [];
  }
  const rawEvents =
    result && typeof result === "object"
      ? (result as { jsonEvents?: unknown }).jsonEvents
      : undefined;
  if (!Array.isArray(rawEvents)) return [];
  const sessionId = getSparkDaemonTaskSessionId(options.entry.payload.task) ?? undefined;
  return rawEvents.flatMap((raw): SparkDaemonEvent[] => {
    if (!raw || typeof raw !== "object") return [];
    const candidate = raw as { type?: unknown; event?: unknown };
    if (candidate.type === "view_event") {
      let view: ReturnType<typeof parseSparkViewModelEvent>;
      try {
        view = parseSparkViewModelEvent(candidate.event);
      } catch {
        return [];
      }
      return [
        {
          version: SPARK_PROTOCOL_VERSION,
          type: "daemon.view_event",
          source: "daemon",
          emittedAt: new Date().toISOString(),
          sessionId,
          ...(options.entry.payload.task.workspaceId
            ? { workspaceId: options.entry.payload.task.workspaceId }
            : {}),
          ...(options.entry.payload.task.projectId
            ? { projectId: options.entry.payload.task.projectId }
            : {}),
          invocationId: options.invocationId,
          view,
          metadata: daemonTaskRouteMetadata(options.entry.payload.task),
        },
      ];
    }
    if (candidate.type !== "daemon_event") return [];
    try {
      const event = parseSparkDaemonEvent(candidate.event);
      return [
        {
          ...event,
          emittedAt: event.emittedAt ?? new Date().toISOString(),
          ...(options.entry.payload.task.workspaceId && !event.workspaceId
            ? { workspaceId: options.entry.payload.task.workspaceId }
            : {}),
          ...(options.entry.payload.task.projectId && !event.projectId
            ? { projectId: options.entry.payload.task.projectId }
            : {}),
          sessionId: event.sessionId ?? sessionId,
          invocationId: event.invocationId ?? options.invocationId,
          metadata: {
            ...daemonTaskRouteMetadata(options.entry.payload.task),
            ...event.metadata,
          },
        },
      ];
    } catch {
      return [];
    }
  });
}

function daemonTaskRouteMetadata(task: SparkDaemonTask | undefined): SparkJsonObject {
  return {
    ...(task?.workspaceBindingId ? { workspaceBindingId: task.workspaceBindingId } : {}),
  };
}

function emitDaemonEvent(sink: SparkDaemonEventSink | undefined, event: SparkDaemonEvent): void {
  if (!sink) return;
  void Promise.resolve(sink(event)).catch((error) => {
    console.error(`[spark-daemon] daemon event sink failed: ${errorMessage(error)}`);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortSignalReason(signal: AbortSignal): string {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  return "abort";
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value ?? fallback);
  return normalized > 0 ? normalized : fallback;
}

function normalizeQueueTaskTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SPARK_DAEMON_QUEUE_TASK_TIMEOUT_MS;
  if (!Number.isFinite(value)) return DEFAULT_SPARK_DAEMON_QUEUE_TASK_TIMEOUT_MS;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
}

export async function waitForSparkDaemonActiveTasks(
  active: SparkDaemonActiveTasks,
  options: WaitForSparkDaemonActiveTasksOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (active.files.size > 0) {
    if (Date.now() > deadline) throw new Error("timed out waiting for Spark daemon tasks");
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function defaultSparkDaemonTaskExecutor(task: SparkDaemonTask): Promise<never> {
  throw new Error(`No Spark daemon executor wired for task type ${task.type}`);
}
