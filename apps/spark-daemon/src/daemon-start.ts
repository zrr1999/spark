import { existsSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import {
  createId,
  parseSparkDaemonEvent,
  runtimeProtocolVersion,
} from "@zendev-lab/spark-protocol";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { resolveSparkUserPaths, writePrivateFile } from "@zendev-lab/spark-system";
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
  type SparkDaemonHumanInteractionOpened,
  type SparkDaemonTask,
  type SparkInvocationSchedulerOptions,
} from "./core/index.ts";
import { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import { recoverInterruptedRuntimeCommandReceipts } from "./runtime-command-receipts.ts";
import { migrateLegacyQueueHistory } from "./store/legacy-queue-migration.ts";
import { SparkChannelDeliveryStore } from "./store/channel-deliveries.ts";
import {
  SparkInvocationStore,
  type CompleteSparkInvocationInput,
  type SparkInvocationEvent,
  type SparkInvocationRecord,
} from "./store/invocations.ts";
import {
  getWorkspaceById,
  isUserDetachedWorkspace,
  listWorkspaces,
  listWorkspacesForServer,
  markSparkDaemonServerConnected,
  markSparkDaemonServerDisconnected,
  reconcileWorkspaces,
  reconcileWorkspacesForServer,
  resolveWorkspaceLocalPath,
} from "./store/workspaces.js";
import { runSparkCommandBridge, cancelSparkBridgeInvocation } from "./spark/bridge.js";
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
  workspaceSummary,
  type StartSparkDaemonOptions,
} from "./daemon.ts";

export async function startSparkDaemon(options: StartSparkDaemonOptions): Promise<void> {
  const runtime = await createPreparedDaemonRuntime(options);
  try {
    await prepareDaemonServing(runtime);
    if (options.once && !runtime.runtimeSignal.aborted) {
      await runDaemonOnce(runtime);
      return;
    }
    await runSparkDaemonUplinkSupervisor(daemonServerConnectionOptions(runtime));
  } finally {
    await cleanupPreparedDaemonRuntime(runtime);
  }
}

interface InvocationEventHub {
  emit(event: SparkInvocationEvent): Promise<void>;
  register(sink: (event: SparkInvocationEvent) => void | Promise<void>): () => boolean;
}

interface ServingLoopGate {
  promise: Promise<boolean>;
  settle(committed: boolean): void;
}

interface DaemonServingLoops {
  scheduler?: Promise<void>;
  channelDelivery?: Promise<void>;
  channelReply?: Promise<void>;
  notification?: Promise<void>;
}

interface RestartDrainController {
  dispose(): void;
  wait(): Promise<void> | undefined;
}

interface PreparedDaemonRuntime {
  options: StartSparkDaemonOptions;
  runtimeShutdown: AbortController;
  runtimeSignal: AbortSignal;
  removeShutdownForwarder: () => void;
  invocationRegistry: SparkDaemonInvocationRegistry;
  humanWaits: SparkDaemonHumanWaitRegistry;
  channelDeliveryStore: SparkChannelDeliveryStore;
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox;
  channelIngress: DaemonChannelIngressRuntime | null;
  shutdownChannelIngress: ReturnType<typeof createChannelIngressShutdown>;
  admission: { open: boolean };
  closeRestartAdmission: () => void;
  flushHumanRequestOutbox: () => void;
  humanInteractions: SparkDaemonHumanInteractionBroker;
  registerHumanRequestOutboxTarget: (flush: () => void) => () => boolean;
  eventHub: InvocationEventHub;
  invocationStore: SparkInvocationStore;
  channelReplyDeliveryStore: ChannelReplyDeliveryStore;
  scheduler: SparkInvocationScheduler | null;
  mailStore: SparkSessionMailStore;
  servingGate: ServingLoopGate;
  loops: DaemonServingLoops;
  restartDrain: RestartDrainController;
  stopScheduler: () => void;
  stopDirectInvocations: () => void;
  stopChannelIngress: () => void;
}

async function createPreparedDaemonRuntime(
  options: StartSparkDaemonOptions,
): Promise<PreparedDaemonRuntime> {
  const { runtimeShutdown, runtimeSignal, removeShutdownForwarder } =
    createDaemonRuntimeSignal(options);
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
  const shutdownChannelIngress = createChannelIngressShutdown(channelIngress, options);
  const admission = { open: false };
  channelIngress?.setInboundHandler?.(({ workspaceId, message }) => {
    if (!admission.open) {
      throw new Error("Spark daemon channel admission is closed during startup or drain");
    }
    channelDeliveryOutbox.enqueueInbound({ workspaceId, message });
  });
  const humanRequestOutboxTargets = new Set<() => void>();
  const flushHumanRequestOutbox = () => {
    for (const flush of humanRequestOutboxTargets) flush();
  };
  const getRuntimeIdForServer = createRuntimeIdForServer(options);
  const getRuntimeId = (route: { serverUrl: string }) => getRuntimeIdForServer(route.serverUrl);
  const { humanInteractions, registerHumanRequestOutboxTarget } = configureHumanInteractions({
    options,
    channelIngress,
    humanWaits,
    channelDeliveryOutbox,
    getRuntimeId,
    getRuntimeIdForServer,
    flushHumanRequestOutbox,
    humanRequestOutboxTargets,
  });
  const eventHub = createInvocationEventHub(options);
  const invocationStore = new SparkInvocationStore(options.db);
  const channelReplyDeliveryStore = new ChannelReplyDeliveryStore(options.db, invocationStore);
  channelReplyDeliveryStore.recoverInterrupted();
  recoverInterruptedRuntimeCommandReceipts(options.db);
  await migrateLegacyInvocationHistory(options);
  const userPaths = resolveSparkUserPaths({ sparkHome: options.sparkHome });
  const scheduler = createDaemonScheduler({
    options,
    runtimeSignal,
    admission,
    invocationStore,
    channelDeliveryStore,
    channelIngress,
    channelReplyDeliveryStore,
    humanInteractions,
    eventHub,
    controlSparkHome: userPaths.configRoot,
    channelsSparkHome: userPaths.dataRoot,
  });
  const closeRestartAdmission = () => {
    admission.open = false;
    scheduler?.beginDrain();
    invocationRegistry.beginDrain();
  };
  registerDrainAdmissionGate(options, closeRestartAdmission);
  const restartDrain = createRestartDrainController({
    options,
    scheduler,
    invocationRegistry,
    runtimeShutdown,
    shutdownChannelIngress,
    closeRestartAdmission,
  });
  const servingGate = createServingLoopGate();
  const stopScheduler = () => scheduler?.stop();
  const stopDirectInvocations = () => invocationRegistry.stop();
  const stopChannelIngress = () => void shutdownChannelIngress("runtime-abort");
  runtimeSignal.addEventListener("abort", stopScheduler, { once: true });
  runtimeSignal.addEventListener("abort", stopDirectInvocations, { once: true });
  runtimeSignal.addEventListener("abort", stopChannelIngress, { once: true });
  return {
    options,
    runtimeShutdown,
    runtimeSignal,
    removeShutdownForwarder,
    invocationRegistry,
    humanWaits,
    channelDeliveryStore,
    channelDeliveryOutbox,
    channelIngress,
    shutdownChannelIngress,
    admission,
    closeRestartAdmission,
    flushHumanRequestOutbox,
    humanInteractions,
    registerHumanRequestOutboxTarget,
    eventHub,
    invocationStore,
    channelReplyDeliveryStore,
    scheduler,
    mailStore:
      options.mailStore ??
      new SparkSessionMailStore({
        sparkHome: userPaths.dataRoot,
      }),
    servingGate,
    loops: {},
    restartDrain,
    stopScheduler,
    stopDirectInvocations,
    stopChannelIngress,
  };
}

function createInvocationEventHub(options: StartSparkDaemonOptions): InvocationEventHub {
  const invocationEventTargets = new Set<(event: SparkInvocationEvent) => void | Promise<void>>();
  return {
    register(sink) {
      invocationEventTargets.add(sink);
      return () => invocationEventTargets.delete(sink);
    },
    async emit(event) {
      await Promise.all([
        options.localEventSink?.(parseSparkDaemonEvent(event.payload)),
        ...[...invocationEventTargets].map(async (sink) => await sink(event)),
      ]);
    },
  };
}

async function migrateLegacyInvocationHistory(options: StartSparkDaemonOptions): Promise<void> {
  if (options.runScheduler !== false) {
    await migrateLegacyQueueHistory({
      db: options.db,
      queueRoot: legacySparkDaemonQueueRoot({ paths: options.paths }),
    });
  }
}

function registerDrainAdmissionGate(
  options: StartSparkDaemonOptions,
  closeRestartAdmission: () => void,
): void {
  if (options.drainSignal?.aborted) closeRestartAdmission();
  else options.drainSignal?.addEventListener("abort", closeRestartAdmission, { once: true });
}

function createRestartDrainController(input: {
  options: StartSparkDaemonOptions;
  scheduler: SparkInvocationScheduler | null;
  invocationRegistry: SparkDaemonInvocationRegistry;
  runtimeShutdown: AbortController;
  shutdownChannelIngress: ReturnType<typeof createChannelIngressShutdown>;
  closeRestartAdmission: () => void;
}): RestartDrainController {
  const { options, scheduler, invocationRegistry, runtimeShutdown, shutdownChannelIngress } = input;
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
    input.closeRestartAdmission();
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
  return {
    dispose() {
      options.restartSignal?.removeEventListener("abort", beginRestartDrain);
      if (drainProgressTimer) clearInterval(drainProgressTimer);
    },
    wait: () => restartDrain,
  };
}

function createServingLoopGate(): ServingLoopGate {
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
  return { promise: servingLoopGate, settle: settleServingLoopGate };
}

async function prepareDaemonServing(runtime: PreparedDaemonRuntime): Promise<void> {
  const { options, runtimeSignal, channelIngress } = runtime;
  if (!runtimeSignal.aborted) {
    await options.onReady?.({
      channelIngress,
      respondHumanInteraction: (wait, input) => runtime.humanInteractions.respond(wait, input),
      flushHumanRequestOutbox: runtime.flushHumanRequestOutbox,
    });
  }
  if (channelIngress && canOpenDaemonAdmission(runtime)) {
    await startPreparedChannelIngress(channelIngress, options);
  }
  if (canOpenDaemonAdmission(runtime)) activateDaemonAdmission(runtime);
  startDaemonServingLoops(runtime);
  commitDaemonServingFence(runtime);
}

function canOpenDaemonAdmission(runtime: PreparedDaemonRuntime): boolean {
  return !runtime.runtimeSignal.aborted && !runtime.options.drainSignal?.aborted;
}

function activateDaemonAdmission(runtime: PreparedDaemonRuntime): void {
  runtime.scheduler?.recover();
  runtime.scheduler?.activateAdmission();
  runtime.invocationRegistry.activateAdmission();
  runtime.admission.open = true;
}

function startDaemonServingLoops(runtime: PreparedDaemonRuntime): void {
  const { scheduler, channelIngress, options, runtimeSignal, servingGate, loops } = runtime;
  if (scheduler && !options.once) {
    loops.scheduler = servingGate.promise.then(async (committed) => {
      if (committed && !runtimeSignal.aborted) await runSchedulerLoop(runtime);
    });
  }
  if (channelIngress && !options.once) {
    loops.channelDelivery = servingGate.promise.then(async (committed) => {
      if (!committed || runtimeSignal.aborted) return;
      await runChannelDeliveryReconcileLoop(
        runtime.channelDeliveryStore,
        channelIngress,
        runtimeSignal,
        options.channelDeliveryReconcileIntervalMs ?? 250,
      );
    });
    loops.channelReply = servingGate.promise.then(async (committed) => {
      if (!committed || runtimeSignal.aborted) return;
      await runChannelReplyReconcileLoop(
        runtime.channelReplyDeliveryStore,
        channelIngress,
        runtimeSignal,
        options.notificationReconcileIntervalMs ?? 1_000,
      );
    });
  }
  if (channelIngress && options.sessionRegistry && !options.once) {
    loops.notification = servingGate.promise.then(async (committed) => {
      if (!committed || runtimeSignal.aborted) return;
      await runNotificationReconcileLoop(
        runtime.mailStore,
        options.sessionRegistry!,
        channelIngress,
        runtime.channelDeliveryStore,
        runtime.channelDeliveryOutbox,
        runtimeSignal,
        options.notificationReconcileIntervalMs ?? 1_000,
      );
    });
  }
}

function commitDaemonServingFence(runtime: PreparedDaemonRuntime): void {
  if (canOpenDaemonAdmission(runtime)) {
    try {
      runtime.options.onServing?.();
    } catch (error) {
      runtime.closeRestartAdmission();
      runtime.runtimeShutdown.abort(error);
      runtime.servingGate.settle(false);
      throw error;
    }
  }
  const servingCommitted = canOpenDaemonAdmission(runtime);
  if (!servingCommitted) runtime.closeRestartAdmission();
  runtime.servingGate.settle(servingCommitted);
}

async function runSchedulerLoop(runtime: PreparedDaemonRuntime): Promise<void> {
  while (!runtime.runtimeSignal.aborted) {
    const didWork = runtime.scheduler?.processBatch() ?? false;
    if (!didWork) {
      await delayUnlessAborted(
        runtime.options.schedulerPollIntervalMs ?? 250,
        runtime.runtimeSignal,
      );
    }
  }
}

async function runDaemonOnce(runtime: PreparedDaemonRuntime): Promise<void> {
  const { scheduler, channelIngress, runtimeSignal } = runtime;
  if (scheduler) {
    scheduler.processBatch();
    await scheduler.wait();
  }
  if (channelIngress && !runtimeSignal.aborted) {
    await reconcileDaemonChannelDeliveries(
      {
        store: runtime.channelDeliveryStore,
        channelIngress,
        workerId: `daemon-once:${process.pid}`,
      },
      { limit: 100 },
    );
  }
  await runSparkDaemonServerConnectionsOnce(daemonServerConnectionOptions(runtime));
}

function daemonServerConnectionOptions(
  runtime: PreparedDaemonRuntime,
): SparkDaemonServerConnectionOptions {
  return {
    ...runtime.options,
    signal: runtime.runtimeSignal,
    invocationRegistry: runtime.invocationRegistry,
    humanWaits: runtime.humanWaits,
    channelIngress: runtime.channelIngress ?? undefined,
    registerInvocationEventTarget: (sink) => runtime.eventHub.register(sink),
    registerHumanRequestOutboxTarget: runtime.registerHumanRequestOutboxTarget,
  };
}

async function cleanupPreparedDaemonRuntime(runtime: PreparedDaemonRuntime): Promise<void> {
  const { options, runtimeSignal } = runtime;
  runtime.servingGate.settle(false);
  runtime.removeShutdownForwarder();
  options.drainSignal?.removeEventListener("abort", runtime.closeRestartAdmission);
  runtime.restartDrain.dispose();
  runtimeSignal.removeEventListener("abort", runtime.stopScheduler);
  runtimeSignal.removeEventListener("abort", runtime.stopDirectInvocations);
  runtimeSignal.removeEventListener("abort", runtime.stopChannelIngress);
  await runtime.shutdownChannelIngress("daemon-finally");
  runtime.scheduler?.stop();
  await runtime.scheduler?.wait();
  await runtime.restartDrain.wait();
  await runtime.loops.scheduler;
  await runtime.loops.channelDelivery;
  await runtime.loops.notification;
  await runtime.loops.channelReply;
  if (options.managePidFile !== false && existsSync(options.paths.pidFile)) {
    rmSync(options.paths.pidFile, { force: true });
  }
}

function createDaemonScheduler(input: {
  options: StartSparkDaemonOptions;
  runtimeSignal: AbortSignal;
  admission: { open: boolean };
  invocationStore: SparkInvocationStore;
  channelDeliveryStore: SparkChannelDeliveryStore;
  channelIngress: DaemonChannelIngressRuntime | null;
  channelReplyDeliveryStore: ChannelReplyDeliveryStore;
  humanInteractions: SparkDaemonHumanInteractionBroker;
  eventHub: InvocationEventHub;
  controlSparkHome: string;
  channelsSparkHome: string;
}): SparkInvocationScheduler | null {
  if (input.options.runScheduler === false) return null;
  const { options } = input;
  return new SparkInvocationScheduler({
    store: input.invocationStore,
    executeTask:
      options.executeInvocation ??
      createChannelAwareTaskExecutor({
        paths: options.paths,
        cwd: process.cwd(),
        controlSparkHome: input.controlSparkHome,
        channelsSparkHome: input.channelsSparkHome,
        ...(options.modelControl ? { modelControl: options.modelControl } : {}),
        ...(options.sessionRegistry ? { sessionRegistry: options.sessionRegistry } : {}),
        channelIngress: {
          openReplyStream: async (workspaceId, adapterId, target, streamOptions) =>
            await input.channelIngress?.openReplyStream(
              workspaceId,
              adapterId,
              target,
              streamOptions,
            ),
          sendReply: async (workspaceId, adapterId, sendInput) => {
            if (!input.channelIngress) throw new Error("channel ingress is unavailable");
            return await input.channelIngress.sendReply(workspaceId, adapterId, sendInput);
          },
        },
        channelReplyDelivery: input.channelReplyDeliveryStore,
        interact: (request, task, context) =>
          input.humanInteractions.interact(request, {
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
      completeScheduledInvocation(input, invocation, task, completion),
    emitEvent: (event) => input.eventHub.emit(event),
    concurrency: options.schedulerConcurrency,
    taskTimeoutMs: options.invocationTimeoutMs,
    initiallyAccepting: false,
  });
}

function completeScheduledInvocation(
  input: Parameters<typeof createDaemonScheduler>[0],
  invocation: SparkInvocationRecord,
  task: SparkDaemonTask,
  completion: CompleteSparkInvocationInput,
): ReturnType<NonNullable<SparkInvocationSchedulerOptions["completeInvocation"]>> {
  const completed = completeInvocationWithChannelDelivery(
    {
      db: input.options.db,
      invocations: input.invocationStore,
      deliveries: input.channelDeliveryStore,
    },
    invocation,
    task,
    completion,
  );
  if (input.options.sessionRegistry) {
    void notifySessionRequestCompletion(
      {
        invocationStore: input.invocationStore,
        sessionRegistry: input.options.sessionRegistry,
        ...(input.options.modelControl ? { modelControl: input.options.modelControl } : {}),
        resolveWorkspaceCwd: (workspaceId) =>
          resolveWorkspaceLocalPath(input.options.db, workspaceId),
        canAdmit: () => input.admission.open && !input.runtimeSignal.aborted,
      },
      { invocation, task, completion },
    ).catch((error) => {
      console.error("[spark-daemon] session request completion notify failed", error);
    });
  }
  return completed;
}

function createDaemonRuntimeSignal(options: StartSparkDaemonOptions): {
  runtimeShutdown: AbortController;
  runtimeSignal: AbortSignal;
  removeShutdownForwarder: () => void;
} {
  const runtimeShutdown = new AbortController();
  const forwardShutdown = () => runtimeShutdown.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardShutdown();
  else options.signal?.addEventListener("abort", forwardShutdown, { once: true });
  return {
    runtimeShutdown,
    runtimeSignal: runtimeShutdown.signal,
    removeShutdownForwarder: () => options.signal?.removeEventListener("abort", forwardShutdown),
  };
}

function createChannelIngressShutdown(
  channelIngress: DaemonChannelIngressRuntime | null,
  options: StartSparkDaemonOptions,
): (reason: "restart-drain" | "runtime-abort" | "daemon-finally") => Promise<void> {
  let channelShutdown: Promise<void> | undefined;
  return (reason) => {
    if (!channelIngress) return Promise.resolve();
    if (channelShutdown) return channelShutdown;
    console.error(`[spark-daemon] channel ingress stopping reason=${reason}`);
    channelShutdown = channelIngress.stop().catch((error: unknown) => {
      logDaemonError(options.config.runtimeId ?? "unknown", error);
    });
    return channelShutdown;
  };
}

function createRuntimeIdForServer(
  options: Pick<StartSparkDaemonOptions, "paths" | "config">,
): (serverUrl: string) => string | undefined {
  return (serverUrl) => {
    try {
      const runtimeId = getSparkDaemonServerProfile(options.paths, serverUrl)?.runtimeId;
      if (runtimeId) return runtimeId;
    } catch {
      // Fall through to the already-loaded compatibility config.
    }
    const fallback = sparkDaemonServerProfileFromConfig(options.config);
    if (fallback?.serverUrl !== normalizeSparkDaemonServerUrl(serverUrl)) return undefined;
    return fallback.runtimeId;
  };
}

function configureHumanInteractions(input: {
  options: StartSparkDaemonOptions;
  channelIngress: DaemonChannelIngressRuntime | null;
  humanWaits: SparkDaemonHumanWaitRegistry;
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox;
  getRuntimeId: (route: { serverUrl: string }) => string | undefined;
  getRuntimeIdForServer: (serverUrl: string) => string | undefined;
  flushHumanRequestOutbox: () => void;
  humanRequestOutboxTargets: Set<() => void>;
}): {
  humanInteractions: SparkDaemonHumanInteractionBroker;
  registerHumanRequestOutboxTarget: (flush: () => void) => () => boolean;
} {
  const { channelIngress, humanWaits, channelDeliveryOutbox } = input;
  channelIngress?.setInteractionHandler?.(async (interaction) => {
    await handleChannelInteraction(input, interaction);
  });
  channelIngress?.setTextAskHandler?.(async (reply) => await handleChannelTextAsk(input, reply));
  const registerHumanRequestOutboxTarget = (flush: () => void) => {
    input.humanRequestOutboxTargets.add(flush);
    return () => input.humanRequestOutboxTargets.delete(flush);
  };
  const humanInteractions = new SparkDaemonHumanInteractionBroker({
    db: input.options.db,
    waits: humanWaits,
    getRuntimeId: input.getRuntimeId,
    onOutboxReady: input.flushHumanRequestOutbox,
    onRequestOpened: (request) =>
      projectChannelAskRequest(channelIngress, request, channelDeliveryOutbox),
  });
  return { humanInteractions, registerHumanRequestOutboxTarget };
}

async function handleChannelInteraction(
  input: Parameters<typeof configureHumanInteractions>[0],
  interaction: Parameters<NonNullable<ChannelIngressHooks["onInteraction"]>>[0],
): Promise<void> {
  if (!input.channelIngress) return;
  try {
    await settleChannelAskInteraction(input.channelIngress, input.humanWaits, interaction, {
      getRuntimeId: (wait) => runtimeIdForHumanWait(input, wait.workspaceBindingId),
      deliveryOutbox: input.channelDeliveryOutbox,
    });
  } finally {
    input.flushHumanRequestOutbox();
  }
}

async function handleChannelTextAsk(
  input: Parameters<typeof configureHumanInteractions>[0],
  reply: Parameters<NonNullable<ChannelIngressHooks["onTextAskReply"]>>[0],
): Promise<ReturnType<NonNullable<ChannelIngressHooks["onTextAskReply"]>>> {
  try {
    return await settleChannelAskTextReply(input.humanWaits, reply, {
      getRuntimeId: (wait) => runtimeIdForHumanWait(input, wait.workspaceBindingId),
    });
  } finally {
    input.flushHumanRequestOutbox();
  }
}

function runtimeIdForHumanWait(
  input: Parameters<typeof configureHumanInteractions>[0],
  workspaceBindingId: string | undefined,
): string | undefined {
  if (!workspaceBindingId) return undefined;
  const workspace = getWorkspaceById(input.options.db, workspaceBindingId);
  return workspace?.serverUrl ? input.getRuntimeIdForServer(workspace.serverUrl) : undefined;
}

function projectChannelAskRequest(
  channelIngress: DaemonChannelIngressRuntime | null,
  request: SparkDaemonHumanInteractionOpened,
  channelDeliveryOutbox: DaemonChannelDeliveryOutbox,
): void {
  if (!channelIngress) return;
  void projectChannelAsk(channelIngress, request, channelDeliveryOutbox).catch((error: unknown) => {
    console.error(
      "[spark-daemon] channel ask outbox enqueue failed; Cockpit request remains pending",
      error,
    );
  });
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
              externalKey: assignment.externalKey,
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

function shouldReplaceUplink(
  current: ActiveSparkDaemonUplink,
  next: DesiredSparkDaemonUplink | undefined,
  forceServerUrl: string | undefined,
  serverUrl: string,
): boolean {
  if (next?.fingerprint !== current.fingerprint) return true;
  if (forceServerUrl === undefined) return false;
  return forceServerUrl === "" || normalizeSparkDaemonServerUrl(forceServerUrl) === serverUrl;
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
      if (shouldReplaceUplink(current, next, forceServerUrl, serverUrl)) {
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
    const runtimeSession = { id: undefined as string | undefined };
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
        reject(error instanceof Error ? error : new Error("Spark daemon connection rejected."));
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
        Promise.allSettled(activeHandlers),
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
          if (inFlight?.messageId !== ackOf) return;
          invocationStore.acknowledgeDelivery(
            deliveryDestination,
            inFlight.invocationId,
            inFlight.sequence,
          );
          inFlightInvocationEvent = undefined;
          flushNextInvocationEvent();
        },
        get runtimeSessionId() {
          return runtimeSession.id;
        },
        setRuntimeSessionId(value) {
          runtimeSession.id = value;
        },
        ensureHeartbeat(intervalMs) {
          unregisterHumanRequestOutboxTarget ??= registerHumanRequestOutboxFlush(
            options,
            ws,
            runtimeId,
            serverUrl,
          );
          flushPendingHumanRequests(ws, options.humanWaits, runtimeId, serverUrl);
          if (heartbeat) {
            return;
          }
          heartbeat = startDaemonHeartbeatTimer(
            ws,
            options,
            runtimeId,
            runtimeSession,
            serverUrl,
            intervalMs,
          );
          sendHeartbeat(ws, options.db, runtimeId, runtimeSession.id, serverUrl);
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

function registerHumanRequestOutboxFlush(
  options: SparkDaemonServerConnectionOptions,
  ws: WebSocket,
  runtimeId: string,
  serverUrl: string | null,
): (() => void) | undefined {
  return options.registerHumanRequestOutboxTarget?.(() =>
    flushPendingHumanRequests(ws, options.humanWaits, runtimeId, serverUrl),
  );
}

function flushDaemonHeartbeat(
  ws: WebSocket,
  options: SparkDaemonServerConnectionOptions,
  runtimeId: string,
  runtimeSessionId: string | undefined,
  serverUrl: string | null,
): void {
  sendHeartbeat(ws, options.db, runtimeId, runtimeSessionId, serverUrl);
  flushPendingHumanRequests(ws, options.humanWaits, runtimeId, serverUrl);
}

function startDaemonHeartbeatTimer(
  ws: WebSocket,
  options: SparkDaemonServerConnectionOptions,
  runtimeId: string,
  runtimeSession: { id: string | undefined },
  serverUrl: string | null,
  intervalMs: number,
): NodeJS.Timeout {
  return setInterval(
    () => flushDaemonHeartbeat(ws, options, runtimeId, runtimeSession.id, serverUrl),
    intervalMs,
  );
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
