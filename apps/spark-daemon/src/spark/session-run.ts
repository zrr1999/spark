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
import type { DaemonChannelIngressRuntime } from "../channels/ingress.ts";
import type {
  SparkDaemonSessionRunTask,
  SparkDaemonTask,
  SparkDaemonTaskExecutionContext,
  SparkDaemonTaskExecutor,
} from "../core/types.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";

export interface SparkDaemonQueueTaskExecutorOptions {
  paths: SparkPaths;
  cwd?: string;
  /** Global provider/auth control root; daemon session files remain isolated. */
  controlSparkHome?: string;
  modelControl?: Pick<SparkDaemonModelControl, "effectiveModel" | "prepareModel">;
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
      const effectiveTask = await withEffectiveTaskModel(task, options.modelControl);
      return await executeSparkDaemonSessionRunTask(effectiveTask, context, {
        ...options,
        executeSession: await getSessionExecutor(),
      });
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
  const systemPrompt = systemPromptForChannelSession(task);
  return await options.executeSession({
    cwd: options.cwd ?? process.cwd(),
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

function systemPromptForChannelSession(task: SparkDaemonSessionRunTask): string | undefined {
  const reply = task.channelReply;
  if (!reply) return undefined;
  const scope = reply.recipient.startsWith("group:") ? "group" : "user";
  const externalKey =
    reply.adapterId === "infoflow"
      ? scope === "group"
        ? `infoflow:${reply.recipient}`
        : `infoflow:user:${reply.recipient}`
      : undefined;
  return composeAgentSystemPrompt([
    DEFAULT_SPARK_IDENTITY_PROMPT,
    renderSparkChannelSurfacePrompt({
      adapter: reply.adapterId,
      scope,
      ...(externalKey ? { externalKey } : {}),
    }),
  ]);
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
