import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import type { SparkHostDriverContext } from "@zendev-lab/spark-core";
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
  renderPersistentSessionRolePrompt,
  renderSparkChannelSurfacePrompt,
} from "@zendev-lab/spark-host/system-prompt";
import { composeAgentSystemPrompt } from "@zendev-lab/spark-modes";
import {
  channelDeliveryFailureOutcome,
  channelDeliveryOutcomeUnknown,
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
  SparkDaemonDriverTickTask,
  SparkDaemonTask,
  SparkDaemonTaskExecutionContext,
  SparkDaemonTaskExecutor,
} from "../core/types.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import { ensureDaemonSessionTranscript } from "../session-transcript-control.ts";
import { ChannelReplyEventProjector } from "../channels/reply-stream.ts";
import type { ChannelReplyDeliveryStore } from "../channels/reply-delivery.ts";
import { assignCompletedSessionRole } from "./session-title.ts";

export const CHANNEL_REPLY_EMPTY_ERROR_CODE = "CHANNEL_REPLY_EMPTY";
export const CHANNEL_REPLY_TERMINAL_PRESENTED_ERROR_CODE = "CHANNEL_REPLY_TERMINAL_PRESENTED";

const SPARK_SIDE_THREAD_EXECUTION_PROMPT = `You are running inside a Spark Side Thread: an isolated, daemon-owned child conversation used to investigate a question without mutating the parent workspace.

This surface is always read-only. Inspect, search, reason, and report findings, but do not modify files, repository state, processes, services, credentials, remote systems, or other sessions. Tool permissions enforce this boundary independently of these instructions.`;

export class ChannelReplyContentError extends Error {
  readonly code = CHANNEL_REPLY_EMPTY_ERROR_CODE;

  constructor(invocationId: string) {
    super(`Channel invocation ${invocationId} completed without a deliverable assistant reply`);
    this.name = "ChannelReplyContentError";
  }
}

class ChannelReplyTerminalPresentedError extends Error {
  readonly code = CHANNEL_REPLY_TERMINAL_PRESENTED_ERROR_CODE;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ChannelReplyTerminalPresentedError";
  }
}

export interface SparkDaemonTaskExecutorOptions {
  paths: SparkPaths;
  cwd?: string;
  /** Global provider/auth control root; daemon session files remain isolated. */
  controlSparkHome?: string;
  /** Workspace channels config data root; defaults to controlSparkHome. */
  channelsSparkHome?: string;
  modelControl?: Pick<SparkDaemonModelControl, "effectiveModel" | "prepareModel"> &
    Partial<Pick<SparkDaemonModelControl, "generateSessionRole">>;
  sessionRegistry?: Pick<
    DaemonSessionRegistry,
    "recordRun" | "recordTurnQueued" | "recordTurnSettled"
  > &
    Partial<Pick<DaemonSessionRegistry, "bindTranscriptPath" | "get" | "setRoleIfMissing">>;
  createSparkHeadlessSessionExecutor?: CreateSparkHeadlessSessionExecutorFn;
  driverControl?: {
    schedule(
      task: SparkDaemonDriverTickTask,
      input: { delayMs?: number; dueAt?: string; reason?: string; prompt?: string },
    ): unknown;
    stop(task: SparkDaemonDriverTickTask, input?: { reason?: string }): unknown;
  };
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
  adapterAccountIdentity?: string;
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
    if (task.type === "session.run" || task.type === "driver.tick") {
      const driverTask = task.type === "driver.tick" ? task : undefined;
      const sessionTask: SparkDaemonSessionRunTask =
        task.type === "driver.tick" ? sessionRunTaskFromDriverTick(task) : task;
      let projectedFailure = false;
      const trackedContext: SparkDaemonTaskExecutionContext = {
        ...context,
        emitEvent: (event) => {
          const projected = canonicalSessionFailureEvent(
            event,
            sessionTask.sessionId,
            context.invocationId,
          );
          if (isProjectedSessionFailure(projected, sessionTask.sessionId)) projectedFailure = true;
          return context.emitEvent?.(projected);
        },
      };
      try {
        await options.sessionRegistry?.recordTurnQueued(sessionTask.sessionId);
        const effectiveTask = await withEffectiveTaskModel(sessionTask, options.modelControl);
        const result = await executeSparkDaemonSessionRunTask(
          effectiveTask,
          trackedContext,
          {
            ...options,
            executeSession: await getSessionExecutor(),
          },
          driverTask ? driverContextForTask(driverTask, options.driverControl) : undefined,
        );
        const completed = await recordCompletedSessionRun(
          effectiveTask,
          result,
          options.sessionRegistry,
        );
        if (completed.indexed) {
          // Naming is a detached post-commit projection, so it must not keep a
          // successful invocation open. It still observes cancellation/drain
          // to avoid writing new projection state after ownership ends.
          void assignRoleAfterCompletedSessionRun(effectiveTask, context, options);
        }
        return completed.result;
      } catch (error) {
        if (!context.signal.aborted && !projectedFailure) {
          await emitSessionFailure(sessionTask, trackedContext, error);
        }
        await settleFailedSessionRun(sessionTask.sessionId, options.sessionRegistry);
        throw error;
      }
    }
    throw new Error(
      `Unsupported Spark daemon invocation task type: ${(task as SparkDaemonTask).type}`,
    );
  };
}

function sessionRunTaskFromDriverTick(task: SparkDaemonDriverTickTask): SparkDaemonSessionRunTask {
  return {
    type: "session.run",
    sessionId: task.ownerSessionId,
    executionSessionId: task.executionSessionId,
    stateOwnerSessionId: task.stateOwnerSessionId,
    hiddenExecution: task.continuity === "fresh",
    prompt: task.prompt,
    cwd: task.cwd,
    workspaceBindingId: task.workspaceBindingId,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    reset: task.reset,
    resumeFromInterrupt: task.resumeFromInterrupt,
    actor: "spark-daemon-driver",
    note: `${task.kind}:${task.driverId}:${task.generation}`,
  };
}

function driverContextForTask(
  task: SparkDaemonDriverTickTask,
  control: SparkDaemonTaskExecutorOptions["driverControl"],
): SparkHostDriverContext {
  if (!control) {
    throw new Error("driver.tick executor requires daemon driverControl");
  }
  return {
    driverId: task.driverId,
    kind: task.kind,
    generation: task.generation,
    ownerSessionId: task.ownerSessionId,
    stateOwnerSessionId: task.stateOwnerSessionId,
    schedule: async (input) => await control.schedule(task, input),
    stop: async (input) => await control.stop(task, input),
  };
}

function isProjectedSessionFailure(event: SparkDaemonEvent, sessionId: string): boolean {
  return (
    event.type === "daemon.view_event" &&
    event.view.type === "session.message" &&
    event.view.sessionId === sessionId &&
    isTerminalSessionFailureMessage(event.view.message)
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
    !isTerminalSessionFailureMessage(event.view.message)
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

function isTerminalSessionFailureMessage(message: { role: string; status: string }): boolean {
  return message.status === "error" && (message.role === "assistant" || message.role === "system");
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
      "stage" | "updateText" | "acknowledge" | "defer" | "rerouteToMessage"
    >;
  },
): SparkDaemonTaskExecutor {
  const base = createSparkDaemonTaskExecutor(options);
  return async (task, context) => {
    if (task.type !== "session.run" || !task.channelReply || !options.channelIngress) {
      return await base(task, context);
    }

    const target = channelReplyTarget(task);
    let inlineDelivery:
      | ReturnType<NonNullable<typeof options.channelReplyDelivery>["stage"]>
      | undefined;
    const persistInlineRecovery = (created: ChannelReplyStream): void => {
      if (
        inlineDelivery ||
        created.answerMode === "separate" ||
        !created.deliveryRecovery ||
        !options.channelReplyDelivery
      ) {
        return;
      }
      inlineDelivery = options.channelReplyDelivery.stage({
        invocationId: context.invocationId,
        sessionId: task.sessionId,
        workspaceId: task.channelReply!.workspaceId,
        adapterId: task.channelReply!.adapterId,
        target,
        // If the process exits during model execution, startup recovery updates
        // the already-created card with this honest terminal instead of sending
        // a second ordinary message or leaving a permanent spinner.
        text: CHANNEL_INTERRUPTED_REPLY_TEXT,
        deliveryMode: "inline-stream",
        recovery: created.deliveryRecovery,
      });
    };
    let stream: ChannelReplyStream | undefined;
    try {
      stream = await options.channelIngress.openReplyStream(
        task.channelReply.workspaceId,
        task.channelReply.adapterId,
        target,
        { onCreated: persistInlineRecovery },
      );
      // Compatibility fallback for ingress implementations and tests that do
      // not yet invoke onCreated. The real registry calls it synchronously as
      // soon as the platform returns the recovery handle.
      if (stream) persistInlineRecovery(stream);
    } catch (error) {
      if (channelDeliveryFailureOutcome(error) !== "not_sent") {
        // An untagged transport failure may already have created a platform
        // artifact. Stop before running the model so the scheduler cannot
        // enqueue a competing failure reply for an outcome it cannot prove.
        await settleFailedSessionRun(task.sessionId, options.sessionRegistry);
        throw channelDeliveryOutcomeUnknown(error);
      }
      console.error(
        "[spark-daemon] channel reply stream was confirmed not sent; using durable fallback",
        error,
      );
    }

    const inlineStream = Boolean(stream && stream.answerMode !== "separate");
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
        if (inlineStream) {
          try {
            // An inline card and an ordinary failure message are competing
            // user-visible terminals. Await the same-card update and record
            // single ownership through the error code consumed by the
            // scheduler completion transaction.
            await stream.fail(
              context.signal.aborted ? CHANNEL_CANCELLED_REPLY_TEXT : CHANNEL_FAILURE_REPLY_TEXT,
            );
            if (inlineDelivery && options.channelReplyDelivery) {
              acknowledgeChannelReplyDelivery(
                options.channelReplyDelivery,
                inlineDelivery.deliveryId,
              );
            }
            throw new ChannelReplyTerminalPresentedError(error);
          } catch (streamError) {
            if (streamError instanceof ChannelReplyTerminalPresentedError) throw streamError;
            console.error(
              "[spark-daemon] inline channel reply stream failure update failed",
              streamError,
            );
            if (inlineDelivery && options.channelReplyDelivery) {
              deferFailedInlineDelivery(
                options.channelReplyDelivery,
                inlineDelivery.deliveryId,
                streamError,
              );
              throw new ChannelReplyTerminalPresentedError(error);
            }
            if (channelDeliveryFailureOutcome(streamError) !== "not_sent") {
              throw channelDeliveryOutcomeUnknown(streamError);
            }
          }
        } else if (!context.signal.aborted) {
          // A separate progress card is not the terminal answer. Its cleanup is
          // advisory while the durable scheduler outbox owns the failure reply.
          void stream.fail(CHANNEL_FAILURE_REPLY_TEXT).catch((streamError) => {
            console.error("[spark-daemon] channel reply stream failure update failed", streamError);
          });
        }
      }
      throw error;
    }

    const hasInlineProjection = Boolean(inlineStream && projector);
    const text = assistantTextFromResult(result) ?? projector?.finalAnswerText();
    if (!text) {
      const error = new ChannelReplyContentError(context.invocationId);
      if (stream) {
        try {
          await stream.fail("未生成可发送的回复，请稍后重试");
          if (inlineDelivery && options.channelReplyDelivery) {
            acknowledgeChannelReplyDelivery(
              options.channelReplyDelivery,
              inlineDelivery.deliveryId,
            );
          }
        } catch (streamError) {
          console.error("[spark-daemon] empty channel reply failure update failed", streamError);
          if (inlineStream) {
            if (inlineDelivery && options.channelReplyDelivery) {
              deferFailedInlineDelivery(
                options.channelReplyDelivery,
                inlineDelivery.deliveryId,
                streamError,
              );
              throw new ChannelReplyTerminalPresentedError(error);
            }
            if (channelDeliveryFailureOutcome(streamError) === "not_sent") throw error;
            throw channelDeliveryOutcomeUnknown(streamError);
          }
        }
        if (hasInlineProjection) throw new ChannelReplyTerminalPresentedError(error);
      }
      throw error;
    }

    // Preserve a streamed final answer in the executor result so the
    // scheduler can commit the exact immutable delivery intent even when the
    // headless host omitted assistantText from its terminal result.
    const resultWithText = resultWithAssistantText(result, text);
    // The inline recovery row was written at card creation, before model work.
    // Replace its restart fallback with the exact immutable answer before the
    // final platform update.
    if (inlineDelivery && options.channelReplyDelivery) {
      try {
        inlineDelivery = options.channelReplyDelivery.updateText(inlineDelivery.deliveryId, text);
      } catch (error) {
        // The stream may already have produced a card or partial content. A
        // local durability failure cannot prove that no platform side effect
        // happened, so prevent the scheduler from creating a fresh message.
        throw channelDeliveryOutcomeUnknown(error);
      }
    }
    if (stream && projector) {
      projector.appendFinalText(text);
      if (hasInlineProjection) {
        // Await inline completion so a recoverable successful card can be
        // acknowledged without also enqueuing an ordinary message.
        let streamCompleted = false;
        let streamCompletionError: unknown;
        try {
          await stream.complete("已完成");
          streamCompleted = true;
        } catch (error) {
          streamCompletionError = error;
          console.error(
            "[spark-daemon] inline channel reply stream completion failed; durable answer remains queued",
            error,
          );
        }
        // A completed inline stream is already the user-visible final answer;
        // never enqueue a second ordinary message. When a recovery row exists,
        // acknowledge it only after the platform completion succeeds.
        if (streamCompleted) {
          const deliveryAcknowledged =
            !inlineDelivery ||
            !options.channelReplyDelivery ||
            acknowledgeChannelReplyDelivery(
              options.channelReplyDelivery,
              inlineDelivery.deliveryId,
            );
          if (resultWithText && typeof resultWithText === "object") {
            return {
              ...(resultWithText as Record<string, unknown>),
              ...(deliveryAcknowledged
                ? { channelReplyDelivered: true }
                : { channelReplyDeliveryPending: true }),
            };
          }
          return resultWithText;
        }

        if (inlineDelivery && options.channelReplyDelivery) {
          // The recoverable legacy row remains the sole owner of this inline
          // answer. Mark it retryable and tell the scheduler not to create an
          // ordinary-message intent for the same terminal result.
          deferFailedInlineDelivery(
            options.channelReplyDelivery,
            inlineDelivery.deliveryId,
            streamCompletionError,
          );
          if (resultWithText && typeof resultWithText === "object") {
            return {
              ...(resultWithText as Record<string, unknown>),
              channelReplyDeliveryPending: true,
            };
          }
          return resultWithText;
        }

        if (channelDeliveryFailureOutcome(streamCompletionError) !== "not_sent") {
          // The inline surface may already contain the final answer. Without
          // a same-artifact recovery handle there is no safe ordinary-message
          // fallback, so fail closed and let the completion hook suppress a
          // competing failure delivery.
          throw channelDeliveryOutcomeUnknown(streamCompletionError);
        }
      } else {
        // Separate progress cards must not hold the invocation open on SDK
        // retries; the outbox still delivers the final answer.
        void stream.complete("已完成").catch((error) => {
          console.error(
            "[spark-daemon] channel reply stream completion failed; durable answer remains queued",
            error,
          );
        });
      }
    }
    return resultWithText;
  };
}

function deferFailedInlineDelivery(
  store: Pick<ChannelReplyDeliveryStore, "defer">,
  deliveryId: string,
  error: unknown,
): void {
  try {
    store.defer(deliveryId, error ?? new Error("inline channel reply stream completion failed"));
  } catch (deferError) {
    // The staged row remains durable even if its retry state cannot be updated
    // in this process. Do not turn a valid model answer into a model failure or
    // create a competing ordinary-message delivery.
    console.error("[spark-daemon] failed to defer inline channel reply delivery", deferError);
  }
}

function acknowledgeChannelReplyDelivery(
  store: Pick<ChannelReplyDeliveryStore, "acknowledge" | "defer">,
  deliveryId: string,
): boolean {
  try {
    store.acknowledge(deliveryId);
    return true;
  } catch (error) {
    // The platform side effect has already succeeded. Move the durable row to
    // retryable state without attempting another immediate send. Inline stream
    // retries update the same artifact through the adapter recovery handle.
    try {
      store.defer(deliveryId, error);
    } catch (deferError) {
      console.error("[spark-daemon] channel reply acknowledgement recovery failed", deferError);
    }
    return false;
  }
}

export const CHANNEL_FAILURE_REPLY_TEXT = "处理失败，请稍后重试";
export const CHANNEL_CANCELLED_REPLY_TEXT = "处理已停止";
export const CHANNEL_INTERRUPTED_REPLY_TEXT = "处理因服务重启而中断，请重新发送";
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
  const adapter = channelReply.adapter;
  const externalKey = channelReply.externalKey;
  if (!adapter || !channelReply.adapterId || !externalKey || !channelReply.recipient) {
    throw new Error("channel-origin task has incomplete frozen binding");
  }
  // Inline streams either already presented the answer or own a recoverable
  // retry row. Do not enqueue a competing ordinary-message delivery.
  if (kind === "final" && channelReplyOwnedFromResult(result)) return undefined;
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
    ...(channelReply.adapterAccountIdentity
      ? { adapterAccountIdentity: channelReply.adapterAccountIdentity }
      : {}),
    externalKey,
    target: channelReplyTarget(task),
    text,
  };
}

function channelReplyTarget(task: SparkDaemonSessionRunTask): ChannelReplyTarget {
  const binding = completeChannelBinding(task);
  if (!binding) throw new Error("channel-origin delivery requires a frozen binding");
  return {
    recipient: binding.recipient,
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

function resultWithAssistantText(result: unknown, assistantText: string): unknown {
  if (assistantTextFromResult(result)) return result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), assistantText };
  }
  return { assistantText };
}

function channelReplyOwnedFromResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const value = result as {
    channelReplyDelivered?: unknown;
    channelReplyDeliveryPending?: unknown;
  };
  return value.channelReplyDelivered === true || value.channelReplyDeliveryPending === true;
}

export async function executeSparkDaemonSessionRunTask(
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
  options: SparkDaemonTaskExecutorOptions & { executeSession: SparkHeadlessSessionExecutor },
  driver?: SparkHostDriverContext,
): Promise<unknown> {
  const sessionContext = await sessionContextForTask(
    task,
    options.sessionRegistry,
    options.paths.piAgentDir,
  );
  const systemPrompt = await systemPromptForSession(
    task,
    options,
    sessionContext.surface,
    sessionContext.role,
    sessionContext.sideThread,
  );
  const messageMetadata = sessionRunMessageMetadata(task, context.invocationId);
  const binding = completeChannelBinding(task);
  return await options.executeSession({
    cwd: task.cwd ?? options.cwd ?? process.cwd(),
    sparkHome: options.paths.piAgentDir,
    sessionId: task.executionSessionId ?? task.sessionId,
    ...(!task.hiddenExecution && sessionContext.sessionPath
      ? { sessionPath: sessionContext.sessionPath }
      : {}),
    prompt: sessionRunPrompt(task, options.paths, context.invocationId),
    ...(task.model ? { model: task.model } : {}),
    ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
    reset: task.reset,
    ...(task.hiddenExecution
      ? {
          sessionVisibility: "internal" as const,
          sessionPurpose: "driver_tick" as const,
        }
      : {}),
    ...(task.resumeFromInterrupt ? { resumeFromInterrupt: true } : {}),
    signal: context.signal,
    // The daemon scheduler is the single execution-time budget owner. It can
    // pause that budget while awaiting a human response; adding the headless
    // wall-clock timer here would incorrectly time out the same turn while its
    // scheduler budget is paused.
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(messageMetadata ? { messageMetadata } : {}),
    ...(sessionContext.surface ? { sessionSurface: sessionContext.surface } : {}),
    sessionSource: sessionSourceForTask(task),
    ...(binding
      ? {
          channelBinding: binding,
        }
      : {}),
    invocationId: context.invocationId,
    ...(task.stateOwnerSessionId ? { stateOwnerSessionId: task.stateOwnerSessionId } : {}),
    ...(driver ? { driver } : {}),
    ...(sessionQuestionChainForTask(task)
      ? { sessionQuestionChain: sessionQuestionChainForTask(task) }
      : {}),
    ...(sessionContext.surface === "channel"
      ? {
          allowedTools: SPARK_CHANNEL_ALLOWED_TOOLS,
          approvalMethod: "auto" as const,
        }
      : {}),
    ...(sessionContext.sideThread ? { allowedToolEffects: ["read"] as const } : {}),
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

function completeChannelBinding(task: SparkDaemonSessionRunTask) {
  const reply = task.channelReply;
  if (!reply) return undefined;
  if (
    !reply.adapter ||
    !reply.externalKey ||
    !reply.adapterId ||
    !reply.workspaceId ||
    !reply.recipient
  ) {
    throw new Error("channel-origin task has incomplete frozen binding");
  }
  if (task.channelContext && task.channelContext.externalKey !== reply.externalKey) {
    throw new Error("channel-origin task externalKey does not match frozen binding");
  }
  return {
    workspaceId: reply.workspaceId,
    adapter: reply.adapter,
    externalKey: reply.externalKey,
    recipient: reply.recipient,
    adapterId: reply.adapterId,
    ...(reply.adapterAccountIdentity
      ? { adapterAccountIdentity: reply.adapterAccountIdentity }
      : {}),
  };
}

function sessionRunPrompt(
  task: SparkDaemonSessionRunTask,
  paths: SparkPaths,
  invocationId: string,
): Parameters<SparkHeadlessSessionExecutor>[0]["prompt"] {
  const browserImages = (task.attachments ?? []).filter(
    (attachment) => attachment.kind === "image",
  );
  const channelImages = task.channelContext?.images ?? [];
  const files = (task.attachments ?? []).filter((attachment) => attachment.kind === "file");
  const filePrompt = materializeTurnFiles(files, paths, invocationId);
  const text = filePrompt ? `${task.prompt}\n\n${filePrompt}` : task.prompt;
  if (browserImages.length === 0 && channelImages.length === 0) return text;
  return [
    { type: "text", text },
    ...browserImages.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mediaType,
    })),
    ...channelImages.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mediaType,
    })),
  ];
}

function materializeTurnFiles(
  files: NonNullable<SparkDaemonSessionRunTask["attachments"]>,
  paths: SparkPaths,
  invocationId: string,
): string {
  if (files.length === 0) return "";
  const attachmentDir = join(paths.dataDir, "turn-attachments", safePathSegment(invocationId));
  mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
  const entries = files.map((file, index) => {
    const safeName = safeAttachmentName(file.name);
    const fileName = `${index + 1}-${safeName}`;
    const filePath = join(attachmentDir, fileName);
    writeFileSync(filePath, Buffer.from(file.data, "base64"), { mode: 0o600 });
    return `- ${safeName} (${file.mediaType}, ${file.size} bytes): ${filePath}`;
  });
  return [
    "The user attached local files for this turn. Read them from these daemon-owned paths when needed:",
    ...entries,
  ].join("\n");
}

function safeAttachmentName(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .replace(/[\p{Cc}/\\:]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 180);
  return normalized || "attachment";
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160) || "turn";
}

function sessionRunMessageMetadata(
  task: SparkDaemonSessionRunTask,
  invocationId: string,
): Record<string, unknown> {
  const source = sessionSourceForTask(task);
  const baseMetadata = {
    origin: {
      kind: "user",
      host: source,
      surface: source === "channel" ? "channel" : "local",
    },
  };
  const binding = task.channelReply ? completeChannelBinding(task) : undefined;
  const channel = binding ? task.channelContext : undefined;
  const channelMetadata = channel
    ? {
        origin: {
          kind: "user",
          host: "channel",
          surface: "channel",
          adapter: binding!.adapter,
          externalKey: binding!.externalKey,
          ...(channel.senderId ? { senderId: channel.senderId } : {}),
          ...(channel.senderName ? { senderName: channel.senderName } : {}),
        },
        channel: {
          adapter: binding!.adapter,
          externalKey: binding!.externalKey,
          ...(channel.senderId ? { senderId: channel.senderId } : {}),
          ...(channel.senderName ? { senderName: channel.senderName } : {}),
          ...(channel.chatId ? { chatId: channel.chatId } : {}),
          ...(channel.messageId ? { messageId: channel.messageId } : {}),
          ...(channel.messageReference ? { messageReference: channel.messageReference } : {}),
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
    // The headless loop emits a temporary live message ID before the native
    // transcript assigns its durable entry ID. Persist the invocation
    // correlation so projections can reconcile those two identities without
    // collapsing legitimate repeated prompts by text.
    invocationId,
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

export function sessionSourceForTask(
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

async function sessionContextForTask(
  task: SparkDaemonSessionRunTask,
  registry: SparkDaemonTaskExecutorOptions["sessionRegistry"],
  sparkHome: string | undefined,
): Promise<{
  surface?: "local" | "channel";
  role?: string;
  sideThread?: boolean;
  sessionPath?: string;
}> {
  const session = await registry?.get?.(task.sessionId);
  const role = session?.role?.trim();
  const sessionPath =
    !task.hiddenExecution && session && sparkHome && registry?.bindTranscriptPath
      ? await ensureDaemonSessionTranscript({
          session,
          sparkHome,
          registry: { bindTranscriptPath: registry.bindTranscriptPath },
        })
      : session?.sessionPath;
  if (task.channelReply) {
    return {
      surface: "channel",
      ...(role ? { role } : {}),
      ...(sessionPath ? { sessionPath } : {}),
    };
  }
  if (!session) return {};
  return {
    surface: session.bindings.length > 0 ? "channel" : "local",
    ...(role ? { role } : {}),
    ...(session.relation?.kind === "side_thread" ? { sideThread: true } : {}),
    ...(sessionPath ? { sessionPath } : {}),
  };
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
  const externalKey = reply.externalKey;
  if (task.channelContext && task.channelContext.externalKey !== externalKey) {
    throw new Error("channel-origin task externalKey does not match frozen binding");
  }
  const scope =
    externalKey?.startsWith("infoflow:group:") ||
    externalKey?.startsWith("qqbot:group:") ||
    externalKey?.startsWith("qqbot:channel:") ||
    reply.recipient.startsWith("group:") ||
    reply.recipient.startsWith("channel:")
      ? "group"
      : "user";

  if (reply.adapter === "infoflow") {
    const infoflow = await loadInfoflowAdapterConfig(options, reply.workspaceId);
    return composeAgentSystemPrompt([
      DEFAULT_SPARK_IDENTITY_PROMPT,
      renderInfoflowInternalSystemPrompt({
        ...(infoflow ? { config: infoflow } : {}),
        scope,
        externalKey,
      }),
      infoflow ? resolveInfoflowCustomSystemPrompt(infoflow) : undefined,
      SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
      task.channelContext ? renderInfoflowMessageContextPrompt(task.channelContext) : undefined,
    ]);
  }

  if (reply.adapter === "qqbot") {
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
      adapter: reply.adapter ?? failIncompleteChannelBinding(),
      scope,
    }),
    SPARK_CHANNEL_SESSION_EXECUTION_PROMPT,
  ]);
}

function failIncompleteChannelBinding(): never {
  throw new Error("channel-origin task has incomplete frozen binding");
}

async function systemPromptForSession(
  task: SparkDaemonSessionRunTask,
  options: SparkDaemonTaskExecutorOptions,
  sessionSurface: "local" | "channel" | undefined,
  role: string | undefined,
  sideThread = false,
): Promise<string | undefined> {
  const channelPrompt = await systemPromptForChannelSession(task, options, sessionSurface);
  const rolePrompt = role ? renderPersistentSessionRolePrompt(role) : undefined;
  const sideThreadPrompt = sideThread ? SPARK_SIDE_THREAD_EXECUTION_PROMPT : undefined;
  if (channelPrompt) return composeAgentSystemPrompt([channelPrompt, rolePrompt, sideThreadPrompt]);
  if (rolePrompt || sideThreadPrompt) {
    return composeAgentSystemPrompt([DEFAULT_SPARK_IDENTITY_PROMPT, rolePrompt, sideThreadPrompt]);
  }
  return undefined;
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
      if (task.hiddenExecution && view.type === "session.snapshot") return undefined;
      const correlatedView =
        view.type === "session.message" && view.message.role === "user"
          ? {
              ...view,
              message: {
                ...view.message,
                metadata: { ...view.message.metadata, invocationId },
              },
            }
          : view;
      const projectedView = task.hiddenExecution
        ? projectHiddenDriverView(correlatedView, task.sessionId)
        : correlatedView;
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
        view: projectedView,
      };
    } catch {
      return undefined;
    }
  }
  if (raw.type === "daemon_event") {
    try {
      const event = parseSparkDaemonEvent(raw.event);
      if (
        task.hiddenExecution &&
        event.type === "daemon.view_event" &&
        event.view.type === "session.snapshot"
      ) {
        return undefined;
      }
      const projectedEvent =
        task.hiddenExecution && event.type === "daemon.view_event"
          ? {
              ...event,
              view: projectHiddenDriverView(event.view, task.sessionId),
            }
          : event;
      return {
        ...projectedEvent,
        emittedAt: projectedEvent.emittedAt ?? new Date().toISOString(),
        ...(task.workspaceId && !projectedEvent.workspaceId
          ? { workspaceId: task.workspaceId }
          : {}),
        ...(task.projectId && !projectedEvent.projectId ? { projectId: task.projectId } : {}),
        sessionId: task.hiddenExecution
          ? task.sessionId
          : (projectedEvent.sessionId ?? task.sessionId),
        invocationId: projectedEvent.invocationId ?? invocationId,
        metadata: {
          ...daemonTaskRouteMetadata(task),
          ...projectedEvent.metadata,
        },
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function projectHiddenDriverView(
  view: ReturnType<typeof parseSparkViewModelEvent>,
  ownerSessionId: string,
): ReturnType<typeof parseSparkViewModelEvent> {
  if (view.type === "session.message") {
    return {
      ...view,
      sessionId: ownerSessionId,
      message: {
        ...view.message,
        metadata: {
          ...view.message.metadata,
          driverExecution: true,
          stateOwnerSessionId: ownerSessionId,
        },
      },
    };
  }
  if (view.type === "run.update") {
    return { ...view, sessionId: ownerSessionId };
  }
  if (view.type === "driver.update") {
    return { ...view, sessionId: ownerSessionId };
  }
  return view;
}

async function recordCompletedSessionRun(
  task: SparkDaemonSessionRunTask,
  result: unknown,
  registry: Pick<DaemonSessionRegistry, "recordRun" | "recordTurnSettled"> | undefined,
): Promise<{ result: unknown; indexed: boolean }> {
  if (!registry) return { result, indexed: false };
  if (task.hiddenExecution) {
    await registry.recordTurnSettled(task.sessionId);
    return { result, indexed: false };
  }
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

async function assignRoleAfterCompletedSessionRun(
  task: SparkDaemonSessionRunTask,
  context: SparkDaemonTaskExecutionContext,
  options: SparkDaemonTaskExecutorOptions,
): Promise<void> {
  const generateSessionRole = options.modelControl?.generateSessionRole;
  const get = options.sessionRegistry?.get;
  const setRoleIfMissing = options.sessionRegistry?.setRoleIfMissing;
  if (!task.model || !generateSessionRole || !get || !setRoleIfMissing) return;
  try {
    const current = await get(task.sessionId);
    if (current?.relation?.kind === "side_thread") return;
    const session = await assignCompletedSessionRole(
      {
        sessionId: task.sessionId,
        prompt: task.prompt,
        model: modelRefFromValue(task.model),
        // The user turn has already committed, so its scheduler signal may be
        // closed immediately. Give this independent projection a small local
        // budget; registry CAS still protects channel/archive ownership races.
        signal: AbortSignal.timeout(5_000),
      },
      {
        modelControl: {
          generateSessionRole: (input) => options.modelControl!.generateSessionRole!(input),
        },
        sessionRegistry: {
          get: (sessionId) => options.sessionRegistry!.get!(sessionId),
          setRoleIfMissing: (sessionId, role) =>
            options.sessionRegistry!.setRoleIfMissing!(sessionId, role),
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
    // Keep role naming fully advisory even if a future dependency implementation
    // violates the helper's best-effort contract.
    console.error(`[spark-daemon] unexpected session role failure for ${task.sessionId}`);
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
