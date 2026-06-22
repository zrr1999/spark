import type { NaviaPaths } from "@zendev-lab/navia-system";
import type {
  SparkDaemonSessionRunTask,
  SparkDaemonTask,
  SparkDaemonTaskExecutionContext,
  SparkDaemonTaskExecutor,
} from "../core/types.ts";

type SparkHeadlessSessionExecutor = (input: {
  cwd: string;
  sessionId: string;
  prompt: string;
  reset?: boolean;
  signal?: AbortSignal;
  sparkHome?: string;
}) => Promise<unknown>;

type CreateSparkHeadlessSessionExecutorFn = (options?: {
  sparkHome?: string;
}) => SparkHeadlessSessionExecutor;

interface SparkHeadlessSessionModule {
  createSparkHeadlessSessionExecutor: CreateSparkHeadlessSessionExecutorFn;
}

export interface SparkDaemonQueueTaskExecutorOptions {
  paths: NaviaPaths;
  cwd?: string;
  createSparkHeadlessSessionExecutor?: CreateSparkHeadlessSessionExecutorFn;
}

async function dynamicImport<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

async function loadSparkHeadlessSessionModule(): Promise<SparkHeadlessSessionModule> {
  return await dynamicImport<SparkHeadlessSessionModule>(
    "@zendev-lab/spark-tui-app/headless-role-executor",
  );
}

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
  });
}
