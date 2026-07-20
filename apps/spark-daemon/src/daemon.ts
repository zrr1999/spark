import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import {
  createId,
  humanResponseDeliverEnvelopeSchema,
  normalizeServerCommandForExecution,
  parseSparkDaemonEvent,
  runtimeCommandResultEnvelopeSchema,
  runtimeEphemeralSecretResultEnvelopeSchema,
  serverEphemeralSecretRequestEnvelopeSchema,
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
import { resolveSparkUserPaths, writePrivateFile, type SparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig, type SparkDaemonConfig } from "./config.js";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  normalizeSparkDaemonServerUrl,
  sparkDaemonConfigForServerProfile,
  sparkDaemonServerProfileFromConfig,
  type SparkDaemonServerProfile,
} from "./server-profiles.js";
import {
  createDaemonChannelIngressRuntime,
  type ChannelIngressHooks,
  type DaemonChannelIngressRuntime,
} from "./channels/ingress.ts";
import {
  findChannelInboundInvocation,
  submitChannelInboundInvocation,
} from "./channels/admission.ts";
import {
  projectChannelAsk,
  settleChannelAskInteraction,
  settleChannelAskTextReply,
} from "./channels/human-interactions.ts";
import { createDaemonChannelTransportFactory } from "./channels/transport-factory.ts";
import {
  completeInvocationWithChannelDelivery,
  createDaemonChannelDeliveryOutbox,
  reconcileDaemonChannelDeliveries,
  type DaemonChannelDeliveryOutbox,
} from "./channels/delivery-outbox.ts";
import {
  ChannelReplyDeliveryStore,
  reconcileChannelReplyDeliveries,
} from "./channels/reply-delivery.ts";
import {
  SparkDaemonInvocationRegistry,
  SparkDaemonHumanInteractionBroker,
  legacySparkDaemonQueueRoot,
  type SparkDaemonDrainProgress,
  type SparkDaemonEventSink,
  type SparkDaemonHumanInteractionResponder,
  type SparkDaemonTaskExecutor,
} from "./core/index.ts";
import {
  SparkDaemonHumanWaitRegistry,
  type SparkDaemonHumanWaitDeliveryResult,
  type SparkDaemonHumanWaitInput,
  type SparkDaemonHumanWaitRecord,
  type SparkDaemonHumanWaitRegistration,
} from "./core/human-waits.ts";
import { sparkCommandFromServerCommandEnvelope } from "./command-dispatcher.ts";
import { decideCommandPolicy } from "./policy.js";
import type { SparkDaemonModelControl } from "./model-control.ts";
import {
  executeSparkDaemonEphemeralSecretControl,
  executeSparkDaemonModelChannelPublicControl,
  isSparkDaemonModelChannelPublicKind,
} from "./model-channel-control.ts";
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
  acknowledgeRuntimeCommandTerminalForRoute,
  claimRuntimeCommandReceipt,
  pendingRuntimeCommandTerminalsForRoute,
  recordRuntimeCommandAck,
  recordRuntimeCommandTerminal,
  recoverInterruptedRuntimeCommandReceipts,
} from "./runtime-command-receipts.ts";
import { migrateLegacyQueueHistory } from "./store/legacy-queue-migration.ts";
import { SparkChannelDeliveryStore } from "./store/channel-deliveries.ts";
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
  listWorkspacesForServer,
  markSparkDaemonServerConnected,
  markSparkDaemonServerDisconnected,
  reconcileWorkspaces,
  reconcileWorkspacesForServer,
  resolveWorkspaceLocalPath,
  sparkDaemonServerStatusSummaries,
  workspaceBindingBelongsToServer,
  workspaceSummaries,
} from "./store/workspaces.js";
import {
  commandRejectForUnknownInvocation,
  runSparkCommandBridge,
  cancelSparkBridgeInvocation,
  type RunSparkCommandFn,
  type CancelSparkInvocationFn,
} from "./spark/bridge.js";
import { createChannelAwareTaskExecutor, sessionSourceForTask } from "./spark/session-run.js";
import { reconcileSessionNotificationDeliveries } from "./session-notification-delivery.ts";
import { executeSparkDaemonSessionControl } from "./session-control.ts";
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
  "ephemeral-secret-v1",
];

/**
 * Minimal WebSocket-like surface used by command handlers. Production wires the
 * real `ws` library; tests pass a tiny stub that just records `send` calls.
 */
export interface ServerSocket {
  send(data: string): void;
}

export interface SparkDaemonUplinkControl {
  requestReconfigure(serverUrl?: string): void;
  subscribe(listener: (serverUrl?: string) => void): () => void;
}

export function createSparkDaemonUplinkControl(): SparkDaemonUplinkControl {
  const listeners = new Set<(serverUrl?: string) => void>();
  return {
    requestReconfigure(serverUrl) {
      for (const listener of listeners) listener(serverUrl);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface StartSparkDaemonOptions {
  paths: SparkPaths;
  /** Global Spark provider/auth control root. */
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
  /** Uplink-only reconfiguration signal; never stops local execution loops. */
  uplinkControl?: SparkDaemonUplinkControl;
  invocationRegistry?: SparkDaemonInvocationRegistry;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  localEventSink?: SparkDaemonEventSink;
  channelIngress?: DaemonChannelIngressRuntime;
  mailStore?: SparkSessionMailStore;
  notificationReconcileIntervalMs?: number;
  channelDeliveryReconcileIntervalMs?: number;
  /** Bind readiness transport while externally observable work admission is still closed. */
  onReady?: (runtime: {
    channelIngress: DaemonChannelIngressRuntime | null;
    respondHumanInteraction: SparkDaemonHumanInteractionResponder;
  }) => void | Promise<void>;
  /** Publish process-local execution fences while a restart is draining. */
  onDrainProgress?: (progress: SparkDaemonDrainProgress) => void;
  /** Commit the serving/restart fence after all synchronous admission gates and loops are ready. */
  onServing?: () => void;
  /** Production CLI owns pid publication through lock release. */
  managePidFile?: boolean;
}

export async function startSparkDaemon(options: StartSparkDaemonOptions): Promise<void> {
  const runtimeShutdown = new AbortController();
  const forwardShutdown = () => runtimeShutdown.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardShutdown();
  else options.signal?.addEventListener("abort", forwardShutdown, { once: true });
  const runtimeSignal = runtimeShutdown.signal;
  if (options.managePidFile !== false) writePrivateFile(options.paths.pidFile, `${process.pid}\n`);
  // Local execution truth is established independently of the optional
  // Cockpit projection. This also repairs status left by older daemons that
  // conflated a server disconnect with an unavailable workspace.
  reconcileWorkspaces(options.db);
  const invocationRegistry = options.invocationRegistry ?? new SparkDaemonInvocationRegistry();
  // A newly constructed process is not yet the committed daemon generation.
  // Keep direct runtime commands closed until onServing completes the exact
  // successor fence CAS.
  invocationRegistry.beginDrain();
  const humanWaits = options.humanWaits ?? new SparkDaemonHumanWaitRegistry(options.db);
  const channelDeliveryStore = new SparkChannelDeliveryStore(options.db);
  const channelDeliveryOutbox = createDaemonChannelDeliveryOutbox(channelDeliveryStore);
  const channelIngress: DaemonChannelIngressRuntime | null = prepareChannelIngress(
    options,
    channelDeliveryOutbox,
  );
  let channelShutdown: Promise<void> | undefined;
  const shutdownChannelIngress = (
    reason: "restart-drain" | "runtime-abort" | "daemon-finally",
  ): Promise<void> => {
    if (!channelIngress) return Promise.resolve();
    if (channelShutdown) return channelShutdown;
    console.error(`[spark-daemon] channel ingress stopping reason=${reason}`);
    channelShutdown = channelIngress.stop().catch((error: unknown) => {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    });
    return channelShutdown;
  };
  let channelAdmissionOpen = false;
  channelIngress?.setInboundHandler?.(({ workspaceId, message }) => {
    if (!channelAdmissionOpen) {
      throw new Error("Spark daemon channel admission is closed during startup or drain");
    }
    channelDeliveryOutbox.enqueueInbound({ workspaceId, message });
  });
  const humanRequestOutboxTargets = new Set<() => void>();
  const flushHumanRequestOutbox = () => {
    for (const flush of humanRequestOutboxTargets) flush();
  };
  const getRuntimeIdForServer = (serverUrl: string) => {
    try {
      const runtimeId = getSparkDaemonServerProfile(options.paths, serverUrl)?.runtimeId;
      if (runtimeId) return runtimeId;
    } catch {
      // Fall through to the already-loaded compatibility config.
    }
    const fallback = sparkDaemonServerProfileFromConfig(options.config);
    return fallback?.serverUrl === normalizeSparkDaemonServerUrl(serverUrl)
      ? fallback.runtimeId
      : undefined;
  };
  const getRuntimeId = (route: { serverUrl: string }) => getRuntimeIdForServer(route.serverUrl);
  const onChannelInteraction: NonNullable<ChannelIngressHooks["onInteraction"]> = async (input) => {
    if (!channelIngress) return;
    try {
      await settleChannelAskInteraction(channelIngress, humanWaits, input, {
        getRuntimeId(wait) {
          const workspace = wait.workspaceBindingId
            ? getWorkspaceById(options.db, wait.workspaceBindingId)
            : null;
          return workspace?.serverUrl ? getRuntimeIdForServer(workspace.serverUrl) : undefined;
        },
        deliveryOutbox: channelDeliveryOutbox,
      });
    } finally {
      flushHumanRequestOutbox();
    }
  };
  channelIngress?.setInteractionHandler?.(onChannelInteraction);
  const onChannelTextAsk: NonNullable<ChannelIngressHooks["onTextAskReply"]> = async (input) => {
    try {
      return await settleChannelAskTextReply(humanWaits, input, {
        getRuntimeId(wait) {
          const workspace = wait.workspaceBindingId
            ? getWorkspaceById(options.db, wait.workspaceBindingId)
            : null;
          return workspace?.serverUrl ? getRuntimeIdForServer(workspace.serverUrl) : undefined;
        },
      });
    } finally {
      flushHumanRequestOutbox();
    }
  };
  channelIngress?.setTextAskHandler?.(onChannelTextAsk);
  const registerHumanRequestOutboxTarget = (flush: () => void) => {
    humanRequestOutboxTargets.add(flush);
    return () => humanRequestOutboxTargets.delete(flush);
  };
  const humanInteractions = new SparkDaemonHumanInteractionBroker({
    db: options.db,
    waits: humanWaits,
    getRuntimeId,
    onOutboxReady: flushHumanRequestOutbox,
    onRequestOpened: (input) => {
      if (!channelIngress) return;
      void projectChannelAsk(channelIngress, input, channelDeliveryOutbox).catch(
        (error: unknown) => {
          console.error(
            "[spark-daemon] channel ask outbox enqueue failed; Cockpit request remains pending",
            error,
          );
        },
      );
    },
  });
  const invocationEventTargets = new Set<(event: SparkInvocationEvent) => void | Promise<void>>();
  const registerInvocationEventTarget = (
    sink: (event: SparkInvocationEvent) => void | Promise<void>,
  ) => {
    invocationEventTargets.add(sink);
    return () => invocationEventTargets.delete(sink);
  };
  const emitInvocationEvent = async (event: SparkInvocationEvent) => {
    await Promise.all([
      options.localEventSink?.(parseSparkDaemonEvent(event.payload)),
      ...[...invocationEventTargets].map(async (sink) => await sink(event)),
    ]);
  };
  const invocationStore = new SparkInvocationStore(options.db);
  const channelReplyDeliveryStore = new ChannelReplyDeliveryStore(options.db, invocationStore);
  channelReplyDeliveryStore.recoverInterrupted();
  recoverInterruptedRuntimeCommandReceipts(options.db);
  if (options.runScheduler !== false) {
    await migrateLegacyQueueHistory({
      db: options.db,
      queueRoot: legacySparkDaemonQueueRoot({ paths: options.paths }),
    });
  }
  const userPaths = resolveSparkUserPaths({ sparkHome: options.sparkHome });
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
              controlSparkHome: userPaths.configRoot,
              channelsSparkHome: userPaths.dataRoot,
              ...(options.modelControl ? { modelControl: options.modelControl } : {}),
              ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
              channelIngress: {
                openReplyStream: async (workspaceId, adapterId, target, streamOptions) =>
                  await channelIngress?.openReplyStream(
                    workspaceId,
                    adapterId,
                    target,
                    streamOptions,
                  ),
                sendReply: async (workspaceId, adapterId, input) => {
                  if (!channelIngress) throw new Error("channel ingress is unavailable");
                  return await channelIngress.sendReply(workspaceId, adapterId, input);
                },
              },
              channelReplyDelivery: channelReplyDeliveryStore,
              interact: (request, task, context) =>
                humanInteractions.interact(request, {
                  sessionId: task.sessionId,
                  invocationId: context.invocationId,
                  sessionSource: sessionSourceForTask(task),
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
          completeInvocation: (invocation, task, completion) =>
            completeInvocationWithChannelDelivery(
              {
                db: options.db,
                invocations: invocationStore,
                deliveries: channelDeliveryStore,
              },
              invocation,
              task,
              completion,
            ),
          emitEvent: emitInvocationEvent,
          concurrency: options.schedulerConcurrency,
          taskTimeoutMs: options.invocationTimeoutMs,
          initiallyAccepting: false,
        });
  let schedulerLoop: Promise<void> | undefined;
  const runSchedulerLoop = async () => {
    while (!runtimeSignal.aborted) {
      const didWork = scheduler?.processBatch() ?? false;
      if (!didWork) await delayUnlessAborted(options.schedulerPollIntervalMs ?? 250, runtimeSignal);
    }
  };
  const stopScheduler = () => scheduler?.stop();
  const stopDirectInvocations = () => invocationRegistry.stop();
  runtimeSignal.addEventListener("abort", stopScheduler, { once: true });
  runtimeSignal.addEventListener("abort", stopDirectInvocations, { once: true });
  const closeRestartAdmission = () => {
    channelAdmissionOpen = false;
    scheduler?.beginDrain();
    invocationRegistry.beginDrain();
  };
  if (options.drainSignal?.aborted) closeRestartAdmission();
  else options.drainSignal?.addEventListener("abort", closeRestartAdmission, { once: true });
  let restartDrain: Promise<void> | undefined;
  let drainProgressTimer: ReturnType<typeof setInterval> | undefined;
  let drainStage: SparkDaemonDrainProgress["stage"] = "active-work";
  const publishDrainProgress = () => {
    if (!options.onDrainProgress) return;
    const progress: SparkDaemonDrainProgress = {
      observedAt: new Date().toISOString(),
      stage: drainStage,
      scheduler: (scheduler?.snapshot() ?? []).map((invocation) => ({
        invocationId: invocation.invocationId,
        kind: invocation.sourceKind ?? "scheduled",
        startedAt: invocation.startedAt ?? invocation.claimedAt ?? invocation.createdAt,
        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
      })),
      direct: invocationRegistry.snapshot().map((invocation) => ({
        invocationId: invocation.invocationId,
        kind: invocation.kind,
        startedAt: invocation.startedAt,
        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
      })),
    };
    try {
      options.onDrainProgress(progress);
    } catch (error) {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    }
  };
  const beginRestartDrain = () => {
    closeRestartAdmission();
    publishDrainProgress();
    if (options.onDrainProgress && !drainProgressTimer) {
      drainProgressTimer = setInterval(publishDrainProgress, 1_000);
      drainProgressTimer.unref();
    }
    restartDrain ??= Promise.all([
      scheduler ? scheduler.wait({ timeoutMs: Number.POSITIVE_INFINITY }) : Promise.resolve(),
      invocationRegistry.waitForIdle(),
    ]).then(async () => {
      // Keep channels alive while active work may still be waiting for an ask
      // response. Once execution is idle, stop transports and flush already-
      // received async admissions before the database is closed.
      try {
        drainStage = "channel-ingress";
        publishDrainProgress();
        await shutdownChannelIngress("restart-drain");
      } finally {
        if (drainProgressTimer) clearInterval(drainProgressTimer);
        drainProgressTimer = undefined;
        runtimeShutdown.abort(options.restartSignal?.reason);
      }
    });
  };
  if (options.restartSignal?.aborted) beginRestartDrain();
  else options.restartSignal?.addEventListener("abort", beginRestartDrain, { once: true });

  const mailStore =
    options.mailStore ??
    new SparkSessionMailStore({
      sparkHome: userPaths.dataRoot,
    });
  let notificationReconcileLoop: Promise<void> | undefined;
  let channelDeliveryReconcileLoop: Promise<void> | undefined;
  let channelReplyReconcileLoop: Promise<void> | undefined;
  let resolveServingLoopGate!: (committed: boolean) => void;
  let servingLoopGateSettled = false;
  const servingLoopGate = new Promise<boolean>((resolve) => {
    resolveServingLoopGate = resolve;
  });
  const settleServingLoopGate = (committed: boolean) => {
    if (servingLoopGateSettled) return;
    servingLoopGateSettled = true;
    resolveServingLoopGate(committed);
  };
  const stopChannelIngress = () => void shutdownChannelIngress("runtime-abort");
  runtimeSignal.addEventListener("abort", stopChannelIngress, { once: true });

  try {
    if (!runtimeSignal.aborted) {
      await options.onReady?.({
        channelIngress,
        respondHumanInteraction: (wait, input) => humanInteractions.respond(wait, input),
      });
    }
    // Prepare channel transports while their synchronous inbound gate remains
    // closed. A message delivered during start is rejected for platform replay
    // and cannot create a durable invocation before the final successor CAS.
    if (channelIngress && !runtimeSignal.aborted && !options.drainSignal?.aborted) {
      await startPreparedChannelIngress(channelIngress, options);
    }

    if (!runtimeSignal.aborted && !options.drainSignal?.aborted) {
      // Prepare recovery and every serving loop before publishing Completed.
      // Loops wait on servingLoopGate, so activating the in-memory gates below
      // cannot process an event before the synchronous filesystem CAS.
      scheduler?.recover();
      scheduler?.activateAdmission();
      invocationRegistry.activateAdmission();
      channelAdmissionOpen = true;
    }
    if (scheduler && !options.once) {
      schedulerLoop = servingLoopGate.then(async (committed) => {
        if (committed && !runtimeSignal.aborted) await runSchedulerLoop();
      });
    }
    if (channelIngress && !options.once) {
      channelDeliveryReconcileLoop = servingLoopGate.then(async (committed) => {
        if (!committed || runtimeSignal.aborted) return;
        await runChannelDeliveryReconcileLoop(
          channelDeliveryStore,
          channelIngress,
          runtimeSignal,
          options.channelDeliveryReconcileIntervalMs ?? 250,
        );
      });
      channelReplyReconcileLoop = servingLoopGate.then(async (committed) => {
        if (!committed || runtimeSignal.aborted) return;
        await runChannelReplyReconcileLoop(
          channelReplyDeliveryStore,
          channelIngress,
          runtimeSignal,
          options.notificationReconcileIntervalMs ?? 1_000,
        );
      });
    }
    if (channelIngress && options.sessionRegistry && !options.once) {
      notificationReconcileLoop = servingLoopGate.then(async (committed) => {
        if (!committed || runtimeSignal.aborted) return;
        await runNotificationReconcileLoop(
          mailStore,
          options.sessionRegistry!,
          channelIngress,
          channelDeliveryStore,
          channelDeliveryOutbox,
          runtimeSignal,
          options.notificationReconcileIntervalMs ?? 1_000,
        );
      });
    }

    // No JavaScript callback can run between opening the synchronous gates and
    // this CAS. If explicit stop wins, onServing aborts the runtime and we close
    // every gate again before releasing the loop promises.
    if (!runtimeSignal.aborted && !options.drainSignal?.aborted) {
      try {
        options.onServing?.();
      } catch (error) {
        closeRestartAdmission();
        runtimeShutdown.abort(error);
        settleServingLoopGate(false);
        throw error;
      }
    }
    const servingCommitted = !runtimeSignal.aborted && !options.drainSignal?.aborted;
    if (!servingCommitted) closeRestartAdmission();
    settleServingLoopGate(servingCommitted);
    if (options.once && !runtimeSignal.aborted) {
      if (scheduler) {
        scheduler.processBatch();
        await scheduler.wait();
      }
      if (channelIngress && !runtimeSignal.aborted) {
        await reconcileDaemonChannelDeliveries(
          {
            store: channelDeliveryStore,
            channelIngress,
            workerId: `daemon-once:${process.pid}`,
          },
          { limit: 100 },
        );
      }
      await runSparkDaemonServerConnectionsOnce({
        ...options,
        signal: runtimeSignal,
        invocationRegistry,
        humanWaits,
        channelIngress: channelIngress ?? undefined,
        registerInvocationEventTarget,
        registerHumanRequestOutboxTarget,
      });
      return;
    }

    await runSparkDaemonUplinkSupervisor({
      ...options,
      signal: runtimeSignal,
      invocationRegistry,
      humanWaits,
      channelIngress: channelIngress ?? undefined,
      registerInvocationEventTarget,
      registerHumanRequestOutboxTarget,
    });
  } finally {
    settleServingLoopGate(false);
    options.signal?.removeEventListener("abort", forwardShutdown);
    options.drainSignal?.removeEventListener("abort", closeRestartAdmission);
    options.restartSignal?.removeEventListener("abort", beginRestartDrain);
    runtimeSignal.removeEventListener("abort", stopScheduler);
    runtimeSignal.removeEventListener("abort", stopDirectInvocations);
    runtimeSignal.removeEventListener("abort", stopChannelIngress);
    if (drainProgressTimer) clearInterval(drainProgressTimer);
    await shutdownChannelIngress("daemon-finally");
    scheduler?.stop();
    await scheduler?.wait();
    await restartDrain;
    await schedulerLoop;
    await channelDeliveryReconcileLoop;
    await notificationReconcileLoop;
    await channelReplyReconcileLoop;
    if (options.managePidFile !== false && existsSync(options.paths.pidFile)) {
      rmSync(options.paths.pidFile, { force: true });
    }
  }
}

async function runChannelReplyReconcileLoop(
  store: ChannelReplyDeliveryStore,
  channelIngress: DaemonChannelIngressRuntime,
  signal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await reconcileChannelReplyDeliveries({ store, channelIngress });
    } catch (error) {
      console.error("[spark-daemon] channel reply reconciliation failed", error);
    }
    await delayUnlessAborted(Math.max(250, Math.floor(intervalMs)), signal);
  }
}

async function runChannelDeliveryReconcileLoop(
  store: SparkChannelDeliveryStore,
  channelIngress: DaemonChannelIngressRuntime,
  signal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  const workerId = `daemon:${process.pid}`;
  while (!signal.aborted) {
    try {
      await reconcileDaemonChannelDeliveries({ store, channelIngress, workerId }, { limit: 50 });
    } catch (error) {
      console.error("[spark-daemon] channel delivery reconciliation failed", error);
    }
    await delayUnlessAborted(Math.max(50, Math.floor(intervalMs)), signal);
  }
}

async function runNotificationReconcileLoop(
  mailStore: SparkSessionMailStore,
  sessionRegistry: DaemonSessionRegistry,
  channelIngress: DaemonChannelIngressRuntime,
  channelDeliveryStore: SparkChannelDeliveryStore,
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox,
  signal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await reconcileSessionNotificationDeliveries({
        mailStore,
        sessionRegistry,
        channelIngress,
        deliveryQueue: {
          store: channelDeliveryStore,
          outbox: channelDeliveryOutbox,
        },
      });
    } catch (error) {
      console.error("[spark-daemon] session notification reconciliation failed", error);
    }
    await delayUnlessAborted(Math.max(250, Math.floor(intervalMs)), signal);
  }
}

function prepareChannelIngress(
  options: StartSparkDaemonOptions,
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox,
): DaemonChannelIngressRuntime | null {
  if (options.once || options.runScheduler === false) return null;
  const userPaths = resolveSparkUserPaths({ sparkHome: options.sparkHome });
  const invocationStore = new SparkInvocationStore(options.db);
  return (
    options.channelIngress ??
    createDaemonChannelIngressRuntime({
      sparkHome: userPaths.dataRoot,
      createWorkspaceTransport: createDaemonChannelTransportFactory(options.db),
      ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
      hooks: {
        onRejectedReply: async (rejected) => {
          await channelDeliveryOutbox.enqueueReply({
            kind: "failure",
            idempotencyKey: rejected.deliveryIdentity,
            invocationId: rejected.deliveryIdentity,
            sessionId: rejected.sessionId,
            workspaceId: rejected.workspaceId,
            adapterId: rejected.adapterId,
            adapterAccountIdentity: rejected.adapterAccountIdentity,
            externalKey: rejected.externalKey,
            target: rejected.target,
            text: rejected.text,
          });
        },
        onAssignment: async (assignment) => {
          if (findChannelInboundInvocation(invocationStore, assignment)) {
            return "duplicate";
          }
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
            channelReply: {
              ...assignment.channelReply,
              adapterAccountIdentity: assignment.adapterAccountIdentity,
            },
            ...(assignment.channelContext ? { channelContext: assignment.channelContext } : {}),
          };
          submitChannelInboundInvocation(invocationStore, assignment, task);
        },
      },
    })
  );
}

async function startPreparedChannelIngress(
  runtime: DaemonChannelIngressRuntime,
  options: StartSparkDaemonOptions,
): Promise<void> {
  try {
    await runtime.start();
  } catch (error) {
    logDaemonError(options.config.runtimeId ?? "unknown", error);
  }
  // Keep the runtime reachable through local RPC even when startup config is
  // absent or invalid so an operator can repair it without restarting daemon.
}

interface SparkDaemonServerConnectionOptions extends StartSparkDaemonOptions {
  invocationRegistry: SparkDaemonInvocationRegistry;
  humanWaits: SparkDaemonHumanWaitRegistry;
  channelIngress?: DaemonChannelIngressRuntime;
  registerInvocationEventTarget?: (
    sink: (event: SparkInvocationEvent) => void | Promise<void>,
  ) => () => void;
  registerHumanRequestOutboxTarget?: (flush: () => void) => () => void;
}

interface DesiredSparkDaemonUplink {
  serverUrl: string;
  config: SparkDaemonConfig;
  fingerprint: string;
}

interface ActiveSparkDaemonUplink {
  controller: AbortController;
  fingerprint: string;
  done: Promise<void>;
}

/**
 * Keep one independently reconnecting projection uplink per Cockpit origin.
 * Workspace rows choose the Cockpit; daemon.toml only supplies daemon identity
 * and the private profile store supplies that origin's runtime credentials.
 */
async function runSparkDaemonUplinkSupervisor(
  options: SparkDaemonServerConnectionOptions,
): Promise<void> {
  const signal = options.signal;
  if (!signal || signal.aborted) return;

  const active = new Map<string, ActiveSparkDaemonUplink>();
  let stopped = false;
  let lastReconcileError: string | undefined;
  const reconcile = (forceServerUrl?: string) => {
    if (stopped || signal.aborted) return;
    let desired: Map<string, DesiredSparkDaemonUplink>;
    try {
      desired = desiredSparkDaemonUplinks(options);
      lastReconcileError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastReconcileError) {
        lastReconcileError = message;
        console.error(`[spark-daemon] Cockpit uplink configuration is invalid: ${message}`);
      }
      return;
    }

    for (const [serverUrl, current] of active) {
      const next = desired.get(serverUrl);
      if (
        !next ||
        next.fingerprint !== current.fingerprint ||
        (forceServerUrl !== undefined &&
          (forceServerUrl === "" || normalizeSparkDaemonServerUrl(forceServerUrl) === serverUrl))
      ) {
        current.controller.abort(new Error(`Spark Cockpit uplink reconfigured for ${serverUrl}`));
      }
    }

    for (const [serverUrl, next] of desired) {
      if (active.has(serverUrl)) continue;
      const controller = new AbortController();
      let entry!: ActiveSparkDaemonUplink;
      const done = runSparkDaemonServerReconnectLoop(options, next.config, controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted && !signal.aborted) {
            logDaemonError(next.config.runtimeId ?? serverUrl, error);
          }
        })
        .finally(() => {
          if (active.get(serverUrl) !== entry) return;
          active.delete(serverUrl);
          if (!stopped && !signal.aborted) queueMicrotask(() => reconcile());
        });
      entry = { controller, fingerprint: next.fingerprint, done };
      active.set(serverUrl, entry);
    }
  };

  const unsubscribeReconfigure = options.uplinkControl?.subscribe((serverUrl) =>
    reconcile(serverUrl ?? ""),
  );
  const poll = setInterval(() => reconcile(), 500);
  const aborted = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  reconcile();
  await aborted;

  stopped = true;
  clearInterval(poll);
  unsubscribeReconfigure?.();
  for (const uplink of active.values()) {
    uplink.controller.abort(signal.reason);
  }
  await Promise.allSettled([...active.values()].map((uplink) => uplink.done));
}

async function runSparkDaemonServerConnectionsOnce(
  options: SparkDaemonServerConnectionOptions,
): Promise<void> {
  if (options.signal?.aborted) return;
  await Promise.allSettled(
    [...desiredSparkDaemonUplinks(options).values()].map(async ({ config }) => {
      await runSparkDaemonServerConnection({ ...options, config });
    }),
  );
}

async function runSparkDaemonServerReconnectLoop(
  options: SparkDaemonServerConnectionOptions,
  config: SparkDaemonConfig,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await runSparkDaemonServerConnection({ ...options, config, signal });
    } catch {
      // Cockpit is an optional projection. A failure on one origin must neither
      // stop local execution nor disturb another origin's healthy uplink.
    }
    if (!signal.aborted) {
      await delayUnlessAborted(options.serverReconnectDelayMs ?? 1_000, signal);
    }
  }
}

function desiredSparkDaemonUplinks(
  options: Pick<SparkDaemonServerConnectionOptions, "paths" | "config" | "db">,
): Map<string, DesiredSparkDaemonUplink> {
  const profiles = new Map<string, SparkDaemonServerProfile>();
  for (const profile of listSparkDaemonServerProfiles(options.paths)) {
    profiles.set(profile.serverUrl, profile);
  }
  const providedProfile = sparkDaemonServerProfileFromConfig(options.config);
  if (providedProfile && !profiles.has(providedProfile.serverUrl)) {
    profiles.set(providedProfile.serverUrl, providedProfile);
  }

  let identity = options.config;
  try {
    const persistedIdentity = readSparkDaemonConfig(options.paths);
    identity = {
      ...options.config,
      installationId: persistedIdentity.installationId,
      displayName: persistedIdentity.displayName,
    };
  } catch {
    // The already-loaded daemon identity remains usable for this process.
  }

  const desired = new Map<string, DesiredSparkDaemonUplink>();
  for (const workspace of listWorkspaces(options.db)) {
    if (!workspace.serverUrl || isUserDetachedWorkspace(workspace)) continue;
    const serverUrl = normalizeSparkDaemonServerUrl(workspace.serverUrl);
    if (desired.has(serverUrl)) continue;
    const profile = profiles.get(serverUrl);
    if (!profile) continue;
    const config = sparkDaemonConfigForServerProfile(identity, profile);
    if (!canAttemptServerConnection(config)) continue;
    desired.set(serverUrl, {
      serverUrl,
      config,
      fingerprint: sparkDaemonServerProfileFingerprint(profile),
    });
  }
  return desired;
}

function sparkDaemonServerProfileFingerprint(profile: SparkDaemonServerProfile): string {
  return JSON.stringify([
    profile.serverUrl,
    profile.runtimeId ?? null,
    profile.runtimeToken ?? null,
    profile.runtimeTokenExpiresAt ?? null,
    profile.refreshToken ?? null,
    profile.refreshTokenExpiresAt ?? null,
    profile.webSocketUrl ?? null,
  ]);
}

async function runSparkDaemonServerConnection(
  options: SparkDaemonServerConnectionOptions,
): Promise<void> {
  const userPaths = resolveSparkUserPaths({ sparkHome: options.sparkHome });
  let config = shouldRefreshSparkDaemonToken(options.config)
    ? await refreshSparkDaemonCredentials({
        paths: options.paths,
        config: options.config,
        ...(options.signal ? { signal: options.signal } : {}),
      })
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
    let unregisterInvocationEventTarget: (() => void) | undefined;
    let unregisterHumanRequestOutboxTarget: (() => void) | undefined;
    let runtimeReady = false;
    let inFlightInvocationEvent:
      | { messageId: string; invocationId: string; sequence: number }
      | undefined;
    const invocationStore = new SparkInvocationStore(options.db);
    const deliveryDestination = `cockpit:${runtimeId}`;
    const currentWorkspaceBindingIds = () =>
      serverUrl
        ? listWorkspacesForServer(options.db, serverUrl).map((workspace) => workspace.id)
        : [];
    const activeHandlers = new Set<Promise<void>>();
    const scheduleTokenRefresh = (delayMs = nextSparkDaemonTokenRefreshDelayMs(config)) => {
      if (options.signal?.aborted || delayMs === undefined) {
        return;
      }
      tokenRefresh = setTimeout(() => {
        void refreshAndRescheduleToken();
      }, delayMs);
    };
    const refreshAndRescheduleToken = async () => {
      try {
        config = await refreshSparkDaemonCredentials({
          paths: options.paths,
          config,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (options.signal?.aborted) return;
        scheduleTokenRefresh();
      } catch (error) {
        if (options.signal?.aborted) return;
        logDaemonError(runtimeId, error);
        scheduleTokenRefresh(tokenRefreshRetryDelayMs());
      }
    };
    scheduleTokenRefresh();

    const detachInvocationEventTarget = () => {
      unregisterInvocationEventTarget?.();
      unregisterInvocationEventTarget = undefined;
    };

    const detachHumanRequestOutboxTarget = () => {
      unregisterHumanRequestOutboxTarget?.();
      unregisterHumanRequestOutboxTarget = undefined;
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
      const pending = invocationStore.pendingDeliveries(
        deliveryDestination,
        1,
        currentWorkspaceBindingIds(),
      )[0];
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
      unregisterInvocationEventTarget = options.registerInvocationEventTarget?.(() =>
        flushNextInvocationEvent(),
      );
      sendJson(ws, {
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "runtime.hello",
        sentAt: new Date().toISOString(),
        payload: {
          runtimeId,
          runtimeVersion: sparkDaemonVersion,
          supportedFeatures: sparkDaemonSupportedFeatures,
          workspaceBindings: serverUrl
            ? reconcileWorkspacesForServer(options.db, serverUrl).map(workspaceSummary)
            : [],
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
        serverUrl: serverUrl ?? undefined,
        runSparkCommand: options.runSparkCommand ?? runSparkCommandBridge,
        cancelSparkInvocation: options.cancelSparkInvocation ?? cancelSparkBridgeInvocation,
        controlSparkHome: userPaths.configRoot,
        ...(options.modelControl ? { modelControl: options.modelControl } : {}),
        ...(options.channelIngress ? { channelIngress: options.channelIngress } : {}),
        ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
        invocationRegistry: options.invocationRegistry,
        humanWaits: options.humanWaits,
        onRuntimeReady() {
          runtimeReady = true;
          flushPendingRuntimeCommandTerminals(ws, options.db, runtimeId, serverUrl);
          flushNextInvocationEvent();
        },
        onIngestAck(ackOf) {
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
          if (!unregisterHumanRequestOutboxTarget) {
            unregisterHumanRequestOutboxTarget = options.registerHumanRequestOutboxTarget?.(() =>
              flushPendingHumanRequests(ws, options.humanWaits, runtimeId, serverUrl),
            );
          }
          flushPendingHumanRequests(ws, options.humanWaits, runtimeId, serverUrl);
          if (heartbeat) {
            return;
          }
          heartbeat = setInterval(() => {
            sendHeartbeat(ws, options.db, runtimeId, runtimeSessionId, serverUrl);
            flushPendingHumanRequests(ws, options.humanWaits, runtimeId, serverUrl);
          }, intervalMs);
          sendHeartbeat(ws, options.db, runtimeId, runtimeSessionId, serverUrl);
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
  serverUrl?: string;
  sparkHome?: string;
  controlSparkHome?: string;
  runtimeSessionId: string | undefined;
  setRuntimeSessionId(value: string): void;
  ensureHeartbeat(intervalMs: number): void;
  runSparkCommand: RunSparkCommandFn;
  cancelSparkInvocation: CancelSparkInvocationFn;
  invocationRegistry?: SparkDaemonInvocationRegistry;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  modelControl?: SparkDaemonModelControl;
  channelIngress?: DaemonChannelIngressRuntime;
  sessionRegistry?: DaemonSessionRegistry;
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
  const humanRequestId = input.humanRequestId ?? createId("hreq");
  const envelope = runtimeEnvelope(
    "human.request.created",
    {
      kind: input.kind,
      delivery: input.delivery ?? "blocking",
      interactionRequestId: input.interactionRequestId || undefined,
      sessionId: input.sessionId || undefined,
      toolCallId: input.toolCallId || undefined,
      title: input.title,
      prompt: input.prompt,
      questions: input.questions ?? [],
      context: input.context ?? {},
      contextArtifactRefs: input.contextArtifactRefs ?? [],
    },
    {
      runtimeId: context.runtimeId,
      workspaceBindingId: input.workspaceBindingId || undefined,
      workspaceId: input.workspaceId || undefined,
      projectId: input.projectId || undefined,
      humanRequestId,
      invocationId: input.invocationId || undefined,
    },
  );
  const registration = context.humanWaits.register(
    { ...input, humanRequestId },
    { messageId: envelope.messageId, kind: "human.request.created", envelope },
  );
  if (outboundEnvelopeMatchesServer(context.db, envelope, context.serverUrl ?? null)) {
    sendJson(ws, envelope);
  }
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
    const route = { runtimeId: context.runtimeId, serverUrl: context.serverUrl ?? null };
    context.humanWaits?.acknowledgeOutboxForRoute(value.ackOf, route);
    acknowledgeRuntimeCommandTerminalForRoute(context.db, value.ackOf, route);
    context.onIngestAck?.(value.ackOf);
    return;
  }

  const ephemeralSecret = serverEphemeralSecretRequestEnvelopeSchema.safeParse(value);
  if (ephemeralSecret.success) {
    await handleEphemeralSecretRequest(ws, ephemeralSecret.data, context);
    return;
  }

  const command = serverCommandEnvelopeSchema.safeParse(value);
  if (command.success) {
    await handleCommand(ws, command.data, context);
    return;
  }

  const humanResponse = humanResponseDeliverEnvelopeSchema.safeParse(value);
  if (humanResponse.success) {
    const wait = humanResponse.data.humanRequestId
      ? context.humanWaits?.get(humanResponse.data.humanRequestId)
      : null;
    const routeFailure = wait
      ? humanResponseRouteFailure(humanResponse.data, wait, context)
      : undefined;
    const delivery: SparkDaemonHumanWaitDeliveryResult = routeFailure
      ? {
          outcome: "unknown_request",
          retryable: false,
          returnedToTool: false,
          message: routeFailure,
        }
      : (context.humanWaits?.deliver({
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
        });
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

function humanResponseRouteFailure(
  response: ReturnType<typeof humanResponseDeliverEnvelopeSchema.parse>,
  wait: SparkDaemonHumanWaitRecord,
  context: Pick<MessageContext, "db" | "runtimeId" | "serverUrl">,
): string | undefined {
  if (response.runtimeId !== context.runtimeId) {
    return "Human response runtime does not match this daemon uplink.";
  }
  if (
    wait.workspaceBindingId &&
    (!context.serverUrl ||
      !workspaceBindingBelongsToServer(context.db, wait.workspaceBindingId, context.serverUrl) ||
      !daemonWorkspaceRouteMatches(
        context.db,
        wait.workspaceBindingId,
        wait.workspaceId,
        wait.workspaceBindingId,
      ))
  ) {
    return "Human response was delivered through a Cockpit that does not own this wait.";
  }
  if (
    (response.workspaceBindingId ?? "") !== wait.workspaceBindingId ||
    (response.workspaceId ?? "") !== wait.workspaceId ||
    (response.projectId ?? "") !== wait.projectId ||
    (response.invocationId !== undefined && response.invocationId !== wait.invocationId)
  ) {
    return "Human response route does not match the daemon-owned wait.";
  }
  return undefined;
}

async function handleEphemeralSecretRequest(
  ws: ServerSocket,
  request: ReturnType<typeof serverEphemeralSecretRequestEnvelopeSchema.parse>,
  context: MessageContext,
): Promise<void> {
  if (request.runtimeId !== context.runtimeId) {
    sendEphemeralSecretFailure(ws, request, "RUNTIME_ID_MISMATCH");
    return;
  }
  if (request.csrfVerified !== true || !request.actorUserId || !request.browserRequestId) {
    sendEphemeralSecretFailure(ws, request, "SECRET_BROWSER_CONTEXT_INVALID");
    return;
  }
  if (Date.parse(request.expiresAt) <= Date.now()) {
    sendEphemeralSecretFailure(ws, request, "SECRET_REQUEST_EXPIRED");
    return;
  }
  if (request.payload.operation === "channel.configure") {
    const workspace = request.workspaceBindingId
      ? getWorkspaceById(context.db, request.workspaceBindingId)
      : null;
    if (
      !workspace ||
      !context.serverUrl ||
      !workspaceBindingBelongsToServer(context.db, workspace.id, context.serverUrl) ||
      !daemonWorkspaceRouteMatches(
        context.db,
        workspace.id,
        request.workspaceId,
        request.workspaceBindingId,
      ) ||
      request.payload.workspaceId !== request.workspaceId
    ) {
      sendEphemeralSecretFailure(ws, request, "SECRET_ROUTE_INVALID");
      return;
    }
  }

  const result = await executeSparkDaemonEphemeralSecretControl(
    {
      modelControl: context.modelControl,
      channelIngress: context.channelIngress,
      sparkHome: context.sparkHome,
    },
    request.payload,
  );
  sendJson(
    ws,
    runtimeEphemeralSecretResultEnvelopeSchema.parse({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.ephemeral_secret.result",
      sentAt: new Date().toISOString(),
      runtimeId: context.runtimeId,
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(request.workspaceBindingId ? { workspaceBindingId: request.workspaceBindingId } : {}),
      ephemeralRequestId: request.ephemeralRequestId,
      payload: result,
    }),
  );
}

function daemonWorkspaceRouteMatches(
  db: DatabaseSync,
  localWorkspaceId: string,
  serverWorkspaceId: string | undefined,
  serverBindingId: string | undefined,
): boolean {
  if (!serverWorkspaceId || !serverBindingId) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM daemon_workspaces
         WHERE id = ? AND server_workspace_id = ? AND server_binding_id = ?
         LIMIT 1`,
      )
      .get(localWorkspaceId, serverWorkspaceId, serverBindingId),
  );
}

function sendEphemeralSecretFailure(
  ws: ServerSocket,
  request: ReturnType<typeof serverEphemeralSecretRequestEnvelopeSchema.parse>,
  reasonCode: string,
): void {
  sendJson(
    ws,
    runtimeEphemeralSecretResultEnvelopeSchema.parse({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.ephemeral_secret.result",
      sentAt: new Date().toISOString(),
      runtimeId: request.runtimeId,
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(request.workspaceBindingId ? { workspaceBindingId: request.workspaceBindingId } : {}),
      ephemeralRequestId: request.ephemeralRequestId,
      payload: {
        operation: request.payload.operation,
        status: "failed",
        reasonCode,
        message: "Spark daemon rejected the ephemeral secret request.",
        completedAt: new Date().toISOString(),
      },
    }),
  );
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
  if (
    command.workspaceBindingId &&
    context.serverUrl &&
    !workspaceBindingBelongsToServer(context.db, command.workspaceBindingId, context.serverUrl)
  ) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "WORKSPACE_ROUTE_MISMATCH",
          message: "Command workspace route does not belong to this Cockpit uplink.",
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

  const durableSocket = runtimeCommandReceiptSocket(ws, context.db, commandId, claim.claimToken);
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
    (context.serverUrl
      ? listWorkspacesForServer(context.db, context.serverUrl)
      : listWorkspaces(context.db)
    ).map((workspace) => workspace.id),
  );
  const commandWorkspace = command.workspaceBindingId
    ? getWorkspaceById(context.db, command.workspaceBindingId)
    : null;
  const route = commandRoute(context.runtimeId, command);
  if (
    commandWorkspace &&
    !daemonWorkspaceRouteMatches(
      context.db,
      commandWorkspace.id,
      command.workspaceId,
      command.workspaceBindingId,
    )
  ) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "WORKSPACE_ROUTE_MISMATCH",
          message: "Command workspace route does not match this daemon binding.",
          retryable: false,
        },
        route,
      ),
    );
    return;
  }
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

  if (isSparkDaemonModelChannelPublicKind(sparkCommand.kind)) {
    const executed = await executeSparkDaemonModelChannelPublicControl(
      {
        modelControl: context.modelControl,
        channelIngress: context.channelIngress,
        sessionRegistry: context.sessionRegistry,
        sparkHome: context.sparkHome,
      },
      {
        kind: sparkCommand.kind,
        scope: command.workspaceBindingId ? "workspace" : "daemon",
        workspaceId: command.workspaceId,
        payload: sparkCommand.payload,
      },
    );
    sendJson(ws, commandAck({ accepted: true }, route));
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: executed.result,
          ...(executed.projection ? { projection: executed.projection } : {}),
          completedAt: new Date().toISOString(),
        },
        route,
      ),
    );
    return;
  }

  if (isRuntimeSessionControlKind(sparkCommand.kind)) {
    const scope = command.workspaceBindingId ? "workspace" : "daemon";
    const executed = await executeSparkDaemonSessionControl(
      {
        paths: context.paths,
        db: context.db,
        sessionRegistry: context.sessionRegistry,
        modelControl: context.modelControl,
        actor: "spark-daemon-runtime-ws",
      },
      {
        kind: sparkCommand.kind,
        scope,
        workspaceId: command.workspaceId,
        workspaceBindingId: command.workspaceBindingId,
        sessionId: command.sessionId,
        idempotencyKey: command.idempotencyKey,
        payload: sparkCommand.payload,
      },
    );
    const resultRoute = {
      ...route,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(executed.invocationId ? { invocationId: executed.invocationId } : {}),
    };
    sendJson(
      ws,
      commandAck(
        {
          accepted: true,
          ...(executed.invocationId ? { invocationId: executed.invocationId } : {}),
        },
        resultRoute,
      ),
    );
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: executed.result,
          ...(executed.projection ? { projection: executed.projection } : {}),
          completedAt: new Date().toISOString(),
        },
        resultRoute,
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
            workspaces: workspaceSummaries(context.db, context.serverUrl),
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
      ...((context.controlSparkHome ?? context.sparkHome)
        ? { controlSparkHome: context.controlSparkHome ?? context.sparkHome }
        : {}),
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

function isRuntimeSessionControlKind(
  kind: SparkCommand["kind"],
): kind is Parameters<typeof executeSparkDaemonSessionControl>[1]["kind"] {
  return (
    kind === "session.list.request" ||
    kind === "session.get.request" ||
    kind === "session.snapshot.request" ||
    kind === "session.create.request" ||
    kind === "session.bind.request" ||
    kind === "session.unbind.request" ||
    kind === "session.archive.request" ||
    kind === "turn.submit.request" ||
    kind === "turn.cancel.request" ||
    kind === "turn.status.request" ||
    kind === "turn.stream.subscribe"
  );
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
  if (
    workspaceBindingId &&
    context.serverUrl &&
    !workspaceBindingBelongsToServer(context.db, workspaceBindingId, context.serverUrl)
  ) {
    return null;
  }
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
    sessionId: event.sessionId,
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

function flushPendingHumanRequests(
  ws: WebSocket,
  waits: SparkDaemonHumanWaitRegistry,
  runtimeId: string,
  serverUrl: string | null,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  for (const entry of waits.listPendingOutboxForRoute({ runtimeId, serverUrl })) {
    sendJson(ws, entry.envelope);
  }
}

function outboundEnvelopeMatchesServer(
  db: DatabaseSync,
  envelope: unknown,
  serverUrl: string | null,
): boolean {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  const workspaceBindingId = (envelope as Record<string, unknown>).workspaceBindingId;
  if (typeof workspaceBindingId !== "string" || !workspaceBindingId.trim() || !serverUrl) {
    return true;
  }
  return workspaceBindingBelongsToServer(db, workspaceBindingId, serverUrl);
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

function flushPendingRuntimeCommandTerminals(
  ws: ServerSocket,
  db: DatabaseSync,
  runtimeId: string,
  serverUrl: string | null,
): void {
  for (const terminal of pendingRuntimeCommandTerminalsForRoute(db, { runtimeId, serverUrl })) {
    sendJson(ws, markCommandResultReplayed(terminal));
  }
}

function runtimeCommandReceiptSocket(
  ws: ServerSocket,
  db: DatabaseSync,
  commandId: string,
  claimToken: string,
): ServerSocket {
  return {
    send(data) {
      const value = JSON.parse(data) as { type?: unknown };
      if (value.type === "runtime.command.ack") {
        if (recordRuntimeCommandAck(db, commandId, value, undefined, claimToken)) {
          trySendJsonString(ws, data);
        }
        return;
      }
      if (value.type === "runtime.command.reject") {
        if (
          recordRuntimeCommandTerminal(db, {
            commandId,
            status: "rejected",
            envelope: value,
            claimToken,
          })
        ) {
          trySendJsonString(ws, data);
        }
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
        if (
          recordRuntimeCommandTerminal(db, {
            commandId,
            status: terminal.payload.status,
            envelope: terminal,
            claimToken,
          })
        ) {
          trySendJsonString(ws, JSON.stringify(terminal));
        }
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
    sessionId: command.sessionId,
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
    ...(typeof route.sessionId === "string" ? { sessionId: route.sessionId } : {}),
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
    channelDeliveries: new SparkChannelDeliveryStore(context.db).summary(),
    workspaceCount: listWorkspaces(context.db).length,
    observedAt: new Date().toISOString(),
  });
}

function sendHeartbeat(
  ws: WebSocket,
  db: DatabaseSync,
  runtimeId: string,
  runtimeSessionId: string | undefined,
  serverUrl: string | null,
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
      workspaceBindings: serverUrl
        ? reconcileWorkspacesForServer(db, serverUrl).map(workspaceSummary)
        : [],
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
      workspaceBindings: context.serverUrl
        ? reconcileWorkspacesForServer(context.db, context.serverUrl).map(workspaceSummary)
        : [],
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
