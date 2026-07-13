import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

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
  model?: string;
  reset?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  sparkHome?: string;
  sessionSurface?: "local" | "channel";
  allowedTools?: readonly string[];
  /** Optional base identity/surface prompt; defaults to Spark host identity. */
  systemPrompt?: string;
  /** Display-safe metadata persisted on the submitted user message only. */
  messageMetadata?: Record<string, unknown>;
  onEvent?: (event: unknown) => void | Promise<void>;
}

export type SparkHeadlessSessionExecutor = (
  input: SparkHeadlessSessionRunInput,
) => Promise<unknown>;

export type CreateSparkHeadlessSessionExecutorFn = (options?: {
  /** Session/runtime state root. */
  sparkHome?: string;
  /** Provider config and auth root, independent from daemon session storage. */
  controlSparkHome?: string;
}) => SparkHeadlessSessionExecutor;

export interface SparkHeadlessSessionModule {
  createSparkHeadlessSessionExecutor: CreateSparkHeadlessSessionExecutorFn;
  createSparkHeadlessRoleExecutor?: unknown;
  runSparkHeadlessSession?: unknown;
}

export const DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE =
  "@zendev-lab/spark-tui-app/headless-role-executor" as const;

export type SparkHeadlessExecutorModuleSpecifier = typeof DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE;

/**
 * Resolve the headless executor to a real filesystem path.
 * Node refuses `--experimental-strip-types` under `node_modules/`; pnpm links the
 * workspace package there, so we import via the realpath file URL instead.
 */
export function resolveSparkHeadlessExecutorSpecifier(
  moduleSpecifier: string = DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
): string {
  if (moduleSpecifier.startsWith("file:") || moduleSpecifier.startsWith("/")) {
    return moduleSpecifier;
  }
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve(moduleSpecifier);
    const real = realpathSync(resolved);
    return pathToFileURL(real).href;
  } catch {
    return moduleSpecifier;
  }
}

export async function loadSparkHeadlessSessionModule(
  options: {
    moduleSpecifier?: string;
    importModule?: (specifier: string) => Promise<SparkHeadlessSessionModule>;
  } = {},
): Promise<SparkHeadlessSessionModule> {
  const specifier = resolveSparkHeadlessExecutorSpecifier(
    options.moduleSpecifier ?? DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
  );
  const importModule =
    options.importModule ??
    ((moduleUrl: string) => import(moduleUrl) as Promise<SparkHeadlessSessionModule>);
  return await importModule(specifier);
}
