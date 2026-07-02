import {
  SPARK_PROTOCOL_VERSION,
  parseSparkDaemonEvent,
  parseSparkViewModelEvent,
  type SparkDaemonEvent,
} from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";
import {
  loadSparkHeadlessSessionModule,
  type CreateSparkHeadlessSessionExecutorFn,
  type SparkHeadlessSessionExecutor,
} from "@zendev-lab/spark-host/headless-loader";
import type {
  SparkDaemonSessionRunTask,
  SparkDaemonTask,
  SparkDaemonTaskExecutionContext,
  SparkDaemonTaskExecutor,
} from "../core/types.ts";

export interface SparkDaemonQueueTaskExecutorOptions {
  paths: SparkPaths;
  cwd?: string;
  createSparkHeadlessSessionExecutor?: CreateSparkHeadlessSessionExecutorFn;
}

export { loadSparkHeadlessSessionModule };

export function createSparkDaemonQueueTaskExecutor(
  options: SparkDaemonQueueTaskExecutorOptions,
): SparkDaemonTaskExecutor {
  let sessionExecutor: SparkHeadlessSessionExecutor | undefined;

  const getSessionExecutor = async () => {
    if (sessionExecutor) return sessionExecutor;
    const createSessionExecutor =
      options.createSparkHeadlessSessionExecutor ??
      (await loadSparkHeadlessSessionModule()).createSparkHeadlessSessionExecutor;
    sessionExecutor = createSessionExecutor({ sparkHome: options.paths.piAgentDir });
    return sessionExecutor;
  };

  return async (task, context) => {
    if (task.type === "session.run") {
      return await executeSparkDaemonSessionRunTask(task, context, {
        ...options,
        executeSession: await getSessionExecutor(),
      });
    }
    throw new Error(`Unsupported Spark daemon queue task type: ${(task as SparkDaemonTask).type}`);
  };
}

export async function executeSparkDaemonSessionRunTask(
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
  options: SparkDaemonQueueTaskExecutorOptions & { executeSession: SparkHeadlessSessionExecutor },
): Promise<unknown> {
  return await options.executeSession({
    cwd: options.cwd ?? process.cwd(),
    sparkHome: options.paths.piAgentDir,
    sessionId: task.sessionId,
    prompt: task.prompt,
    reset: task.reset,
    signal: context.signal,
    timeoutMs: context.timeoutMs,
    onEvent: (event) => emitHeadlessEvent(event, task, context),
  });
}

function emitHeadlessEvent(
  raw: unknown,
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
): void {
  const event = daemonEventFromHeadlessEvent(raw, task, context.invocationId);
  if (event) void context.emitEvent?.(event);
}

function daemonEventFromHeadlessEvent(
  raw: unknown,
  task: SparkDaemonSessionRunTask,
  invocationId: string,
): SparkDaemonEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "view_event") {
    try {
      const view = parseSparkViewModelEvent(raw.event);
      return {
        version: SPARK_PROTOCOL_VERSION,
        type: "daemon.view_event",
        source: "daemon",
        emittedAt: new Date().toISOString(),
        metadata: {},
        sessionId: task.sessionId,
        invocationId,
        view,
      };
    } catch {
      return undefined;
    }
  }
  if (raw.type === "daemon_event") {
    try {
      const event = parseSparkDaemonEvent(raw.event);
      return {
        ...event,
        emittedAt: event.emittedAt ?? new Date().toISOString(),
        sessionId: event.sessionId ?? task.sessionId,
        invocationId: event.invocationId ?? invocationId,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
