import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import {
  createId,
  parseSparkDaemonEvent,
  runtimeProtocolVersion,
  sparkProtocolJsonObjectSchema,
  type SparkDaemonEvent,
  type SparkJsonObject,
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
} from "./core/human-waits.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import {
  invocationUpdated,
  reconcileReport,
  runtimeEnvelope,
  workspaceSnapshot,
  type RouteContext,
} from "./protocol/outbound.js";
import { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import {
  pendingRuntimeCommandTerminalsForRoute,
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
  applyCockpitWorkspaceBindingAssignments,
  getWorkspaceById,
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
  runSparkCommandBridge,
  cancelSparkBridgeInvocation,
  type RunSparkCommandFn,
  type CancelSparkInvocationFn,
} from "./spark/bridge.js";
import { createChannelAwareTaskExecutor, sessionSourceForTask } from "./spark/session-run.js";
import { reconcileSessionNotificationDeliveries } from "./session-notification-delivery.ts";
import { notifySessionRequestCompletion } from "./session-request-completion-notify.ts";
import {
  nextSparkDaemonTokenRefreshDelayMs,
  refreshSparkDaemonCredentials,
  shouldRefreshSparkDaemonToken,
  tokenRefreshRetryDelayMs,
} from "./token-refresh.js";
import {
  buildReconcileReport,
  createDaemonHumanWait,
  flushPendingHumanRequests,
  flushPendingRuntimeCommandTerminals,
  handleServerMessage,
  logDaemonError,
  rawDataToText,
  requireConfig,
  resolveWebSocketUrl,
  runtimeEnvelopeForInvocationEvent,
  sendHeartbeat,
  sendJson,
  serverUrlForConfig,
  sparkDaemonSupportedFeatures,
  sparkDaemonVersion,
  toWebSocketUrl,
  workspaceSummary,
  type MessageContext,
  type ServerSocket,
  type StartSparkDaemonOptions,
  type SparkDaemonUplinkControl,
} from "./daemon.ts";

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
          completeInvocation: (invocation, task, completion) => {
            const completed = completeInvocationWithChannelDelivery(
              {
                db: options.db,
                invocations: invocationStore,
                deliveries: channelDeliveryStore,
              },
              invocation,
              task,
              completion,
            );
            if (options.sessionRegistry) {
              void notifySessionRequestCompletion(
                {
                  invocationStore,
                  sessionRegistry: options.sessionRegistry,
                  ...(options.modelControl ? { modelControl: options.modelControl } : {}),
                  resolveWorkspaceCwd: (workspaceId) =>
                    resolveWorkspaceLocalPath(options.db, workspaceId),
                  canAdmit: () => channelAdmissionOpen && !runtimeSignal.aborted,
                },
                { invocation, task, completion },
              ).catch((error) => {
                console.error("[spark-daemon] session request completion notify failed", error);
              });
            }
            return completed;
          },
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
        flushHumanRequestOutbox,
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
    if (!profile || profile.parked) continue;
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
    profile.parked === true,
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
        ? listWorkspacesForServer(options.db, serverUrl).flatMap((workspace) =>
            workspace.serverBindingId && workspace.serverBindingId !== workspace.id
              ? [workspace.id, workspace.serverBindingId]
              : [workspace.id],
          )
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
