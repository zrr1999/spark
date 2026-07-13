import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import {
  createId,
  humanResponseDeliverEnvelopeSchema,
  normalizeServerCommandForExecution,
  runtimeProtocolVersion,
  runtimeReconcileRequestEnvelopeSchema,
  serverCommandEnvelopeSchema,
  serverHelloAckEnvelopeSchema,
  type SparkDaemonEvent,
  type SparkCommand,
  type RuntimeFeature,
  type RuntimeWorkspaceBindingSummary,
} from "@zendev-lab/spark-protocol";
import { writePrivateFile, type SparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig, type SparkDaemonConfig } from "./config.js";
import {
  createDaemonChannelIngressRuntime,
  type DaemonChannelIngressRuntime,
} from "./channels/ingress.ts";
import {
  createSparkDaemonWorkerContext,
  runSparkDaemonWorkerIteration,
  SparkDaemonInvocationRegistry,
  SparkDaemonQueue,
  SparkDaemonWorkerLoop,
  waitForSparkDaemonActiveTasks,
  type SparkDaemonEventSink,
  type SparkDaemonTaskExecutor,
} from "./core/index.ts";
import {
  SparkDaemonHumanWaitRegistry,
  type SparkDaemonHumanWaitInput,
  type SparkDaemonHumanWaitRegistration,
} from "./core/human-waits.ts";
import { sparkCommandFromServerCommandEnvelope } from "./command-dispatcher.ts";
import { decideCommandPolicy } from "./policy.js";
import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import {
  commandAck,
  commandReject,
  daemonEvent,
  invocationLogChunk,
  invocationUpdated,
  reconcileReport,
  runtimeEnvelope,
  workspaceSnapshot,
  type RouteContext,
} from "./protocol/outbound.js";
import {
  getWorkspaceById,
  isBorrowedWorkspace,
  isUserDetachedWorkspace,
  listWorkspaces,
  markSparkDaemonServerConnected,
  markSparkDaemonServerDisconnected,
  reconcileWorkspaces,
  resolveWorkspaceLocalPath,
  workspaceSummaries,
} from "./store/workspaces.js";
import {
  commandRejectForUnknownInvocation,
  runSparkCommandBridge,
  cancelSparkBridgeInvocation,
  type RunSparkCommandFn,
  type CancelSparkInvocationFn,
} from "./spark/bridge.js";
import { createChannelAwareQueueTaskExecutor } from "./spark/session-run.js";
import {
  nextSparkDaemonTokenRefreshDelayMs,
  refreshSparkDaemonCredentials,
  shouldRefreshSparkDaemonToken,
  tokenRefreshRetryDelayMs,
} from "./token-refresh.js";

export const sparkDaemonVersion = "0.1.0";

export const sparkDaemonSupportedFeatures: RuntimeFeature[] = [
  "ws-control-v1",
  "multi-workspace-runtime-v1",
  "workspace-snapshot-v1",
  "command-routing-v1",
  "human-request-v1",
  "logs-v1",
  "artifact-ref-v1",
  "artifact-cache-upload-v1",
  "cancellation-v1",
  "reconcile-v1",
];

/**
 * Minimal WebSocket-like surface used by command handlers. Production wires the
 * real `ws` library; tests pass a tiny stub that just records `send` calls.
 */
export interface ServerSocket {
  send(data: string): void;
}

export interface StartSparkDaemonOptions {
  paths: SparkPaths;
  /** Global Spark provider/auth control root (normally ~/.spark). */
  sparkHome?: string;
  modelControl?: SparkDaemonModelControl;
  sessionRegistry?: DaemonSessionRegistry;
  config: SparkDaemonConfig;
  db: DatabaseSync;
  once?: boolean;
  signal?: AbortSignal;
  drainTimeoutMs?: number;
  /**
   * Optional override for Spark-backed command execution. Production callers can
   * leave this unset to use the real Spark runtime bridge; tests inject a fake
   * to assert the streamed envelope sequence without spawning a real role-run.
   */
  runSparkCommand?: RunSparkCommandFn;
  cancelSparkInvocation?: CancelSparkInvocationFn;
  queue?: SparkDaemonQueue;
  executeQueueTask?: SparkDaemonTaskExecutor;
  runQueue?: boolean;
  queuePollIntervalMs?: number;
  queueConcurrency?: number;
  queueTaskTimeoutMs?: number;
  /** Retry delay for the optional Cockpit projection connection. */
  serverReconnectDelayMs?: number;
  invocationRegistry?: SparkDaemonInvocationRegistry;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  localEventSink?: SparkDaemonEventSink;
  channelIngress?: DaemonChannelIngressRuntime;
}

export async function startSparkDaemon(options: StartSparkDaemonOptions): Promise<void> {
  writePrivateFile(options.paths.pidFile, `${process.pid}\n`);
  // Local execution truth is established independently of the optional
  // Cockpit projection. This also repairs status left by older daemons that
  // conflated a server disconnect with an unavailable workspace.
  reconcileWorkspaces(options.db);
  const invocationRegistry = options.invocationRegistry ?? new SparkDaemonInvocationRegistry();
  const humanWaits = options.humanWaits ?? new SparkDaemonHumanWaitRegistry(options.db);
  let emitQueueEventToServer: SparkDaemonEventSink | null = null;
  const setQueueEventTarget = (sink?: SparkDaemonEventSink) => {
    emitQueueEventToServer = sink ?? null;
  };
  const emitQueueEvent: SparkDaemonEventSink = async (event) => {
    await options.localEventSink?.(event);
    await emitQueueEventToServer?.(event);
  };
  const queueContext =
    options.runQueue === false
      ? null
      : createSparkDaemonWorkerContext({
          queue: options.queue ?? new SparkDaemonQueue({ paths: options.paths }),
          active: { files: new Set(), sessions: new Set(), invocations: invocationRegistry },
          executeTask:
            options.executeQueueTask ??
            createChannelAwareQueueTaskExecutor({
              paths: options.paths,
              cwd: process.cwd(),
              controlSparkHome:
                (options.sparkHome ?? process.env.SPARK_HOME?.trim()) || join(homedir(), ".spark"),
              channelsSparkHome:
                (options.sparkHome ?? process.env.SPARK_HOME?.trim()) || join(homedir(), ".spark"),
              ...(options.modelControl ? { modelControl: options.modelControl } : {}),
              ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
              channelIngress: options.channelIngress,
            }),
          emitEvent: emitQueueEvent,
          taskTimeoutMs: options.queueTaskTimeoutMs,
        });
  const queueLoop = queueContext
    ? new SparkDaemonWorkerLoop({
        context: queueContext,
        label: "spark-daemon",
        pollIntervalMs: options.queuePollIntervalMs,
        concurrency: options.queueConcurrency,
        taskTimeoutMs: options.queueTaskTimeoutMs,
      })
    : null;
  const stopQueueLoop = () => {
    void queueLoop?.stop().catch((error: unknown) => {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    });
  };
  if (queueLoop && !options.once) {
    await queueLoop.start();
  }
  options.signal?.addEventListener("abort", stopQueueLoop, { once: true });

  const channelIngress = await maybeStartChannelIngress(options);
  const stopChannelIngress = () => {
    void channelIngress?.stop().catch((error: unknown) => {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    });
  };
  options.signal?.addEventListener("abort", stopChannelIngress, { once: true });

  try {
    if (options.once) {
      if (queueContext) {
        await runSparkDaemonWorkerIteration({
          context: queueContext,
          label: "spark-daemon",
          concurrency: options.queueConcurrency,
        });
        await waitForSparkDaemonActiveTasks(queueContext.active);
      }
      if (!options.signal?.aborted && canAttemptServerConnection(options.config)) {
        await runSparkDaemonServerConnection({
          ...options,
          invocationRegistry,
          humanWaits,
          setQueueEventTarget,
        });
      }
      return;
    }

    while (!options.signal?.aborted) {
      const config = readSparkDaemonConfig(options.paths);
      if (!canAttemptServerConnection(config)) {
        await delayUnlessAborted(500, options.signal);
        continue;
      }

      try {
        await runSparkDaemonServerConnection({
          ...options,
          config,
          invocationRegistry,
          humanWaits,
          setQueueEventTarget,
        });
      } catch {
        // Cockpit is an optional projection surface. Connection failures are
        // represented by daemon_servers.last_disconnect_reason and must not
        // become permanent business-outbox entries or stop local execution.
        await delayUnlessAborted(options.serverReconnectDelayMs ?? 1_000, options.signal);
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", stopQueueLoop);
    options.signal?.removeEventListener("abort", stopChannelIngress);
    try {
      await channelIngress?.stop();
    } catch (error) {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    }
    await queueLoop?.stop();
    if (queueContext) {
      await waitForSparkDaemonActiveTasks(queueContext.active);
    }
    if (existsSync(options.paths.pidFile)) {
      rmSync(options.paths.pidFile, { force: true });
    }
  }
}

async function maybeStartChannelIngress(
  options: StartSparkDaemonOptions,
): Promise<DaemonChannelIngressRuntime | null> {
  if (options.once || options.runQueue === false) return null;
  const sparkHome = process.env.SPARK_HOME?.trim() || join(homedir(), ".spark");
  const queue = options.queue ?? new SparkDaemonQueue({ paths: options.paths });
  const runtime =
    options.channelIngress ??
    createDaemonChannelIngressRuntime({
      sparkHome,
      ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
      hooks: {
        onAssignment: async (assignment) => {
          const model = options.modelControl
            ? await options.modelControl.effectiveModel(assignment.sessionId)
            : undefined;
          if (model) await options.modelControl?.prepareModel(model);
          const session = await options.sessionRegistry?.get(assignment.sessionId);
          if (session && session.scope.kind !== "workspace") {
            throw new Error(`channel session ${assignment.sessionId} has no workspace owner`);
          }
          const workspaceId =
            session?.scope.kind === "workspace"
              ? session.scope.workspaceId
              : assignment.channelReply.workspaceId;
          const cwd = session?.cwd?.trim() ?? resolveWorkspaceLocalPath(options.db, workspaceId);
          if (!cwd) {
            throw new Error(
              `channel session ${assignment.sessionId} has no daemon-local execution directory`,
            );
          }
          await queue.enqueue({
            type: "session.run",
            sessionId: assignment.sessionId,
            prompt: assignment.goal,
            ...(model ? { model: `${model.providerName}/${model.modelId}` } : {}),
            assignment: assignment.assignment,
            workspaceId,
            cwd,
            channelReply: assignment.channelReply,
            ...(assignment.channelContext ? { channelContext: assignment.channelContext } : {}),
          });
        },
      },
    });
  try {
    await runtime.start();
  } catch (error) {
    logDaemonError(options.config.runtimeId ?? "unknown", error);
  }
  // Keep the runtime reachable through local RPC even when startup config is
  // absent or invalid so an operator can repair it without restarting daemon.
  return runtime;
}

interface SparkDaemonServerConnectionOptions extends StartSparkDaemonOptions {
  invocationRegistry: SparkDaemonInvocationRegistry;
  humanWaits: SparkDaemonHumanWaitRegistry;
  setQueueEventTarget?: (sink?: SparkDaemonEventSink) => void;
}

async function runSparkDaemonServerConnection(
  options: SparkDaemonServerConnectionOptions,
): Promise<void> {
  let config = shouldRefreshSparkDaemonToken(options.config)
    ? await refreshSparkDaemonCredentials({ paths: options.paths, config: options.config })
    : options.config;
  const runtimeId = requireConfig(config.runtimeId, "runtimeId");
  const runtimeToken = requireConfig(config.runtimeToken, "runtimeToken");
  const webSocketUrl = resolveWebSocketUrl(config);
  const serverUrl = serverUrlForConfig(config);

  await new Promise<void>((resolvePromise, reject) => {
    let runtimeSessionId: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let tokenRefresh: NodeJS.Timeout | undefined;
    let intentionalClose = false;
    let settled = false;
    let queueEventTargetAttached = false;
    const activeHandlers = new Set<Promise<void>>();
    const scheduleTokenRefresh = (delayMs = nextSparkDaemonTokenRefreshDelayMs(config)) => {
      if (delayMs === undefined) {
        return;
      }
      tokenRefresh = setTimeout(() => {
        void refreshAndRescheduleToken();
      }, delayMs);
    };
    const refreshAndRescheduleToken = async () => {
      try {
        config = await refreshSparkDaemonCredentials({ paths: options.paths, config });
        scheduleTokenRefresh();
      } catch (error) {
        logDaemonError(runtimeId, error);
        scheduleTokenRefresh(tokenRefreshRetryDelayMs());
      }
    };
    scheduleTokenRefresh();

    const detachQueueEventTarget = () => {
      if (!queueEventTargetAttached) {
        return;
      }
      queueEventTargetAttached = false;
      options.setQueueEventTarget?.(undefined);
    };

    const settle = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      detachQueueEventTarget();
      options.signal?.removeEventListener("abort", requestShutdown);
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    };

    const markDisconnected = (reason: string) => {
      if (serverUrl) {
        markSparkDaemonServerDisconnected(options.db, serverUrl, reason);
      }
    };

    const drainActiveHandlers = async () => {
      if (activeHandlers.size === 0) {
        return;
      }
      await Promise.race([
        Promise.allSettled([...activeHandlers]),
        delay(options.drainTimeoutMs ?? 30_000),
      ]);
    };

    const requestShutdown = () => {
      intentionalClose = true;
      clearRuntimeTimers();
      void drainActiveHandlers()
        .catch((error: unknown) => {
          logDaemonError(runtimeId, error);
        })
        .finally(() => {
          ws.close(1000, "daemon stop");
          if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            settle();
          }
        });
    };

    const ws = new WebSocket(webSocketUrl, {
      headers: { Authorization: `Bearer ${runtimeToken}` },
    });
    if (options.signal?.aborted) {
      requestShutdown();
      return;
    }
    options.signal?.addEventListener("abort", requestShutdown, { once: true });

    const clearRuntimeTimers = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      if (tokenRefresh) {
        clearTimeout(tokenRefresh);
        tokenRefresh = undefined;
      }
    };

    ws.on("open", () => {
      if (serverUrl) {
        markSparkDaemonServerConnected(options.db, serverUrl);
      }
      queueEventTargetAttached = true;
      options.setQueueEventTarget?.((event) => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const route = routeForDaemonEvent(event, {
          db: options.db,
          runtimeId,
          serverUrl,
        });
        if (!route) {
          console.error(
            `[spark-daemon] dropping unroutable daemon event ${event.type}; no workspace route was available`,
          );
          return;
        }
        sendJson(ws, daemonEvent(event, route));
      });
      sendJson(ws, {
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "runtime.hello",
        sentAt: new Date().toISOString(),
        payload: {
          runtimeId,
          runtimeVersion: sparkDaemonVersion,
          supportedFeatures: sparkDaemonSupportedFeatures,
          workspaceBindings: reconcileWorkspaces(options.db).map(workspaceSummary),
        },
      });
    });

    ws.on("message", (data: RawData) => {
      if (intentionalClose) {
        return;
      }
      const handler = handleServerMessage(ws, rawDataToText(data), {
        paths: options.paths,
        config,
        db: options.db,
        runtimeId,
        runSparkCommand: options.runSparkCommand ?? runSparkCommandBridge,
        cancelSparkInvocation: options.cancelSparkInvocation ?? cancelSparkBridgeInvocation,
        ...(options.sparkHome ? { sparkHome: options.sparkHome } : {}),
        ...(options.modelControl ? { modelControl: options.modelControl } : {}),
        invocationRegistry: options.invocationRegistry,
        humanWaits: options.humanWaits,
        get runtimeSessionId() {
          return runtimeSessionId;
        },
        setRuntimeSessionId(value) {
          runtimeSessionId = value;
        },
        ensureHeartbeat(intervalMs) {
          if (heartbeat) {
            return;
          }
          heartbeat = setInterval(() => {
            sendHeartbeat(ws, options.db, runtimeId, runtimeSessionId);
          }, intervalMs);
          sendHeartbeat(ws, options.db, runtimeId, runtimeSessionId);
        },
      }).catch((error: unknown) => {
        logDaemonError(runtimeId, error);
      });
      activeHandlers.add(handler);
      void handler.finally(() => {
        activeHandlers.delete(handler);
      });
    });

    ws.on("error", (error) => {
      if (settled) {
        return;
      }
      clearRuntimeTimers();
      if (!intentionalClose) {
        markDisconnected("server.unreachable");
      }
      ws.terminate();
      settle(intentionalClose ? undefined : error);
    });

    ws.on("close", () => {
      if (settled) {
        return;
      }
      clearRuntimeTimers();
      if (!intentionalClose) {
        markDisconnected("server.unreachable");
      }
      settle();
    });
  });
}

async function delayUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  try {
    await delay(ms, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function canAttemptServerConnection(config: SparkDaemonConfig): boolean {
  return Boolean(
    config.runtimeId &&
    (config.runtimeToken || config.refreshToken) &&
    (config.webSocketUrl || config.serverUrl),
  );
}

export interface MessageContext {
  paths: SparkPaths;
  config: SparkDaemonConfig;
  db: DatabaseSync;
  runtimeId: string;
  sparkHome?: string;
  runtimeSessionId: string | undefined;
  setRuntimeSessionId(value: string): void;
  ensureHeartbeat(intervalMs: number): void;
  runSparkCommand: RunSparkCommandFn;
  cancelSparkInvocation: CancelSparkInvocationFn;
  invocationRegistry?: SparkDaemonInvocationRegistry;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  modelControl?: SparkDaemonModelControl;
}

export function createDaemonHumanWait(
  ws: ServerSocket,
  context: MessageContext,
  input: SparkDaemonHumanWaitInput,
): SparkDaemonHumanWaitRegistration {
  if (!context.humanWaits) {
    throw new Error("Spark daemon human wait registry is not attached.");
  }
  const registration = context.humanWaits.register(input);
  sendJson(
    ws,
    runtimeEnvelope(
      "human.request.created",
      {
        kind: registration.wait.kind,
        toolCallId: registration.wait.toolCallId || undefined,
        title: registration.wait.title,
        prompt: registration.wait.prompt,
        questions: registration.wait.questions,
        context: registration.wait.context,
        contextArtifactRefs: registration.wait.contextArtifactRefs,
      },
      {
        runtimeId: context.runtimeId,
        workspaceBindingId: registration.wait.workspaceBindingId || undefined,
        workspaceId: registration.wait.workspaceId || undefined,
        projectId: registration.wait.projectId || undefined,
        humanRequestId: registration.wait.humanRequestId,
        invocationId: registration.wait.invocationId || undefined,
      },
    ),
  );
  return registration;
}

export async function handleServerMessage(
  ws: ServerSocket,
  raw: string,
  context: MessageContext,
): Promise<void> {
  const value = JSON.parse(raw) as unknown;

  const helloAck = serverHelloAckEnvelopeSchema.safeParse(value);
  if (helloAck.success) {
    context.setRuntimeSessionId(helloAck.data.payload.runtimeSessionId);
    context.ensureHeartbeat(helloAck.data.payload.heartbeatIntervalMs);
    return;
  }

  const command = serverCommandEnvelopeSchema.safeParse(value);
  if (command.success) {
    await handleCommand(ws, command.data, context);
    return;
  }

  const humanResponse = humanResponseDeliverEnvelopeSchema.safeParse(value);
  if (humanResponse.success) {
    const delivery = context.humanWaits?.deliver({
      humanRequestId: humanResponse.data.humanRequestId,
      status: humanResponse.data.payload.status,
      answers: humanResponse.data.payload.answers,
      responseArtifactRefs: humanResponse.data.payload.responseArtifactRefs,
    }) ?? {
      returnedToTool: false,
      message: "No daemon-owned human wait registry is attached in this Spark daemon slice.",
    };
    sendJson(
      ws,
      runtimeEnvelope(
        "human.response.ack",
        {
          returnedToTool: delivery.returnedToTool,
          message: delivery.message,
        },
        {
          runtimeId: context.runtimeId,
          workspaceBindingId: humanResponse.data.workspaceBindingId,
          workspaceId: humanResponse.data.workspaceId,
          projectId: humanResponse.data.projectId,
          humanRequestId: humanResponse.data.humanRequestId,
          humanResponseId: humanResponse.data.humanResponseId,
          ackOf: humanResponse.data.messageId,
          invocationId: delivery.wait?.invocationId || humanResponse.data.invocationId,
        },
      ),
    );
    return;
  }

  const reconcileRequest = runtimeReconcileRequestEnvelopeSchema.safeParse(value);
  if (reconcileRequest.success) {
    sendJson(ws, buildReconcileReport(context));
  }
}

export async function handleCommand(
  ws: ServerSocket,
  command: ReturnType<typeof serverCommandEnvelopeSchema.parse>,
  context: MessageContext,
): Promise<void> {
  const knownWorkspaceBindingIds = new Set(
    listWorkspaces(context.db).map((workspace) => workspace.id),
  );
  const commandWorkspace = command.workspaceBindingId
    ? getWorkspaceById(context.db, command.workspaceBindingId)
    : null;
  let sparkCommand = sparkCommandFromServerCommandEnvelope(command);
  let commandForBridge = command;
  const policy = decideCommandPolicy({
    command: sparkCommand,
    workspaceBindingId: command.workspaceBindingId,
    knownWorkspaceBindingIds,
    allowMutation: true,
    workspaceAccess: commandWorkspace
      ? {
          detached: isUserDetachedWorkspace(commandWorkspace),
          borrowed: isBorrowedWorkspace(context.db, commandWorkspace.id),
        }
      : undefined,
  });
  const route: RouteContext = {
    runtimeId: context.runtimeId,
    workspaceBindingId: command.workspaceBindingId,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    commandId: command.commandId,
    ackOf: command.messageId,
  };

  if (!policy.accepted) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: policy.reasonCode ?? "COMMAND_REJECTED",
          message: policy.message ?? "Spark daemon rejected the command.",
          retryable: policy.retryable ?? false,
        },
        route,
      ),
    );
    return;
  }

  if (sparkCommand.kind === "workspace.snapshot.request") {
    sendJson(ws, commandAck({ accepted: true }, route));
    const workspace = command.workspaceBindingId
      ? getWorkspaceById(context.db, command.workspaceBindingId)
      : null;
    if (workspace && command.workspaceId) {
      sendJson(
        ws,
        workspaceSnapshot(
          {
            displayName: workspace.displayName,
            status: workspace.status,
            projects: [],
            unresolvedInboxCount: 0,
            activeInvocationCount: workspace.executor?.activeInvocationCount ?? 0,
            activeAgentCount: workspace.executor?.activeAgentCount ?? 0,
            ...(workspace.borrowed ? { borrowed: workspace.borrowed } : {}),
            workspaceClients: workspace.workspaceClients ?? [],
            ...(workspace.executor ? { executor: workspace.executor } : {}),
            control: {
              mode: workspace.borrowed?.borrowed ? "snapshot_only" : "full",
              ...(workspace.borrowed?.borrowed ? { reason: "borrowed" } : {}),
              serverMutationAllowed: workspace.borrowed?.borrowed !== true,
            },
            latestArtifactIds: [],
            resources: [],
          },
          { ...route, workspaceBindingId: workspace.id },
        ),
      );
    }
    return;
  }

  if (sparkCommand.kind === "diagnostics.request") {
    const invocationId = createId("inv");
    sendJson(ws, commandAck({ accepted: true, invocationId }, { ...route, invocationId }));
    sendJson(
      ws,
      invocationLogChunk(
        {
          runtimeInvocationId: invocationId,
          stream: "system",
          sequence: 1,
          content: JSON.stringify({
            paths: context.paths,
            workspaces: workspaceSummaries(context.db),
          }),
        },
        { ...route, invocationId },
      ),
    );
    sendJson(
      ws,
      invocationUpdated(
        {
          runtimeInvocationId: invocationId,
          status: "succeeded",
          completedAt: new Date().toISOString(),
          payload: { commandKind: sparkCommand.kind },
        },
        { ...route, invocationId },
      ),
    );
    return;
  }

  if (sparkCommand.kind === "invocation.cancel.request") {
    const invocationId = runtimeInvocationIdForCancel(sparkCommand.payload);
    if (!invocationId) {
      sendJson(ws, commandRejectForUnknownInvocation(route, command.messageId));
      return;
    }
    const cancelReason = "Spark daemon invocation cancellation requested by server command.";
    const registryCancelled =
      context.invocationRegistry?.cancel(invocationId, cancelReason) ?? false;
    const result = await context.cancelSparkInvocation({
      invocationId,
      reason: cancelReason,
    });
    if (!result.cancelled && !registryCancelled) {
      sendJson(ws, commandRejectForUnknownInvocation(route, command.messageId));
      return;
    }
    sendJson(ws, commandAck({ accepted: true, invocationId }, { ...route, invocationId }));
    sendJson(
      ws,
      invocationUpdated(
        {
          runtimeInvocationId: invocationId,
          status: "cancelled",
          completedAt: new Date().toISOString(),
          terminalReason: result.cancelled ? result.message : cancelReason,
          payload: { commandKind: sparkCommand.kind },
        },
        { ...route, invocationId },
      ),
    );
    return;
  }

  if (
    sparkCommand.kind !== "task.start.request" &&
    sparkCommand.kind !== "assignment.create.request"
  ) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "COMMAND_KIND_UNIMPLEMENTED",
          message: `Spark daemon does not execute ${sparkCommand.kind} yet.`,
          retryable: false,
        },
        route,
      ),
    );
    return;
  }

  if (sparkCommand.kind === "assignment.create.request") {
    const normalized = normalizeServerCommandForExecution(command);
    if (!normalized.ok) {
      sendJson(
        ws,
        commandReject(
          {
            reasonCode: normalized.reasonCode,
            message: normalized.message,
            retryable: normalized.retryable,
          },
          route,
        ),
      );
      return;
    }

    commandForBridge = normalized.envelope;
    sparkCommand = sparkCommandFromServerCommandEnvelope(commandForBridge);
  }

  const workspace = command.workspaceBindingId
    ? getWorkspaceById(context.db, command.workspaceBindingId)
    : null;
  if (!workspace) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "UNKNOWN_WORKSPACE_BINDING",
          message: "Spark daemon has no local workspace for this command.",
          retryable: false,
        },
        route,
      ),
    );
    return;
  }

  let selectedModel: Awaited<ReturnType<SparkDaemonModelControl["effectiveModel"]>> | undefined;
  if (context.modelControl) {
    try {
      selectedModel = await context.modelControl.effectiveModel(sessionIdForModel(sparkCommand));
      await context.modelControl.prepareModel(selectedModel);
    } catch (error) {
      sendJson(
        ws,
        commandReject(
          {
            reasonCode: "MODEL_UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
          route,
        ),
      );
      return;
    }
  }

  const invocation = context.invocationRegistry?.start({
    invocationId: createId("inv"),
    kind: sparkCommand.kind,
  });
  try {
    await context.runSparkCommand({
      command: commandForBridge,
      workspace,
      route: invocation ? { ...route, invocationId: invocation.invocationId } : route,
      paths: context.paths,
      ...(selectedModel ? { model: `${selectedModel.providerName}/${selectedModel.modelId}` } : {}),
      ...(context.sparkHome ? { controlSparkHome: context.sparkHome } : {}),
      db: context.db,
      ...(invocation ? { invocationId: invocation.invocationId, signal: invocation.signal } : {}),
      emit(message) {
        sendJson(ws, message);
      },
    });
  } finally {
    invocation?.finish();
  }
}

function sessionIdForModel(command: SparkCommand): string | undefined {
  if (command.route.sessionId) return command.route.sessionId;
  const target = recordField(command.payload, "target");
  const sessionId = target?.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
}

function recordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function runtimeInvocationIdForCancel(payload: Record<string, unknown> | undefined): string | null {
  const value = payload?.runtimeInvocationId ?? payload?.invocationId;
  return typeof value === "string" && value.startsWith("inv_") ? value : null;
}

function routeForDaemonEvent(
  event: SparkDaemonEvent,
  context: { db: DatabaseSync; runtimeId: string; serverUrl: string | null },
): RouteContext | null {
  const metadata = event.metadata;
  let workspaceBindingId = stringMetadata(metadata, "workspaceBindingId");
  let workspaceId = event.workspaceId ?? stringMetadata(metadata, "workspaceId");
  if (!workspaceBindingId || !workspaceId) {
    const inferred = inferDaemonEventWorkspaceRoute(context.db, context.serverUrl, {
      workspaceBindingId,
      workspaceId,
    });
    workspaceBindingId ??= inferred?.workspaceBindingId;
    workspaceId ??= inferred?.workspaceId;
  }
  if (!workspaceBindingId || !workspaceId) {
    return null;
  }
  return {
    runtimeId: context.runtimeId,
    workspaceBindingId,
    workspaceId,
    projectId: event.projectId,
    invocationId: event.invocationId,
  };
}

function inferDaemonEventWorkspaceRoute(
  db: DatabaseSync,
  serverUrl: string | null,
  hints: { workspaceBindingId?: string; workspaceId?: string },
): { workspaceBindingId: string; workspaceId: string } | null {
  if (!serverUrl) {
    return null;
  }
  const rows = db
    .prepare(
      `SELECT w.id AS workspaceBindingId,
              dw.server_workspace_id AS workspaceId
       FROM workspaces w
       JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE w.server_url = ?
         AND dw.server_workspace_id IS NOT NULL
         AND (? IS NULL OR w.id = ?)
         AND (? IS NULL OR dw.server_workspace_id = ?)
       ORDER BY w.updated_at DESC
       LIMIT 2`,
    )
    .all(
      serverUrl,
      hints.workspaceBindingId ?? null,
      hints.workspaceBindingId ?? null,
      hints.workspaceId ?? null,
      hints.workspaceId ?? null,
    ) as Array<{ workspaceBindingId: string; workspaceId: string }>;
  return rows.length === 1 ? rows[0]! : null;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function sendHeartbeat(
  ws: WebSocket,
  db: DatabaseSync,
  runtimeId: string,
  runtimeSessionId: string | undefined,
): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  sendJson(ws, {
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "runtime.heartbeat",
    sentAt: new Date().toISOString(),
    payload: {
      runtimeId,
      runtimeSessionId,
      sequence: Date.now(),
      observedAt: new Date().toISOString(),
      workspaceBindings: reconcileWorkspaces(db).map(workspaceSummary),
    },
  });
}

function buildReconcileReport(context: MessageContext) {
  const activeInvocationCount = context.db
    .prepare("SELECT COUNT(*) AS count FROM invocations WHERE status IN ('queued', 'running')")
    .get() as { count: number };
  const pendingOutboxCount = context.db
    .prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'pending'")
    .get() as { count: number };

  return reconcileReport(
    {
      observedAt: new Date().toISOString(),
      workspaceBindings: reconcileWorkspaces(context.db).map(workspaceSummary),
      pendingOutboxCount: pendingOutboxCount.count,
      activeInvocationCount: activeInvocationCount.count,
      activeAgentCount: activeInvocationCount.count,
      artifacts: { availableCount: 0, missingCount: 0 },
      diagnostics: {},
    },
    { runtimeId: context.runtimeId },
  );
}

function workspaceSummary(
  workspace: ReturnType<typeof reconcileWorkspaces>[number],
): RuntimeWorkspaceBindingSummary {
  return {
    bindingId: workspace.id,
    localWorkspaceKey: workspace.localWorkspaceKey,
    displayName: workspace.displayName,
    status: workspace.status,
    capabilities: workspace.capabilities,
    diagnostics: workspace.diagnostics,
    ...(workspace.borrowed ? { borrowed: workspace.borrowed } : {}),
    workspaceClients: workspace.workspaceClients ?? [],
    ...(workspace.executor ? { executor: workspace.executor } : {}),
  };
}

function resolveWebSocketUrl(config: SparkDaemonConfig): string {
  if (config.webSocketUrl) {
    return toWebSocketUrl(config.webSocketUrl);
  }
  const runtimeId = requireConfig(config.runtimeId, "runtimeId");
  const serverUrl = requireConfig(config.serverUrl, "serverUrl");
  return toWebSocketUrl(new URL(`/api/v1/runtime/runtimes/${runtimeId}/ws`, serverUrl).toString());
}

function serverUrlForConfig(config: SparkDaemonConfig): string | null {
  if (config.serverUrl) {
    return new URL(config.serverUrl).toString();
  }
  if (config.webSocketUrl) {
    const url = new URL(config.webSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  return null;
}

function toWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url.toString();
}

function requireConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Spark daemon config is missing ${name}. Run spark daemon workspace register first.`,
    );
  }
  return value;
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function sendJson(ws: ServerSocket, value: unknown): void {
  ws.send(JSON.stringify(value));
}

function logDaemonError(runtimeId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[spark-daemon:${runtimeId}] ${message}`);
}
