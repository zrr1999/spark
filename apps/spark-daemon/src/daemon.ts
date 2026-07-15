import { createHash } from "node:crypto";
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
  parseSparkDaemonEvent,
  runtimeCommandResultEnvelopeSchema,
  runtimeProtocolVersion,
  sparkProtocolJsonObjectSchema,
  runtimeReconcileRequestEnvelopeSchema,
  serverCommandEnvelopeSchema,
  serverHelloAckEnvelopeSchema,
  type SparkDaemonEvent,
  type SparkCommand,
  type SparkJsonObject,
  type RuntimeFeature,
  type RuntimeWorkspaceBindingSummary,
} from "@zendev-lab/spark-protocol";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { writePrivateFile, type SparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig, type SparkDaemonConfig } from "./config.js";
import {
  createDaemonChannelIngressRuntime,
  type ChannelIngressHooks,
  type DaemonChannelIngressRuntime,
} from "./channels/ingress.ts";
import { projectChannelAsk, settleChannelAskInteraction } from "./channels/human-interactions.ts";
import {
  SparkDaemonInvocationRegistry,
  SparkDaemonHumanInteractionBroker,
  legacySparkDaemonQueueRoot,
  type SparkDaemonEventSink,
  type SparkDaemonTaskExecutor,
} from "./core/index.ts";
import {
  SparkDaemonHumanWaitRegistry,
  type SparkDaemonHumanWaitDeliveryResult,
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
  commandResult,
  invocationLogChunk,
  invocationUpdated,
  reconcileReport,
  runtimeEnvelope,
  workspaceSnapshot,
  type RouteContext,
} from "./protocol/outbound.js";
import { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import {
  acknowledgeRuntimeCommandTerminal,
  claimRuntimeCommandReceipt,
  pendingRuntimeCommandTerminals,
  recordRuntimeCommandAck,
  recordRuntimeCommandTerminal,
  recoverInterruptedRuntimeCommandReceipts,
} from "./runtime-command-receipts.ts";
import { migrateLegacyQueueHistory } from "./store/legacy-queue-migration.ts";
import {
  SparkInvocationStore,
  type SparkInvocationEvent,
  type SparkInvocationPendingDelivery,
} from "./store/invocations.ts";
import {
  getWorkspaceById,
  isBorrowedWorkspace,
  isUserDetachedWorkspace,
  listWorkspaces,
  markSparkDaemonServerConnected,
  markSparkDaemonServerDisconnected,
  reconcileWorkspaces,
  resolveWorkspaceLocalPath,
  sparkDaemonServerStatusSummaries,
  workspaceSummaries,
} from "./store/workspaces.js";
import {
  commandRejectForUnknownInvocation,
  runSparkCommandBridge,
  cancelSparkBridgeInvocation,
  type RunSparkCommandFn,
  type CancelSparkInvocationFn,
} from "./spark/bridge.js";
import { createChannelAwareTaskExecutor } from "./spark/session-run.js";
import { reconcileSessionNotificationDeliveries } from "./session-notification-delivery.ts";
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
  /** Immediate restart admission gate: stop accepting/claiming new work. */
  drainSignal?: AbortSignal;
  /** Graceful restart exit gate: exit after already-active work settles. */
  restartSignal?: AbortSignal;
  drainTimeoutMs?: number;
  /**
   * Optional override for Spark-backed command execution. Production callers can
   * leave this unset to use the real Spark runtime bridge; tests inject a fake
   * to assert the streamed envelope sequence without spawning a real role-run.
   */
  runSparkCommand?: RunSparkCommandFn;
  cancelSparkInvocation?: CancelSparkInvocationFn;
  executeInvocation?: SparkDaemonTaskExecutor;
  runScheduler?: boolean;
  schedulerPollIntervalMs?: number;
  schedulerConcurrency?: number;
  invocationTimeoutMs?: number;
  /** Retry delay for the optional Cockpit projection connection. */
  serverReconnectDelayMs?: number;
  invocationRegistry?: SparkDaemonInvocationRegistry;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  localEventSink?: SparkDaemonEventSink;
  channelIngress?: DaemonChannelIngressRuntime;
  mailStore?: SparkSessionMailStore;
  notificationReconcileIntervalMs?: number;
}

export async function startSparkDaemon(options: StartSparkDaemonOptions): Promise<void> {
  const runtimeShutdown = new AbortController();
  const forwardShutdown = () => runtimeShutdown.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardShutdown();
  else options.signal?.addEventListener("abort", forwardShutdown, { once: true });
  const runtimeSignal = runtimeShutdown.signal;
  writePrivateFile(options.paths.pidFile, `${process.pid}\n`);
  // Local execution truth is established independently of the optional
  // Cockpit projection. This also repairs status left by older daemons that
  // conflated a server disconnect with an unavailable workspace.
  reconcileWorkspaces(options.db);
  const invocationRegistry = options.invocationRegistry ?? new SparkDaemonInvocationRegistry();
  const humanWaits = options.humanWaits ?? new SparkDaemonHumanWaitRegistry(options.db);
  let channelIngress: DaemonChannelIngressRuntime | null = options.channelIngress ?? null;
  let flushHumanRequestOutbox: (() => void) | null = null;
  const getRuntimeId = () => {
    try {
      return readSparkDaemonConfig(options.paths).runtimeId ?? options.config.runtimeId;
    } catch {
      return options.config.runtimeId;
    }
  };
  const onChannelInteraction: NonNullable<ChannelIngressHooks["onInteraction"]> = async (input) => {
    if (!channelIngress) return;
    const runtimeId = getRuntimeId();
    if (!runtimeId) throw new Error("daemon runtimeId is unavailable for channel response routing");
    try {
      await settleChannelAskInteraction(channelIngress, humanWaits, input, { runtimeId });
    } finally {
      flushHumanRequestOutbox?.();
    }
  };
  channelIngress?.setInteractionHandler?.(onChannelInteraction);
  const setHumanRequestOutboxTarget = (flush?: () => void) => {
    flushHumanRequestOutbox = flush ?? null;
  };
  const humanInteractions = new SparkDaemonHumanInteractionBroker({
    db: options.db,
    waits: humanWaits,
    getRuntimeId,
    onOutboxReady: () => flushHumanRequestOutbox?.(),
    onRequestOpened: (input) => {
      if (!channelIngress) return;
      void projectChannelAsk(channelIngress, input).catch((error: unknown) => {
        console.error(
          "[spark-daemon] channel ask projection failed; Cockpit request remains pending",
          error,
        );
      });
    },
  });
  let emitInvocationEventToServer: ((event: SparkInvocationEvent) => void | Promise<void>) | null =
    null;
  const setInvocationEventTarget = (
    sink?: (event: SparkInvocationEvent) => void | Promise<void>,
  ) => {
    emitInvocationEventToServer = sink ?? null;
  };
  const emitInvocationEvent = async (event: SparkInvocationEvent) => {
    await Promise.all([
      options.localEventSink?.(parseSparkDaemonEvent(event.payload)),
      emitInvocationEventToServer?.(event),
    ]);
  };
  const invocationStore = new SparkInvocationStore(options.db);
  recoverInterruptedRuntimeCommandReceipts(options.db);
  if (options.runScheduler !== false) {
    await migrateLegacyQueueHistory({
      db: options.db,
      queueRoot: legacySparkDaemonQueueRoot({ paths: options.paths }),
    });
  }
  const scheduler =
    options.runScheduler === false
      ? null
      : new SparkInvocationScheduler({
          store: invocationStore,
          executeTask:
            options.executeInvocation ??
            createChannelAwareTaskExecutor({
              paths: options.paths,
              cwd: process.cwd(),
              controlSparkHome:
                (options.sparkHome ?? process.env.SPARK_HOME?.trim()) || join(homedir(), ".spark"),
              channelsSparkHome:
                (options.sparkHome ?? process.env.SPARK_HOME?.trim()) || join(homedir(), ".spark"),
              ...(options.modelControl ? { modelControl: options.modelControl } : {}),
              ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
              channelIngress: {
                openReplyStream: async (workspaceId, adapterId, target) =>
                  await channelIngress?.openReplyStream(workspaceId, adapterId, target),
                sendReply: async (workspaceId, adapterId, input) => {
                  if (!channelIngress) throw new Error("channel ingress is unavailable");
                  await channelIngress.sendReply(workspaceId, adapterId, input);
                },
              },
              interact: (request, task, context) =>
                humanInteractions.interact(request, {
                  sessionId: task.sessionId,
                  invocationId: context.invocationId,
                  workspaceBindingId: task.workspaceBindingId,
                  workspaceId: task.workspaceId,
                  projectId: task.projectId,
                  signal: context.signal,
                  ...(task.channelReply
                    ? {
                        channel: {
                          workspaceId: task.channelReply.workspaceId,
                          adapterId: task.channelReply.adapterId,
                          recipient: task.channelReply.recipient,
                          ...(task.channelContext?.senderId
                            ? { actorId: task.channelContext.senderId }
                            : {}),
                          ...(task.channelContext?.messageId
                            ? { messageId: task.channelContext.messageId }
                            : {}),
                        },
                      }
                    : {}),
                }),
            }),
          emitEvent: emitInvocationEvent,
          concurrency: options.schedulerConcurrency,
          taskTimeoutMs: options.invocationTimeoutMs,
        });
  scheduler?.recover();
  let schedulerLoop: Promise<void> | undefined;
  const runSchedulerLoop = async () => {
    while (!runtimeSignal.aborted) {
      const didWork = scheduler?.processBatch() ?? false;
      if (!didWork) await delayUnlessAborted(options.schedulerPollIntervalMs ?? 250, runtimeSignal);
    }
  };
  const stopScheduler = () => scheduler?.stop();
  const stopDirectInvocations = () => invocationRegistry.stop();
  if (scheduler && !options.once) schedulerLoop = runSchedulerLoop();
  runtimeSignal.addEventListener("abort", stopScheduler, { once: true });
  runtimeSignal.addEventListener("abort", stopDirectInvocations, { once: true });
  const closeRestartAdmission = () => {
    scheduler?.beginDrain();
    invocationRegistry.beginDrain();
  };
  if (options.drainSignal?.aborted) closeRestartAdmission();
  else options.drainSignal?.addEventListener("abort", closeRestartAdmission, { once: true });
  let restartDrain: Promise<void> | undefined;
  const beginRestartDrain = () => {
    closeRestartAdmission();
    restartDrain ??= Promise.all([
      scheduler ? scheduler.wait({ timeoutMs: Number.POSITIVE_INFINITY }) : Promise.resolve(),
      invocationRegistry.waitForIdle(),
    ]).then(async () => {
      // Keep channels alive while active work may still be waiting for an ask
      // response. Once execution is idle, stop transports and flush already-
      // received async admissions before the database is closed.
      try {
        await channelIngress?.stop();
      } catch (error) {
        logDaemonError(options.config.runtimeId ?? "unknown", error);
      } finally {
        runtimeShutdown.abort(options.restartSignal?.reason);
      }
    });
  };
  if (options.restartSignal?.aborted) beginRestartDrain();
  else options.restartSignal?.addEventListener("abort", beginRestartDrain, { once: true });

  channelIngress = await maybeStartChannelIngress(options);
  channelIngress?.setInteractionHandler?.(onChannelInteraction);
  const mailStore =
    options.mailStore ??
    new SparkSessionMailStore({
      sparkHome: (options.sparkHome ?? process.env.SPARK_HOME?.trim()) || join(homedir(), ".spark"),
    });
  let notificationReconcileLoop: Promise<void> | undefined;
  if (channelIngress && options.sessionRegistry && !options.once) {
    notificationReconcileLoop = runNotificationReconcileLoop(
      mailStore,
      options.sessionRegistry,
      channelIngress,
      runtimeSignal,
      options.notificationReconcileIntervalMs ?? 1_000,
    );
  }
  const stopChannelIngress = () => {
    void channelIngress?.stop().catch((error: unknown) => {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    });
  };
  runtimeSignal.addEventListener("abort", stopChannelIngress, { once: true });

  try {
    if (options.once) {
      if (scheduler) {
        scheduler.processBatch();
        await scheduler.wait();
      }
      if (!runtimeSignal.aborted && canAttemptServerConnection(options.config)) {
        await runSparkDaemonServerConnection({
          ...options,
          signal: runtimeSignal,
          invocationRegistry,
          humanWaits,
          setInvocationEventTarget,
          setHumanRequestOutboxTarget,
        });
      }
      return;
    }

    while (!runtimeSignal.aborted) {
      const config = readSparkDaemonConfig(options.paths);
      if (!canAttemptServerConnection(config)) {
        await delayUnlessAborted(500, runtimeSignal);
        continue;
      }

      try {
        await runSparkDaemonServerConnection({
          ...options,
          signal: runtimeSignal,
          config,
          invocationRegistry,
          humanWaits,
          setInvocationEventTarget,
          setHumanRequestOutboxTarget,
        });
      } catch {
        // Cockpit is an optional projection surface. Connection failures are
        // represented by daemon_servers.last_disconnect_reason and must not
        // become permanent business-outbox entries or stop local execution.
        await delayUnlessAborted(options.serverReconnectDelayMs ?? 1_000, runtimeSignal);
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", forwardShutdown);
    options.drainSignal?.removeEventListener("abort", closeRestartAdmission);
    options.restartSignal?.removeEventListener("abort", beginRestartDrain);
    runtimeSignal.removeEventListener("abort", stopScheduler);
    runtimeSignal.removeEventListener("abort", stopDirectInvocations);
    runtimeSignal.removeEventListener("abort", stopChannelIngress);
    try {
      await channelIngress?.stop();
    } catch (error) {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    }
    scheduler?.stop();
    await scheduler?.wait();
    await restartDrain;
    await schedulerLoop;
    await notificationReconcileLoop;
    if (existsSync(options.paths.pidFile)) {
      rmSync(options.paths.pidFile, { force: true });
    }
  }
}

async function runNotificationReconcileLoop(
  mailStore: SparkSessionMailStore,
  sessionRegistry: DaemonSessionRegistry,
  channelIngress: DaemonChannelIngressRuntime,
  signal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await reconcileSessionNotificationDeliveries({
        mailStore,
        sessionRegistry,
        channelIngress,
      });
    } catch (error) {
      console.error("[spark-daemon] session notification reconciliation failed", error);
    }
    await delayUnlessAborted(Math.max(250, Math.floor(intervalMs)), signal);
  }
}

async function maybeStartChannelIngress(
  options: StartSparkDaemonOptions,
): Promise<DaemonChannelIngressRuntime | null> {
  if (options.once || options.runScheduler === false) return null;
  const sparkHome =
    (options.sparkHome ?? process.env.SPARK_HOME?.trim()) || join(homedir(), ".spark");
  const invocationStore = new SparkInvocationStore(options.db);
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
          const thinkingLevel = options.modelControl
            ? await options.modelControl.effectiveThinkingLevel(assignment.sessionId)
            : undefined;
          const session = await options.sessionRegistry?.get(assignment.sessionId);
          if (session && session.scope.kind !== "workspace") {
            throw new Error(`channel session ${assignment.sessionId} has no workspace owner`);
          }
          const workspaceId =
            session?.scope.kind === "workspace"
              ? session.scope.workspaceId
              : assignment.channelReply.workspaceId;
          const cwdCandidate =
            session?.cwd?.trim() && session.cwd.trim() !== "/"
              ? session.cwd.trim()
              : resolveWorkspaceLocalPath(options.db, workspaceId);
          const cwd = cwdCandidate?.trim();
          if (!cwd || cwd === "/") {
            throw new Error(
              `channel session ${assignment.sessionId} has no daemon-local execution directory`,
            );
          }
          const task = {
            type: "session.run" as const,
            sessionId: assignment.sessionId,
            prompt: assignment.goal,
            ...(model ? { model: `${model.providerName}/${model.modelId}` } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            assignment: assignment.assignment,
            workspaceId,
            cwd,
            channelReply: assignment.channelReply,
            ...(assignment.channelContext ? { channelContext: assignment.channelContext } : {}),
          };
          invocationStore.submit({
            sessionId: task.sessionId,
            prompt: task.prompt,
            task,
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
  setInvocationEventTarget?: (sink?: (event: SparkInvocationEvent) => void | Promise<void>) => void;
  setHumanRequestOutboxTarget?: (flush?: () => void) => void;
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
  if (options.signal?.aborted) return;

  await new Promise<void>((resolvePromise, reject) => {
    let runtimeSessionId: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let tokenRefresh: NodeJS.Timeout | undefined;
    let intentionalClose = false;
    let settled = false;
    let invocationEventTargetAttached = false;
    let humanRequestOutboxTargetAttached = false;
    let runtimeReady = false;
    let inFlightInvocationEvent:
      | { messageId: string; invocationId: string; sequence: number }
      | undefined;
    const invocationStore = new SparkInvocationStore(options.db);
    const deliveryDestination = `cockpit:${runtimeId}`;
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

    const detachInvocationEventTarget = () => {
      if (!invocationEventTargetAttached) return;
      invocationEventTargetAttached = false;
      options.setInvocationEventTarget?.(undefined);
    };

    const detachHumanRequestOutboxTarget = () => {
      if (!humanRequestOutboxTargetAttached) return;
      humanRequestOutboxTargetAttached = false;
      options.setHumanRequestOutboxTarget?.(undefined);
    };

    const settle = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      detachInvocationEventTarget();
      detachHumanRequestOutboxTarget();
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
    const flushNextInvocationEvent = () => {
      if (!runtimeReady || inFlightInvocationEvent || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const pending = invocationStore.pendingDeliveries(deliveryDestination, 1)[0];
      if (!pending) return;
      const projected = runtimeEnvelopeForInvocationEvent(pending, {
        store: invocationStore,
        db: options.db,
        runtimeId,
        serverUrl,
      });
      if (!projected) {
        invocationStore.acknowledgeDelivery(
          deliveryDestination,
          pending.event.invocationId,
          pending.event.sequence,
        );
        queueMicrotask(flushNextInvocationEvent);
        return;
      }
      inFlightInvocationEvent = {
        messageId: projected.messageId,
        invocationId: pending.event.invocationId,
        sequence: pending.event.sequence,
      };
      sendJson(ws, projected);
    };
    if (options.signal?.aborted) {
      requestShutdown();
      return;
    }
    options.signal?.addEventListener("abort", requestShutdown, { once: true });

    ws.on("open", () => {
      if (serverUrl) {
        markSparkDaemonServerConnected(options.db, serverUrl);
      }
      invocationEventTargetAttached = true;
      options.setInvocationEventTarget?.(() => flushNextInvocationEvent());
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
        onRuntimeReady() {
          runtimeReady = true;
          flushPendingRuntimeCommandTerminals(ws, options.db);
          flushNextInvocationEvent();
        },
        onIngestAck(ackOf) {
          acknowledgeRuntimeCommandTerminal(options.db, ackOf);
          const inFlight = inFlightInvocationEvent;
          if (!inFlight || inFlight.messageId !== ackOf) return;
          invocationStore.acknowledgeDelivery(
            deliveryDestination,
            inFlight.invocationId,
            inFlight.sequence,
          );
          inFlightInvocationEvent = undefined;
          flushNextInvocationEvent();
        },
        get runtimeSessionId() {
          return runtimeSessionId;
        },
        setRuntimeSessionId(value) {
          runtimeSessionId = value;
        },
        ensureHeartbeat(intervalMs) {
          if (!humanRequestOutboxTargetAttached) {
            humanRequestOutboxTargetAttached = true;
            options.setHumanRequestOutboxTarget?.(() =>
              flushPendingHumanRequests(ws, options.humanWaits),
            );
          }
          flushPendingHumanRequests(ws, options.humanWaits);
          if (heartbeat) {
            return;
          }
          heartbeat = setInterval(() => {
            sendHeartbeat(ws, options.db, runtimeId, runtimeSessionId);
            flushPendingHumanRequests(ws, options.humanWaits);
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
  onRuntimeReady?(): void;
  onIngestAck?(ackOf: string): void;
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
        delivery: registration.wait.delivery,
        interactionRequestId: registration.wait.interactionRequestId || undefined,
        sessionId: registration.wait.sessionId || undefined,
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
    context.onRuntimeReady?.();
    return;
  }

  if (isServerIngestAck(value)) {
    context.humanWaits?.acknowledgeOutbox(value.ackOf);
    context.onIngestAck?.(value.ackOf);
    return;
  }

  const command = serverCommandEnvelopeSchema.safeParse(value);
  if (command.success) {
    await handleCommand(ws, command.data, context);
    return;
  }

  const humanResponse = humanResponseDeliverEnvelopeSchema.safeParse(value);
  if (humanResponse.success) {
    const delivery: SparkDaemonHumanWaitDeliveryResult = context.humanWaits?.deliver({
      humanRequestId: humanResponse.data.humanRequestId,
      humanResponseId: humanResponse.data.humanResponseId,
      status: humanResponse.data.payload.status,
      answers: humanResponse.data.payload.answers,
      responseArtifactRefs: humanResponse.data.payload.responseArtifactRefs,
    }) ?? {
      outcome: "unknown_request",
      retryable: false,
      returnedToTool: false,
      message: "No daemon-owned human wait registry is attached in this Spark daemon slice.",
    };
    sendJson(
      ws,
      runtimeEnvelope(
        "human.response.ack",
        {
          returnedToTool: delivery.returnedToTool,
          outcome: delivery.outcome,
          retryable: delivery.retryable,
          winnerResponseId: delivery.winnerResponseId,
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
  if (command.runtimeId !== context.runtimeId) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "RUNTIME_ID_MISMATCH",
          message: "Command was routed to a different Spark daemon runtime.",
          retryable: false,
        },
        commandRoute(context.runtimeId, command),
      ),
    );
    return;
  }

  if (!command.commandId) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "COMMAND_ID_REQUIRED",
          message: "Runtime command requires a command id.",
          retryable: false,
        },
        commandRoute(context.runtimeId, command),
      ),
    );
    return;
  }
  const commandId = command.commandId;
  const claim = claimRuntimeCommandReceipt(context.db, command);
  if (claim.kind === "conflict") {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "COMMAND_REPLAY_CONFLICT",
          message: "Command id was replayed with a different typed payload.",
          retryable: false,
        },
        commandRoute(context.runtimeId, command),
      ),
    );
    return;
  }
  if (claim.kind === "replay") {
    if (claim.ack) sendJson(ws, claim.ack);
    if (claim.terminal) sendJson(ws, markCommandResultReplayed(claim.terminal));
    return;
  }

  const durableSocket = runtimeCommandReceiptSocket(ws, context.db, commandId);
  try {
    await executeClaimedCommand(durableSocket, command, context);
  } catch (error) {
    const failed = commandResult(
      {
        status: "failed",
        result: {
          reasonCode: "COMMAND_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
        completedAt: new Date().toISOString(),
      },
      commandRoute(context.runtimeId, command),
    );
    durableSocket.send(JSON.stringify(failed));
  }
}

async function executeClaimedCommand(
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
    runtimeId: command.runtimeId,
    expectedRuntimeId: context.runtimeId,
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
  const route = commandRoute(context.runtimeId, command);

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

  if (sparkCommand.kind === "daemon.status.request") {
    const completedAt = new Date().toISOString();
    const result = daemonStatusProjection(context);
    sendJson(ws, commandAck({ accepted: true }, route));
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result,
          projection: { kind: "daemon.status", data: result },
          completedAt,
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
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: { refreshed: Boolean(workspace) },
          projection: {
            kind: "workspace.snapshot",
            data: {
              ...(workspace?.id || command.workspaceBindingId
                ? { workspaceBindingId: workspace?.id ?? command.workspaceBindingId }
                : {}),
            },
          },
          completedAt: new Date().toISOString(),
        },
        route,
      ),
    );
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
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: { invocationId },
          completedAt: new Date().toISOString(),
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
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: { invocationId, cancelled: true, message: result.message },
          completedAt: new Date().toISOString(),
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

  if (context.invocationRegistry?.draining) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "DAEMON_DRAINING",
          message: "Spark daemon is draining for restart; retry after the new daemon is ready.",
          retryable: true,
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

  // Model preparation is asynchronous, so restart draining may have begun
  // after the first admission check above.
  if (context.invocationRegistry?.draining) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "DAEMON_DRAINING",
          message: "Spark daemon is draining for restart; retry after the new daemon is ready.",
          retryable: true,
        },
        route,
      ),
    );
    return;
  }

  const invocation = context.invocationRegistry?.start({
    invocationId: createId("inv"),
    kind: sparkCommand.kind,
  });
  try {
    const result = await context.runSparkCommand({
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
    sendJson(
      ws,
      commandResult(
        {
          status: result.status === "succeeded" ? "succeeded" : "failed",
          result: {
            invocationId: result.invocationId,
            taskRuntimeId: result.taskRuntimeId,
            status: result.status,
            outputArtifactIds: result.outputArtifactIds,
          },
          completedAt: new Date().toISOString(),
        },
        { ...route, invocationId: result.invocationId },
      ),
    );
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

function runtimeEnvelopeForInvocationEvent(
  pending: SparkInvocationPendingDelivery,
  context: {
    store: SparkInvocationStore;
    db: DatabaseSync;
    runtimeId: string;
    serverUrl: string | null;
  },
): ReturnType<typeof runtimeEnvelope> | null {
  let event: SparkDaemonEvent;
  try {
    event = parseSparkDaemonEvent(pending.event.payload);
  } catch {
    return null;
  }
  const route = routeForDaemonEvent(event, context);
  if (!route) {
    console.error(
      `[spark-daemon] dropping unroutable invocation event ${pending.event.kind}; no workspace route was available`,
    );
    return null;
  }
  const messageId = invocationEventMessageId(pending.event);
  if (event.type === "daemon.task.lifecycle") {
    return invocationUpdated(
      {
        runtimeInvocationId: pending.event.invocationId,
        sequence: pending.event.sequence,
        status: event.status,
        ...(event.status === "running" ? { startedAt: event.emittedAt } : {}),
        ...(event.status === "succeeded" ||
        event.status === "failed" ||
        event.status === "cancelled"
          ? { completedAt: event.emittedAt }
          : {}),
        ...(event.summary ? { terminalReason: event.summary } : {}),
        payload: invocationEventMetadata(event),
      },
      route,
      { messageId },
    );
  }
  const assistantDelta = assistantDeltaFromInvocationEvent(pending.event, event, context.store);
  if (assistantDelta !== undefined) {
    return invocationLogChunk(
      {
        runtimeInvocationId: pending.event.invocationId,
        stream: "assistant",
        sequence: pending.event.sequence,
        content: assistantDelta,
        metadata: invocationEventMetadata(event),
      },
      route,
      { messageId },
    );
  }
  return runtimeEnvelope("daemon.event", event, route, { messageId });
}

function invocationEventMessageId(event: SparkInvocationEvent): string {
  const digest = createHash("sha256")
    .update(`${event.invocationId}:${event.sequence}`)
    .digest("hex")
    .slice(0, 32);
  return `msg_${digest}`;
}

function invocationEventMetadata(event: SparkDaemonEvent): SparkJsonObject {
  return {
    ...event.metadata,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    eventType: event.type,
  };
}

function assistantDeltaFromInvocationEvent(
  persisted: SparkInvocationEvent,
  event: SparkDaemonEvent,
  store: SparkInvocationStore,
): string | undefined {
  const current = assistantMessage(event);
  if (!current) return undefined;
  let beforeSequence = persisted.sequence;
  while (beforeSequence > 1) {
    const previous = store.previousEvent(
      persisted.invocationId,
      beforeSequence,
      "daemon.view_event",
    );
    if (!previous) return current.text;
    beforeSequence = previous.sequence;
    try {
      const previousMessage = assistantMessage(parseSparkDaemonEvent(previous.payload));
      if (!previousMessage || previousMessage.id !== current.id) continue;
      return current.text.startsWith(previousMessage.text)
        ? current.text.slice(previousMessage.text.length)
        : current.text;
    } catch {
      continue;
    }
  }
  return current.text;
}

function assistantMessage(event: SparkDaemonEvent): { id: string; text: string } | undefined {
  if (event.type !== "daemon.view_event" || event.view.type !== "session.message") return undefined;
  const message = event.view.message;
  if (message.role !== "assistant" || typeof message.text !== "string") return undefined;
  return { id: message.id, text: message.text };
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

function flushPendingHumanRequests(ws: WebSocket, waits: SparkDaemonHumanWaitRegistry): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  for (const entry of waits.listPendingOutbox()) {
    sendJson(ws, entry.envelope);
  }
}

function isServerIngestAck(value: unknown): value is { type: "server.ingest_ack"; ackOf: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "server.ingest_ack" &&
    typeof record.ackOf === "string" &&
    record.ackOf.trim().length > 0
  );
}

function flushPendingRuntimeCommandTerminals(ws: ServerSocket, db: DatabaseSync): void {
  for (const terminal of pendingRuntimeCommandTerminals(db)) {
    sendJson(ws, markCommandResultReplayed(terminal));
  }
}

function runtimeCommandReceiptSocket(
  ws: ServerSocket,
  db: DatabaseSync,
  commandId: string,
): ServerSocket {
  return {
    send(data) {
      const value = JSON.parse(data) as { type?: unknown };
      if (value.type === "runtime.command.ack") {
        recordRuntimeCommandAck(db, commandId, value);
        trySendJsonString(ws, data);
        return;
      }
      if (value.type === "runtime.command.reject") {
        recordRuntimeCommandTerminal(db, {
          commandId,
          status: "rejected",
          envelope: value,
        });
        trySendJsonString(ws, data);
        return;
      }
      if (value.type === "runtime.command.result") {
        const parsed = runtimeCommandResultEnvelopeSchema.safeParse(value);
        const terminal = parsed.success
          ? parsed.data
          : runtimeCommandResultEnvelopeSchema.parse(
              commandResult(
                {
                  status: "failed",
                  result: {
                    reasonCode: "COMMAND_RESULT_INVALID",
                    message:
                      "Runtime command result exceeded its schema or public payload boundary.",
                  },
                  completedAt: new Date().toISOString(),
                },
                commandRouteFromUnknown(value),
              ),
            );
        recordRuntimeCommandTerminal(db, {
          commandId,
          status: terminal.payload.status,
          envelope: terminal,
        });
        trySendJsonString(ws, JSON.stringify(terminal));
        return;
      }
      ws.send(data);
    },
  };
}

function trySendJsonString(ws: ServerSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    // The durable receipt is replayed when this runtime WebSocket reconnects.
  }
}

function markCommandResultReplayed(value: unknown): unknown {
  const parsed = runtimeCommandResultEnvelopeSchema.safeParse(value);
  if (!parsed.success) return value;
  return {
    ...parsed.data,
    payload: { ...parsed.data.payload, replayed: true },
  };
}

function commandRoute(
  runtimeId: string,
  command: ReturnType<typeof serverCommandEnvelopeSchema.parse>,
): RouteContext {
  return {
    runtimeId,
    workspaceBindingId: command.workspaceBindingId,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    commandId: command.commandId,
    ackOf: command.messageId,
  };
}

function commandRouteFromUnknown(value: unknown): RouteContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime command result route is missing.");
  }
  const route = value as Record<string, unknown>;
  if (typeof route.runtimeId !== "string" || typeof route.commandId !== "string") {
    throw new Error("Runtime command result route is incomplete.");
  }
  return {
    runtimeId: route.runtimeId,
    commandId: route.commandId,
    ...(typeof route.workspaceBindingId === "string"
      ? { workspaceBindingId: route.workspaceBindingId }
      : {}),
    ...(typeof route.workspaceId === "string" ? { workspaceId: route.workspaceId } : {}),
    ...(typeof route.projectId === "string" ? { projectId: route.projectId } : {}),
    ...(typeof route.invocationId === "string" ? { invocationId: route.invocationId } : {}),
    ...(typeof route.ackOf === "string" ? { ackOf: route.ackOf } : {}),
  };
}

function daemonStatusProjection(context: MessageContext) {
  const store = new SparkInvocationStore(context.db);
  return sparkProtocolJsonObjectSchema.parse({
    runtimeId: context.runtimeId,
    servers: sparkDaemonServerStatusSummaries(context.db),
    invocations: store.counts(),
    invocationHealth: store.oldestActive(),
    workspaceCount: listWorkspaces(context.db).length,
    observedAt: new Date().toISOString(),
  });
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
    localPath: workspace.localPath,
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
