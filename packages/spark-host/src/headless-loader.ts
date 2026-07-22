import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
  ToolEffect,
} from "@zendev-lab/spark-core";

export type SparkHeadlessRoleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_started";

export type SparkHeadlessUserContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

export interface SparkHeadlessSessionRunInput {
  cwd: string;
  sessionId: string;
  prompt: SparkHeadlessUserContent;
  model?: string;
  thinkingLevel?: string;
  reset?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  sparkHome?: string;
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  channelBinding?: {
    adapter: "feishu" | "infoflow" | "qqbot";
    externalKey: string;
    workspaceId?: string;
    recipient?: string;
    adapterId?: string;
    adapterAccountIdentity?: string;
  };
  invocationId?: string;
  sessionQuestionChain?: readonly string[];
  allowedTools?: readonly string[];
  /** Host-enforced effect allowlist; unknown tool effects are denied. */
  allowedToolEffects?: readonly ToolEffect[];
  /** Optional base identity/surface prompt; defaults to Spark host identity. */
  systemPrompt?: string;
  /** Display-safe metadata persisted on the submitted user message only. */
  messageMetadata?: Record<string, unknown>;
  /** Tool approval method inherited by the headless host. */
  approvalMethod?: "skip" | "human" | "auto";
  approvalRejectAction?: "ask" | "deny";
  /** Daemon-owned UI bridge used by blocking and async structured asks. */
  interaction?: (request: ExtensionInteractionRequest) => Promise<ExtensionInteractionResponse>;
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
    const resolved = import.meta.resolve(moduleSpecifier);
    const real = realpathSync(new URL(resolved));
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
