export type SparkHeadlessRoleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_started";

export interface SparkHeadlessSessionRunInput {
  cwd: string;
  sessionId: string;
  prompt: string;
  reset?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  sparkHome?: string;
  onEvent?: (event: unknown) => void | Promise<void>;
}

export type SparkHeadlessSessionExecutor = (
  input: SparkHeadlessSessionRunInput,
) => Promise<unknown>;

export type CreateSparkHeadlessSessionExecutorFn = (options?: {
  sparkHome?: string;
}) => SparkHeadlessSessionExecutor;

export interface SparkHeadlessSessionModule {
  createSparkHeadlessSessionExecutor: CreateSparkHeadlessSessionExecutorFn;
  createSparkHeadlessRoleExecutor?: unknown;
  runSparkHeadlessSession?: unknown;
}

export const DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE =
  "@zendev-lab/spark-tui-app/headless-role-executor" as const;

export type SparkHeadlessExecutorModuleSpecifier = typeof DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE;

export async function loadSparkHeadlessSessionModule(
  options: {
    moduleSpecifier?: string;
    importModule?: (specifier: string) => Promise<SparkHeadlessSessionModule>;
  } = {},
): Promise<SparkHeadlessSessionModule> {
  const importModule =
    options.importModule ??
    ((specifier: string) => import(specifier) as Promise<SparkHeadlessSessionModule>);
  return await importModule(options.moduleSpecifier ?? DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE);
}
