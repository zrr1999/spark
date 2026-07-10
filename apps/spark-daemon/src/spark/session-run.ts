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
import {
  DEFAULT_SPARK_IDENTITY_PROMPT,
  renderSparkChannelSurfacePrompt,
} from "@zendev-lab/spark-host/system-prompt";
import { composeAgentSystemPrompt } from "@zendev-lab/spark-modes";
import {
  renderInfoflowInternalSystemPrompt,
  renderInfoflowMessageContextPrompt,
  resolveInfoflowCustomSystemPrompt,
} from "@zendev-lab/spark-channels";
import type { InfoflowAdapterConfig } from "@zendev-lab/spark-channels";
import { loadDaemonChannelsConfig, type DaemonChannelIngressRuntime } from "../channels/ingress.ts";
import type {
  SparkDaemonSessionRunTask,
  SparkDaemonTask,
  SparkDaemonTaskExecutionContext,
  SparkDaemonTaskExecutor,
} from "../core/types.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import { daemonTaskRouteMetadata } from "../core/queue-worker.ts";

export interface SparkDaemonQueueTaskExecutorOptions {
  paths: SparkPaths;
  cwd?: string;
  /** Global provider/auth control root; daemon session files remain isolated. */
  controlSparkHome?: string;
  /** Workspace channels config root (`$SPARK_HOME`); defaults to controlSparkHome. */
  channelsSparkHome?: string;
  modelControl?: Pick<SparkDaemonModelControl, "effectiveModel" | "prepareModel">;
  sessionRegistry?: Pick<
    DaemonSessionRegistry,
    "recordRun" | "recordTurnQueued" | "recordTurnSettled"
  >;
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
    sessionExecutor = createSessionExecutor({
      ...(options.paths.piAgentDir ? { sparkHome: options.paths.piAgentDir } : {}),
      ...(options.controlSparkHome ? { controlSparkHome: options.controlSparkHome } : {}),
    });
    return sessionExecutor;
  };

  return async (task, context) => {
    if (task.type === "session.run") {
      try {
        await options.sessionRegistry?.recordTurnQueued(task.sessionId);
        const effectiveTask = await withEffectiveTaskModel(task, options.modelControl);
        const result = await executeSparkDaemonSessionRunTask(effectiveTask, context, {
          ...options,
          executeSession: await getSessionExecutor(),
        });
        return await recordCompletedSessionRun(effectiveTask, result, options.sessionRegistry);
      } catch (error) {
        await settleFailedSessionRun(task.sessionId, options.sessionRegistry);
        throw error;
      }
    }
    throw new Error(`Unsupported Spark daemon queue task type: ${(task as SparkDaemonTask).type}`);
  };
}

async function withEffectiveTaskModel(
  task: SparkDaemonSessionRunTask,
  modelControl: Pick<SparkDaemonModelControl, "effectiveModel" | "prepareModel"> | undefined,
): Promise<SparkDaemonSessionRunTask> {
  if (!modelControl) return task;
  const model = task.model
    ? modelRefFromValue(task.model)
    : await modelControl.effectiveModel(task.sessionId);
  await modelControl.prepareModel(model);
  return task.model ? task : { ...task, model: `${model.providerName}/${model.modelId}` };
}

function modelRefFromValue(value: string): { providerName: string; modelId: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid frozen Spark model: ${value}`);
  }
  return { providerName: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function createChannelAwareQueueTaskExecutor(
  options: SparkDaemonQueueTaskExecutorOptions & {
    channelIngress?: Pick<DaemonChannelIngressRuntime, "notify">;
  },
): SparkDaemonTaskExecutor {
  const base = createSparkDaemonQueueTaskExecutor(options);
  return async (task, context) => {
    const result = await base(task, context);
    if (task.type !== "session.run" || !task.channelReply || !options.channelIngress) {
      return result;
    }
    const text = assistantTextFromResult(result);
    if (!text) return result;
    try {
      await options.channelIngress.notify(task.channelReply.workspaceId, {
        action: "send",
        adapter: task.channelReply.adapterId,
        recipient: task.channelReply.recipient,
        text,
      });
    } catch (error) {
      console.error("[spark-daemon] channel reply failed", error);
    }
    return result;
  };
}

function assistantTextFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const text = (result as { assistantText?: unknown }).assistantText;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

export async function executeSparkDaemonSessionRunTask(
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
  options: SparkDaemonQueueTaskExecutorOptions & { executeSession: SparkHeadlessSessionExecutor },
): Promise<unknown> {
  const systemPrompt = await systemPromptForChannelSession(task, options);
  return await options.executeSession({
    cwd: task.cwd ?? options.cwd ?? process.cwd(),
    sparkHome: options.paths.piAgentDir,
    sessionId: task.sessionId,
    prompt: task.prompt,
    ...(task.model ? { model: task.model } : {}),
    reset: task.reset,
    signal: context.signal,
    timeoutMs: context.timeoutMs,
    ...(systemPrompt ? { systemPrompt } : {}),
    onEvent: (event) => emitHeadlessEvent(event, task, context),
  });
}

async function systemPromptForChannelSession(
  task: SparkDaemonSessionRunTask,
  options: SparkDaemonQueueTaskExecutorOptions,
): Promise<string | undefined> {
  const reply = task.channelReply;
  if (!reply) return undefined;
  const externalKey = task.channelContext?.externalKey;
  const scope =
    externalKey?.startsWith("infoflow:group:") || reply.recipient.startsWith("group:")
      ? "group"
      : "user";

  if (reply.adapterId === "infoflow") {
    const bindingKey =
      externalKey ??
      (scope === "group" ? `infoflow:${reply.recipient}` : `infoflow:user:${reply.recipient}`);
    const infoflow = await loadInfoflowAdapterConfig(options, reply.workspaceId);
    return composeAgentSystemPrompt([
      DEFAULT_SPARK_IDENTITY_PROMPT,
      renderInfoflowInternalSystemPrompt({
        ...(infoflow ? { config: infoflow } : {}),
        scope,
        externalKey: bindingKey,
      }),
      infoflow ? resolveInfoflowCustomSystemPrompt(infoflow) : undefined,
      task.channelContext ? renderInfoflowMessageContextPrompt(task.channelContext) : undefined,
    ]);
  }

  return composeAgentSystemPrompt([
    DEFAULT_SPARK_IDENTITY_PROMPT,
    renderSparkChannelSurfacePrompt({
      adapter: reply.adapterId,
      scope,
    }),
  ]);
}

async function loadInfoflowAdapterConfig(
  options: SparkDaemonQueueTaskExecutorOptions,
  workspaceId: string,
): Promise<InfoflowAdapterConfig | undefined> {
  const sparkHome = options.channelsSparkHome ?? options.controlSparkHome;
  if (!sparkHome) return undefined;
  try {
    const loaded = await loadDaemonChannelsConfig(sparkHome, workspaceId);
    const adapter = Object.values(loaded.config?.adapters ?? {}).find(
      (entry) => entry.type === "infoflow",
    );
    return adapter?.type === "infoflow" ? adapter : undefined;
  } catch (error) {
    console.error("[spark-daemon] failed to load infoflow channel config for prompts", error);
    return undefined;
  }
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
        ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
        ...(task.projectId ? { projectId: task.projectId } : {}),
        metadata: daemonTaskRouteMetadata(task),
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
        ...(task.workspaceId && !event.workspaceId ? { workspaceId: task.workspaceId } : {}),
        ...(task.projectId && !event.projectId ? { projectId: task.projectId } : {}),
        sessionId: event.sessionId ?? task.sessionId,
        invocationId: event.invocationId ?? invocationId,
        metadata: {
          ...daemonTaskRouteMetadata(task),
          ...event.metadata,
        },
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function recordCompletedSessionRun(
  task: SparkDaemonSessionRunTask,
  result: unknown,
  registry: Pick<DaemonSessionRegistry, "recordRun" | "recordTurnSettled"> | undefined,
): Promise<unknown> {
  if (!registry) return result;
  const sessionPath =
    isRecord(result) && typeof result.sessionPath === "string" && result.sessionPath.trim()
      ? result.sessionPath.trim()
      : undefined;
  if (!sessionPath) {
    await settleSessionRun(task.sessionId, registry, "missing native sessionPath");
    return registryWarning(
      result,
      `session ${task.sessionId} completed without a native sessionPath`,
    );
  }
  try {
    await registry.recordRun({ sessionId: task.sessionId, sessionPath });
    return result;
  } catch (error) {
    const message = `failed to index completed session ${task.sessionId}: ${errorMessage(error)}`;
    console.error(`[spark-daemon] ${message}`);
    // The transcript and model turn have already committed. Keep the queue item
    // processed and surface the indexing failure in its durable result so a
    // retry cannot duplicate the completed user turn.
    await settleSessionRun(task.sessionId, registry, "registry persistence failure");
    return registryWarning(result, message);
  }
}

async function settleFailedSessionRun(
  sessionId: string,
  registry: Pick<DaemonSessionRegistry, "recordTurnSettled"> | undefined,
): Promise<void> {
  await settleSessionRun(sessionId, registry, "execution error");
}

async function settleSessionRun(
  sessionId: string,
  registry: Pick<DaemonSessionRegistry, "recordTurnSettled"> | undefined,
  reason: string,
): Promise<void> {
  if (!registry) return;
  try {
    await registry.recordTurnSettled(sessionId);
  } catch (error) {
    console.error(
      `[spark-daemon] failed to settle session ${sessionId} after ${reason}: ${errorMessage(error)}`,
    );
  }
}

function registryWarning(result: unknown, message: string): Record<string, unknown> {
  return {
    ...(isRecord(result) ? result : { result }),
    registryPersistence: { status: "failed", message },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
