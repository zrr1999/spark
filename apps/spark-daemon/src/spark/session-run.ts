import {
  SPARK_PROTOCOL_VERSION,
  parseSparkDaemonEvent,
  parseSparkInteractionRequest,
  parseSparkViewModelEvent,
  type SparkDaemonEvent,
  type SparkJsonObject,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
} from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";
import {
  loadSparkHeadlessSessionModule,
  type CreateSparkHeadlessSessionExecutorFn,
  type SparkHeadlessSessionExecutor,
} from "@zendev-lab/spark-host/headless-loader";
import {
  DEFAULT_SPARK_IDENTITY_PROMPT,
  SPARK_CHANNEL_ALLOWED_TOOLS,
  SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
  renderSparkChannelSurfacePrompt,
} from "@zendev-lab/spark-host/system-prompt";
import { composeAgentSystemPrompt } from "@zendev-lab/spark-modes";
import {
  renderInfoflowInternalSystemPrompt,
  renderInfoflowMessageContextPrompt,
  resolveInfoflowCustomSystemPrompt,
  type ChannelReplyStream,
  type ChannelReplyTarget,
} from "@zendev-lab/spark-channels";
import type { InfoflowAdapterConfig, QqbotAdapterConfig } from "@zendev-lab/spark-channels";
import { loadDaemonChannelsConfig, type DaemonChannelIngressRuntime } from "../channels/ingress.ts";
import type {
  SparkDaemonSessionRunTask,
  SparkDaemonTask,
  SparkDaemonTaskExecutionContext,
  SparkDaemonTaskExecutor,
} from "../core/types.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import { ChannelReplyEventProjector } from "../channels/reply-stream.ts";
import {
  ChannelReplyDeliveryPendingError,
  type ChannelReplyDeliveryStore,
} from "../channels/reply-delivery.ts";
import { assignCompletedSessionTitle } from "./session-title.ts";

export const CHANNEL_REPLY_EMPTY_ERROR_CODE = "CHANNEL_REPLY_EMPTY";

export class ChannelReplyContentError extends Error {
  readonly code = CHANNEL_REPLY_EMPTY_ERROR_CODE;

  constructor(invocationId: string) {
    super(`Channel invocation ${invocationId} completed without a deliverable assistant reply`);
    this.name = "ChannelReplyContentError";
  }
}

export interface SparkDaemonTaskExecutorOptions {
  paths: SparkPaths;
  cwd?: string;
  /** Global provider/auth control root; daemon session files remain isolated. */
  controlSparkHome?: string;
  /** Workspace channels config root (`$SPARK_HOME`); defaults to controlSparkHome. */
  channelsSparkHome?: string;
  modelControl?: Pick<SparkDaemonModelControl, "effectiveModel" | "prepareModel"> &
    Partial<Pick<SparkDaemonModelControl, "generateSessionTitle">>;
  sessionRegistry?: Pick<
    DaemonSessionRegistry,
    "recordRun" | "recordTurnQueued" | "recordTurnSettled"
  > &
    Partial<Pick<DaemonSessionRegistry, "get" | "setTitleIfMissing">>;
  createSparkHeadlessSessionExecutor?: CreateSparkHeadlessSessionExecutorFn;
  interact?: (
    request: SparkInteractionRequest,
    task: SparkDaemonSessionRunTask,
    context: SparkDaemonTaskExecutionContext,
  ) => Promise<SparkInteractionResponse>;
}

export interface SparkDaemonChannelReplyDeliveryInput {
  kind: "final" | "failure";
  idempotencyKey: string;
  invocationId: string;
  sessionId: string;
  workspaceId: string;
  adapterId: string;
  externalKey?: string;
  target: ChannelReplyTarget;
  text: string;
}

export { loadSparkHeadlessSessionModule };

export function createSparkDaemonTaskExecutor(
  options: SparkDaemonTaskExecutorOptions,
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
      let projectedFailure = false;
      const trackedContext: SparkDaemonTaskExecutionContext = {
        ...context,
        emitEvent: (event) => {
          const projected = canonicalSessionFailureEvent(
            event,
            task.sessionId,
            context.invocationId,
          );
          if (isProjectedSessionFailure(projected, task.sessionId)) projectedFailure = true;
          return context.emitEvent?.(projected);
        },
      };
      try {
        await options.sessionRegistry?.recordTurnQueued(task.sessionId);
        const effectiveTask = await withEffectiveTaskModel(task, options.modelControl);
        const result = await executeSparkDaemonSessionRunTask(effectiveTask, trackedContext, {
          ...options,
          executeSession: await getSessionExecutor(),
        });
        const completed = await recordCompletedSessionRun(
          effectiveTask,
          result,
          options.sessionRegistry,
        );
        if (completed.indexed) {
          // Naming is a post-commit projection. It must not keep the successful
          // invocation open or inherit its cancel/timeout lifecycle.
          void assignTitleAfterCompletedSessionRun(effectiveTask, context, options);
        }
        return completed.result;
      } catch (error) {
        if (!context.signal.aborted && !projectedFailure) {
          await emitSessionFailure(task, trackedContext, error);
        }
        await settleFailedSessionRun(task.sessionId, options.sessionRegistry);
        throw error;
      }
    }
    throw new Error(
      `Unsupported Spark daemon invocation task type: ${(task as SparkDaemonTask).type}`,
    );
  };
}

function isProjectedSessionFailure(event: SparkDaemonEvent, sessionId: string): boolean {
  return (
    event.type === "daemon.view_event" &&
    event.view.type === "session.message" &&
    event.view.sessionId === sessionId &&
    event.view.message.status === "error"
  );
}

function canonicalSessionFailureEvent(
  event: SparkDaemonEvent,
  sessionId: string,
  invocationId: string,
): SparkDaemonEvent {
  if (
    event.type !== "daemon.view_event" ||
    event.view.type !== "session.message" ||
    event.view.sessionId !== sessionId ||
    event.view.message.status !== "error"
  ) {
    return event;
  }
  return {
    ...event,
    invocationId,
    view: {
      ...event.view,
      message: {
        ...event.view.message,
        id: `invocation:${invocationId}:failure`,
        metadata: {
          ...event.view.message.metadata,
          source: "daemon.invocation",
          invocationId,
          kind: "invocation_failure",
        },
      },
    },
  };
}

async function emitSessionFailure(
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error);
  const createdAt = new Date().toISOString();
  try {
    await context.emitEvent?.({
      version: SPARK_PROTOCOL_VERSION,
      type: "daemon.view_event",
      source: "daemon",
      emittedAt: createdAt,
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(task.projectId ? { projectId: task.projectId } : {}),
      sessionId: task.sessionId,
      invocationId: context.invocationId,
      metadata: daemonTaskRouteMetadata(task),
      view: {
        version: SPARK_PROTOCOL_VERSION,
        type: "session.message",
        sessionId: task.sessionId,
        message: {
          version: SPARK_PROTOCOL_VERSION,
          id: `invocation:${context.invocationId}:failure`,
          role: "system",
          text: message,
          status: "error",
          createdAt,
          metadata: {
            source: "daemon.invocation",
            invocationId: context.invocationId,
            kind: "invocation_failure",
          },
        },
      },
    });
  } catch (projectionError) {
    console.error(
      `[spark-daemon] failed to project session failure ${task.sessionId}: ${errorMessage(projectionError)}`,
    );
  }
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

export function createChannelAwareTaskExecutor(
  options: SparkDaemonTaskExecutorOptions & {
    channelIngress?: Pick<DaemonChannelIngressRuntime, "openReplyStream" | "sendReply">;
    channelReplyDelivery?: Pick<
      ChannelReplyDeliveryStore,
      "stage" | "acknowledge" | "defer" | "rerouteToMessage"
    >;
  },
): SparkDaemonTaskExecutor {
  const base = createSparkDaemonTaskExecutor(options);
  return async (task, context) => {
    if (task.type !== "session.run" || !task.channelReply || !options.channelIngress) {
      return await base(task, context);
    }

    const target = channelReplyTarget(task);
    let stream: ChannelReplyStream | undefined;
    try {
      stream = await options.channelIngress.openReplyStream(
        task.channelReply.workspaceId,
        task.channelReply.adapterId,
        target,
      );
    } catch (error) {
      console.error("[spark-daemon] channel reply stream start failed; using fallback", error);
    }

    const projector = stream ? new ChannelReplyEventProjector(stream) : undefined;
    const executionContext = projector
      ? {
          ...context,
          emitEvent: (event: SparkDaemonEvent) => {
            projector.observe(event);
            return context.emitEvent?.(event);
          },
        }
      : context;

    let result: unknown;
    try {
      result = await base(task, executionContext);
    } catch (error) {
      if (stream) {
        // Progress-card finalization is a best-effort projection. Never put it
        // in front of the scheduler's durable terminal commit/outbox insert.
        void stream.fail(CHANNEL_FAILURE_REPLY_TEXT).catch((streamError) => {
          console.error("[spark-daemon] channel reply stream failure update failed", streamError);
        });
      }
      throw error;
    }

    const text = assistantTextFromResult(result) ?? projector?.finalAnswerText();
    if (!text) {
      const error = new ChannelReplyContentError(context.invocationId);
      if (stream) {
        try {
          await stream.fail("未生成可发送的回复，请稍后重试");
        } catch (streamError) {
          console.error("[spark-daemon] empty channel reply failure update failed", streamError);
        }
      }
      throw error;
    }
    const inlineStream = Boolean(stream && projector && stream.answerMode !== "separate");
    const delivery = options.channelReplyDelivery?.stage({
      invocationId: context.invocationId,
      sessionId: task.sessionId,
      workspaceId: task.channelReply.workspaceId,
      adapterId: task.channelReply.adapterId,
      target,
      text,
      deliveryMode: inlineStream ? "inline-stream" : "message",
      ...(inlineStream && stream?.deliveryRecovery ? { recovery: stream.deliveryRecovery } : {}),
    });
    if (stream && projector) {
      projector.appendFinalText(text);
      let streamCompleted = false;
      try {
        await stream.complete("已完成");
        streamCompleted = true;
      } catch (error) {
        console.error(
          "[spark-daemon] channel reply stream completion failed; durable answer remains queued",
          error,
        );
      }
      // Once the platform has accepted the completed stream, never fall through
      // to sendReply merely because the local acknowledgement write failed. The
      // outbox provides at-least-once recovery; an immediate fallback here would
      // create a deterministic duplicate on the same successful attempt.
      if (streamCompleted && stream.answerMode !== "separate") {
        if (delivery && options.channelReplyDelivery) {
          acknowledgeChannelReplyDelivery(options.channelReplyDelivery, delivery.deliveryId);
        }
        return result;
      }
      if (delivery && inlineStream) {
        options.channelReplyDelivery?.rerouteToMessage(delivery.deliveryId);
      }
    }
    try {
      await options.channelIngress.sendReply(
        task.channelReply.workspaceId,
        task.channelReply.adapterId,
        { ...target, text },
      );
    } catch (error) {
      if (delivery) {
        options.channelReplyDelivery?.defer(delivery.deliveryId, error);
        throw new ChannelReplyDeliveryPendingError(delivery.deliveryId, error);
      }
      throw error;
    }
    if (delivery && options.channelReplyDelivery) {
      acknowledgeChannelReplyDelivery(options.channelReplyDelivery, delivery.deliveryId);
    }
    return result;
  };
}

function acknowledgeChannelReplyDelivery(
  store: Pick<ChannelReplyDeliveryStore, "acknowledge" | "defer">,
  deliveryId: string,
): void {
  try {
    store.acknowledge(deliveryId);
  } catch (error) {
    // The platform side effect has already succeeded. Move the durable row to
    // retryable state without attempting another immediate send. Inline stream
    // retries update the same artifact through the adapter recovery handle.
    try {
      store.defer(deliveryId, error);
    } catch (deferError) {
      console.error("[spark-daemon] channel reply acknowledgement recovery failed", deferError);
    }
    throw new ChannelReplyDeliveryPendingError(deliveryId, error);
  }
}

export const CHANNEL_FAILURE_REPLY_TEXT = "处理失败，请稍后重试";
export const CHANNEL_EMPTY_REPLY_TEXT = "处理完成，但未生成可展示的回复";

/** Build the immutable delivery intent committed beside a terminal invocation. */
export function channelReplyDeliveryForCompletion(
  task: SparkDaemonSessionRunTask,
  invocationId: string,
  kind: SparkDaemonChannelReplyDeliveryInput["kind"],
  result?: unknown,
): SparkDaemonChannelReplyDeliveryInput | undefined {
  const channelReply = task.channelReply;
  if (!channelReply) return undefined;
  const text =
    kind === "failure"
      ? CHANNEL_FAILURE_REPLY_TEXT
      : (assistantTextFromResult(result) ?? CHANNEL_EMPTY_REPLY_TEXT);
  return {
    kind,
    idempotencyKey: `channel.reply:${kind}:${invocationId}`,
    invocationId,
    sessionId: task.sessionId,
    workspaceId: channelReply.workspaceId,
    adapterId: channelReply.adapterId,
    ...(task.channelContext?.externalKey ? { externalKey: task.channelContext.externalKey } : {}),
    target: channelReplyTarget(task),
    text,
  };
}

function channelReplyTarget(task: SparkDaemonSessionRunTask): ChannelReplyTarget {
  return {
    recipient: task.channelReply?.recipient ?? "",
    ...(task.channelContext?.senderId ? { senderId: task.channelContext.senderId } : {}),
    ...(task.channelContext?.messageId ? { messageId: task.channelContext.messageId } : {}),
    ...(task.prompt.trim() ? { preview: task.prompt.trim().slice(0, 240) } : {}),
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
  options: SparkDaemonTaskExecutorOptions & { executeSession: SparkHeadlessSessionExecutor },
): Promise<unknown> {
  const sessionSurface = await sessionSurfaceForTask(task, options.sessionRegistry);
  const systemPrompt = await systemPromptForChannelSession(task, options, sessionSurface);
  const messageMetadata = sessionRunMessageMetadata(task);
  return await options.executeSession({
    cwd: task.cwd ?? options.cwd ?? process.cwd(),
    sparkHome: options.paths.piAgentDir,
    sessionId: task.sessionId,
    prompt: task.prompt,
    ...(task.model ? { model: task.model } : {}),
    ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
    reset: task.reset,
    signal: context.signal,
    // The daemon scheduler is the single execution-time budget owner. It can
    // pause that budget while awaiting a human response; adding the headless
    // wall-clock timer here would incorrectly time out the same turn while its
    // scheduler budget is paused.
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(messageMetadata ? { messageMetadata } : {}),
    ...(sessionSurface ? { sessionSurface } : {}),
    sessionSource: sessionSourceForTask(task),
    ...(task.channelReply && task.channelContext
      ? {
          channelBinding: {
            adapter: sessionChannelAdapter(task.channelReply.adapterId),
            externalKey: task.channelContext.externalKey,
          },
        }
      : {}),
    invocationId: context.invocationId,
    ...(sessionQuestionChainForTask(task)
      ? { sessionQuestionChain: sessionQuestionChainForTask(task) }
      : {}),
    ...(sessionSurface === "channel"
      ? {
          allowedTools: SPARK_CHANNEL_ALLOWED_TOOLS,
          approvalMethod: "auto" as const,
        }
      : {}),
    ...(options.interact
      ? {
          interaction: (request) => {
            const operation = () =>
              options.interact!(parseSparkInteractionRequest(request), task, context);
            return context.withPausedTimeout ? context.withPausedTimeout(operation) : operation();
          },
        }
      : {}),
    onEvent: (event) => emitHeadlessEvent(event, task, context),
  });
}

function sessionRunMessageMetadata(task: SparkDaemonSessionRunTask): Record<string, unknown> {
  const source = sessionSourceForTask(task);
  const baseMetadata = {
    origin: {
      kind: "user",
      host: source,
      surface: source === "channel" ? "channel" : "local",
    },
  };
  const channel = task.channelContext;
  const channelMetadata = channel
    ? {
        origin: {
          kind: "user",
          host: "channel",
          surface: "channel",
          adapter: task.channelReply?.adapterId ?? "infoflow",
          externalKey: channel.externalKey,
          ...(channel.senderId ? { senderId: channel.senderId } : {}),
          ...(channel.senderName ? { senderName: channel.senderName } : {}),
        },
        channel: {
          adapter: task.channelReply?.adapterId ?? "infoflow",
          externalKey: channel.externalKey,
          ...(channel.senderId ? { senderId: channel.senderId } : {}),
          ...(channel.senderName ? { senderName: channel.senderName } : {}),
          ...(channel.chatId ? { chatId: channel.chatId } : {}),
          ...(channel.messageId ? { messageId: channel.messageId } : {}),
          ...(channel.eventType ? { eventType: channel.eventType } : {}),
          ...(channel.contentType ? { contentType: channel.contentType } : {}),
          ...(channel.attachments?.length ? { attachments: channel.attachments } : {}),
        },
      }
    : undefined;
  return {
    ...baseMetadata,
    ...(task.messageMetadata ?? {}),
    ...(channelMetadata ?? {}),
  };
}

function sessionQuestionChainForTask(task: SparkDaemonSessionRunTask): string[] | undefined {
  const mail = task.messageMetadata?.sessionMail;
  if (!mail || typeof mail !== "object" || Array.isArray(mail)) return undefined;
  const chain = (mail as { questionChain?: unknown }).questionChain;
  if (!Array.isArray(chain)) return undefined;
  const normalized = chain
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function sessionChannelAdapter(adapterId: string): "feishu" | "infoflow" | "qqbot" {
  if (adapterId === "feishu" || adapterId === "infoflow" || adapterId === "qqbot") {
    return adapterId;
  }
  throw new Error(`Unsupported session channel adapter: ${adapterId}`);
}

function sessionSourceForTask(
  task: SparkDaemonSessionRunTask,
): "tui" | "web" | "channel" | "daemon" | "session" {
  if (task.channelReply || task.channelContext) return "channel";
  const origin = task.messageMetadata?.origin;
  if (origin && typeof origin === "object" && !Array.isArray(origin)) {
    const originRecord = origin as { kind?: unknown; host?: unknown };
    if (originRecord.kind === "session") return "session";
    const host = originRecord.host;
    if (
      host === "tui" ||
      host === "web" ||
      host === "channel" ||
      host === "daemon" ||
      host === "session"
    ) {
      return host;
    }
  }
  if (task.assignment?.source.kind === "cockpit") return "web";
  return "daemon";
}

async function sessionSurfaceForTask(
  task: SparkDaemonSessionRunTask,
  registry: SparkDaemonTaskExecutorOptions["sessionRegistry"],
): Promise<"local" | "channel" | undefined> {
  if (task.channelReply) return "channel";
  const session = await registry?.get?.(task.sessionId);
  if (!session) return undefined;
  return session.bindings.length > 0 ? "channel" : "local";
}

async function systemPromptForChannelSession(
  task: SparkDaemonSessionRunTask,
  options: SparkDaemonTaskExecutorOptions,
  sessionSurface: "local" | "channel" | undefined,
): Promise<string | undefined> {
  if (sessionSurface !== "channel") return undefined;
  const reply = task.channelReply;
  if (!reply) {
    return composeAgentSystemPrompt([
      DEFAULT_SPARK_IDENTITY_PROMPT,
      SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
    ]);
  }
  const externalKey = task.channelContext?.externalKey;
  const scope =
    externalKey?.startsWith("infoflow:group:") ||
    externalKey?.startsWith("qqbot:group:") ||
    externalKey?.startsWith("qqbot:channel:") ||
    reply.recipient.startsWith("group:") ||
    reply.recipient.startsWith("channel:")
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
      SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
      task.channelContext ? renderInfoflowMessageContextPrompt(task.channelContext) : undefined,
    ]);
  }

  if (reply.adapterId === "qqbot") {
    const qqbot = await loadQqbotAdapterConfig(options, reply.workspaceId);
    const custom = qqbot?.system_prompt?.trim();
    return composeAgentSystemPrompt([
      DEFAULT_SPARK_IDENTITY_PROMPT,
      renderSparkChannelSurfacePrompt({
        adapter: "qqbot",
        scope,
        ...(externalKey ? { externalKey } : {}),
      }),
      custom || undefined,
      SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
    ]);
  }

  return composeAgentSystemPrompt([
    DEFAULT_SPARK_IDENTITY_PROMPT,
    renderSparkChannelSurfacePrompt({
      adapter: reply.adapterId,
      scope,
    }),
    SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
  ]);
}

async function loadInfoflowAdapterConfig(
  options: SparkDaemonTaskExecutorOptions,
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

async function loadQqbotAdapterConfig(
  options: SparkDaemonTaskExecutorOptions,
  workspaceId: string,
): Promise<QqbotAdapterConfig | undefined> {
  const sparkHome = options.channelsSparkHome ?? options.controlSparkHome;
  if (!sparkHome) return undefined;
  try {
    const loaded = await loadDaemonChannelsConfig(sparkHome, workspaceId);
    const adapter = Object.values(loaded.config?.adapters ?? {}).find(
      (entry) => entry.type === "qqbot",
    );
    return adapter?.type === "qqbot" ? adapter : undefined;
  } catch (error) {
    console.error("[spark-daemon] failed to load qqbot channel config for prompts", error);
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

function daemonTaskRouteMetadata(task: SparkDaemonTask | undefined): SparkJsonObject {
  return {
    ...(task?.workspaceBindingId ? { workspaceBindingId: task.workspaceBindingId } : {}),
  };
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
): Promise<{ result: unknown; indexed: boolean }> {
  if (!registry) return { result, indexed: false };
  const sessionPath =
    isRecord(result) && typeof result.sessionPath === "string" && result.sessionPath.trim()
      ? result.sessionPath.trim()
      : undefined;
  if (!sessionPath) {
    await settleSessionRun(task.sessionId, registry, "missing native sessionPath");
    return {
      result: registryWarning(
        result,
        `session ${task.sessionId} completed without a native sessionPath`,
      ),
      indexed: false,
    };
  }
  try {
    await registry.recordRun({ sessionId: task.sessionId, sessionPath });
    return { result, indexed: true };
  } catch (error) {
    const message = `failed to index completed session ${task.sessionId}: ${errorMessage(error)}`;
    console.error(`[spark-daemon] ${message}`);
    // The transcript and model turn have already committed. Keep the invocation
    // terminal and surface the indexing failure in its durable result so a
    // retry cannot duplicate the completed user turn.
    await settleSessionRun(task.sessionId, registry, "registry persistence failure");
    return { result: registryWarning(result, message), indexed: false };
  }
}

async function assignTitleAfterCompletedSessionRun(
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
  options: SparkDaemonTaskExecutorOptions,
): Promise<void> {
  const generateSessionTitle = options.modelControl?.generateSessionTitle;
  const get = options.sessionRegistry?.get;
  const setTitleIfMissing = options.sessionRegistry?.setTitleIfMissing;
  if (!task.model || !generateSessionTitle || !get || !setTitleIfMissing) return;
  try {
    const session = await assignCompletedSessionTitle(
      {
        sessionId: task.sessionId,
        prompt: task.prompt,
        model: modelRefFromValue(task.model),
        signal: AbortSignal.timeout(5_000),
      },
      {
        modelControl: {
          generateSessionTitle: (input) => options.modelControl!.generateSessionTitle!(input),
        },
        sessionRegistry: {
          get: (sessionId) => options.sessionRegistry!.get!(sessionId),
          setTitleIfMissing: (sessionId, title) =>
            options.sessionRegistry!.setTitleIfMissing!(sessionId, title),
        },
      },
    );
    if (!session?.title) return;
    await context.emitEvent?.({
      version: SPARK_PROTOCOL_VERSION,
      type: "daemon.session.updated",
      source: "daemon",
      emittedAt: new Date().toISOString(),
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(task.projectId ? { projectId: task.projectId } : {}),
      sessionId: task.sessionId,
      invocationId: context.invocationId,
      title: session.title,
      metadata: daemonTaskRouteMetadata(task),
    });
  } catch {
    // Keep naming fully advisory even if a future dependency implementation
    // violates the helper's best-effort contract.
    console.error(`[spark-daemon] unexpected session title failure for ${task.sessionId}`);
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
