/** Queue worker for Spark daemon tasks. */

import type { SparkDaemonQueue } from "./queue.ts";
import {
  createSparkDaemonActiveTasks,
  getSparkDaemonTaskSessionId,
  type SparkDaemonActiveTasks,
  type SparkDaemonQueueEntry,
  type SparkDaemonTask,
  type SparkDaemonTaskExecutor,
} from "./types.ts";

export { createSparkDaemonActiveTasks };

export interface ProcessSparkDaemonQueueBatchOptions {
  queue: SparkDaemonQueue;
  active: SparkDaemonActiveTasks;
  executeTask: SparkDaemonTaskExecutor;
  label?: string;
  limit?: number;
  concurrency?: number;
}

export interface WaitForSparkDaemonActiveTasksOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export async function processSparkDaemonQueueBatch(
  options: ProcessSparkDaemonQueueBatchOptions,
): Promise<boolean> {
  const limit = normalizePositiveInteger(options.limit, 1);
  const concurrency = normalizePositiveInteger(options.concurrency, 1);
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
    if (sessionId && options.active.sessions.has(sessionId)) return false;
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
  options.active.files.add(options.fileName);
  if (sessionId) options.active.sessions.add(sessionId);

  void runQueueTask(options)
    .catch((error) => {
      console.error(
        `[${options.label ?? "spark-daemon"}] queue worker crashed ${options.fileName}: ${String(error)}`,
      );
    })
    .finally(() => {
      options.active.files.delete(options.fileName);
      if (sessionId) options.active.sessions.delete(sessionId);
    });
}

async function runQueueTask(
  options: ProcessSparkDaemonQueueBatchOptions & { fileName: string; entry: SparkDaemonQueueEntry },
): Promise<void> {
  try {
    await options.executeTask(options.entry.payload.task, {
      fileName: options.fileName,
      queueEntry: options.entry,
    });
    await options.queue.markProcessed(options.fileName);
  } catch (error) {
    await failQueueTask({ ...options, error });
  }
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
  await options.queue.markFailed(options.fileName, options.error);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value ?? fallback);
  return normalized > 0 ? normalized : fallback;
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
