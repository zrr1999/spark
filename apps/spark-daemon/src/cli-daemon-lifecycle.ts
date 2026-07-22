import { existsSync, readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createSparkProviderControl } from "@zendev-lab/spark-ai/control";
import { createId } from "@zendev-lab/spark-protocol";
import {
  resolveSparkPaths,
  resolveSparkUserPaths,
  writePrivateFile,
} from "@zendev-lab/spark-system";
import {
  defaultSparkDaemonConfig,
  readSparkDaemonConfig,
  writeSparkDaemonConfig,
} from "./config.js";
import { createSparkDaemonUplinkControl, sparkDaemonVersion, startSparkDaemon } from "./daemon.js";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  sparkDaemonConfigForServerProfile,
  type SparkDaemonServerProfile,
} from "./server-profiles.js";
import { createSparkDaemonModelControl } from "./model-control.ts";
import type { DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import { SparkDaemonLeaseTransferBroker } from "./core/lease-transfer.ts";
import {
  SparkDaemonLifecycle,
  SparkDaemonInvocationRegistry,
  acquireSparkDaemonLock,
  legacySparkDaemonQueueRoot,
  type SparkDaemonDrainProgress,
  type SparkDaemonHumanInteractionResponder,
  type SparkDaemonLifecycleSnapshot,
} from "./core/index.ts";
import {
  LocalRpcUnavailableError,
  createDaemonSessionRegistry,
  createSparkDaemonLocalEventBus,
  localRpcSocketPath,
  requestDaemonRestart,
  requestDaemonStop,
  requestDaemonStatus,
  requestTurnSubmit,
  startLocalRpcServer,
} from "./local-rpc.js";
import { migrateLegacyQueueHistory } from "./store/legacy-queue-migration.ts";
import { openSparkDaemonDatabase } from "./store/schema.js";
import { resolveWorkspaceLocalPath, type SparkDaemonWorkspace } from "./store/workspaces.js";
import {
  cancelSparkDaemonRestartSuccessor,
  clearSparkDaemonRestartFenceForExplicitStart,
  completeSparkDaemonRestartSuccessor,
  isSparkDaemonRestartHelperDefinitelyDead,
  isSparkDaemonRestartArmed,
  prepareSparkDaemonRestartAwareStart,
  publishSparkDaemonProcessOwnership,
  readRunningPid,
  readSparkDaemonActiveRestart,
  readSparkDaemonRestartTerminal,
  releaseSparkDaemonProcessOwnership,
  runSparkDaemonRestartSuccessor,
  scheduleSparkDaemonRestartSuccessor,
  stopSparkDaemonService,
} from "./service.js";
import {
  type CliIo,
  STRINGS,
  confirmAction,
  helpRequested,
  parseFlags,
  positionalArgs,
  prepareSparkDaemonState,
  printDaemonHelp,
  startSparkDaemonProcess,
  errorMessage,
} from "./cli-shared.ts";

// logs is provided by the caller to avoid a cycle with cli.ts
let logsCommand: (
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
) => Promise<number> = async () => {
  throw new Error("logs command is not bound");
};

export function bindCliDaemonLogs(fn: typeof logsCommand): void {
  logsCommand = fn;
}

export function sparkDaemonServiceExitCode(input: {
  managed: boolean;
  restartRequested: boolean;
  stopRequested: boolean;
}): number {
  // EX_TEMPFAIL tells launchd/systemd that this was a planned supervisor
  // handoff, while explicit stop remains a successful exit and stays stopped.
  return input.managed && input.restartRequested && !input.stopRequested ? 75 : 0;
}

export async function start(
  paths: ReturnType<typeof resolveSparkPaths>,
  options: { explicit: boolean; managed: boolean; expectedRestartId?: string },
): Promise<number> {
  prepareSparkDaemonState(paths);
  const lock = await acquireSparkDaemonLock({ runtimeDir: paths.runtimeDir, cwd: process.cwd() });
  if (options.explicit) clearSparkDaemonRestartFenceForExplicitStart(paths);
  const restartStart = prepareSparkDaemonRestartAwareStart(paths, options.expectedRestartId);
  if (!restartStart.start) {
    await lock.release();
    return 0;
  }
  const db = openSparkDaemonDatabase(paths);
  const shutdown = new AbortController();
  const stopIntent = new AbortController();
  const successorContext = restartStart.successorContext;
  const lifecycle = new SparkDaemonLifecycle(successorContext ?? {}, { initiallyServing: false });
  publishSparkDaemonProcessOwnership(paths, lifecycle.processIdentity);
  writePrivateFile(paths.pidFile, `${process.pid}\n`);
  let stopRequested = false;
  const onShutdownSignal = (signal: "SIGINT" | "SIGTERM") => {
    lifecycle.requestStop(`signal:${signal}`);
    stopRequested = true;
    stopIntent.abort(new Error("Spark daemon stop signal won restart handoff."));
    cancelSparkDaemonRestartSuccessor(paths);
    shutdown.abort(new Error(`Spark daemon received ${signal}.`));
  };
  const onSigint = () => onShutdownSignal("SIGINT");
  const onSigterm = () => onShutdownSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const localEventBus = createSparkDaemonLocalEventBus();
  const invocationRegistry = new SparkDaemonInvocationRegistry();
  await migrateLegacyQueueHistory({ db, queueRoot: legacySparkDaemonQueueRoot({ paths }) });
  const userPaths = resolveSparkUserPaths();
  const sparkHome = userPaths.dataRoot;
  const config = existsSync(paths.configFile)
    ? readSparkDaemonConfig(paths)
    : defaultSparkDaemonConfig();
  if (!existsSync(paths.configFile)) writeSparkDaemonConfig(paths, config);
  const daemonCwd = process.cwd();
  const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
    daemonId: config.installationId,
    daemonCwd,
    resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(db, workspaceId),
  });
  const modelControl = createSparkDaemonModelControl({
    providerControl: createSparkProviderControl({
      authPath: userPaths.authFile,
      configPath: userPaths.configFile,
    }),
    sessionRegistry,
  });
  const humanWaits = new SparkDaemonHumanWaitRegistry(db);
  const leaseTransfers = new SparkDaemonLeaseTransferBroker();
  // startSparkDaemon is the single bootstrap owner for channel transports,
  // durable cursor wiring, and assignment admission (including inbound
  // idempotency). Local RPC receives that exact runtime through onReady
  // instead of constructing a second variant.
  let channelIngress: DaemonChannelIngressRuntime | null = null;
  let respondHumanInteraction: SparkDaemonHumanInteractionResponder | null = null;
  let flushHumanRequestOutbox: (() => void) | undefined;
  let drainProgress: SparkDaemonDrainProgress | undefined;
  const uplinkControl = createSparkDaemonUplinkControl();
  let armedRestart: Awaited<ReturnType<typeof scheduleSparkDaemonRestartSuccessor>> | undefined;
  let restartArming: ReturnType<typeof scheduleSparkDaemonRestartSuccessor> | undefined;
  let localRpc: Awaited<ReturnType<typeof startLocalRpcServer>> | undefined;
  const startLocalControl = () =>
    startLocalRpcServer({
      paths,
      sparkHome,
      db,
      onStopRequested: () => {
        lifecycle.requestStop("local-rpc-stop");
        stopRequested = true;
        stopIntent.abort(new Error("Spark daemon stop request won restart handoff."));
        cancelSparkDaemonRestartSuccessor(paths);
      },
      onStop: () => shutdown.abort(new Error("Spark daemon local RPC stop requested.")),
      onUplinkReconfigure: (serverUrl) => uplinkControl.requestReconfigure(serverUrl),
      onRestart: async () => {
        if (stopRequested || shutdown.signal.aborted) {
          throw new Error("Spark daemon is already stopping; restart was not armed.");
        }
        if (
          lifecycle.restartRequested &&
          armedRestart &&
          !isSparkDaemonRestartHelperDefinitelyDead(armedRestart)
        ) {
          return lifecycle.requestRestart(armedRestart.requestedAt, armedRestart.restartId, {
            instanceId: armedRestart.targetInstanceId,
            generation: armedRestart.targetGeneration,
          });
        }
        const requestedAt = new Date().toISOString();
        const arming =
          restartArming ??
          scheduleSparkDaemonRestartSuccessor(
            paths,
            process.pid,
            lifecycle.processIdentity,
            requestedAt,
            { signal: stopIntent.signal, supervisorManaged: options.managed },
          );
        restartArming = arming;
        let armed;
        try {
          armed = await arming;
          armedRestart = armed;
        } finally {
          if (restartArming === arming) restartArming = undefined;
        }
        if (stopRequested || shutdown.signal.aborted || stopIntent.signal.aborted) {
          cancelSparkDaemonRestartSuccessor(paths);
          throw new Error("Spark daemon stopped while restart was being armed.");
        }
        // Admission closes only after durable intent and its external helper
        // exist. A crash during a long drain therefore still has a successor.
        return lifecycle.requestRestart(armed.requestedAt, armed.restartId, {
          instanceId: armed.targetInstanceId,
          generation: armed.targetGeneration,
        });
      },
      getLifecycle: () => {
        const snapshot = lifecycle.snapshot();
        return snapshot.state === "draining" && drainProgress
          ? {
              ...snapshot,
              phase:
                drainProgress.stage === "channel-ingress"
                  ? "draining-channel-ingress"
                  : "draining-active-work",
              drain: drainProgress,
            }
          : snapshot;
      },
      isReady: () => lifecycle.isServing,
      eventBus: localEventBus,
      ...(channelIngress ? { channelIngress } : {}),
      sessionRegistry,
      modelControl,
      humanWaits,
      leaseTransfers,
      onHumanRequestOutboxReady: () => {
        flushHumanRequestOutbox?.();
      },
      getRuntimeIdForServer: (serverUrl) => {
        try {
          return getSparkDaemonServerProfile(paths, serverUrl)?.runtimeId;
        } catch {
          return undefined;
        }
      },
      ...(respondHumanInteraction ? { respondHumanInteraction } : {}),
    });
  try {
    await startSparkDaemon({
      paths,
      ...(process.env.SPARK_HOME?.trim() ? { sparkHome: process.env.SPARK_HOME.trim() } : {}),
      config,
      db,
      signal: shutdown.signal,
      drainSignal: lifecycle.drainSignal,
      restartSignal: lifecycle.restartSignal,
      localEventSink: (event) => localEventBus.publish(event),
      invocationRegistry,
      humanWaits,
      sessionRegistry,
      modelControl,
      uplinkControl,
      managePidFile: false,
      onDrainProgress: (progress) => {
        drainProgress = progress;
      },
      onReady: async (runtime) => {
        channelIngress = runtime.channelIngress;
        respondHumanInteraction = runtime.respondHumanInteraction;
        flushHumanRequestOutbox = runtime.flushHumanRequestOutbox;
        // Bind status/stop while startup admission remains closed. Binding a
        // socket is not successor readiness: the Claimed fence remains active
        // until every daemon admission loop is live below.
        localRpc = await startLocalControl();
      },
      onServing: () => {
        // Admission loops are live before this synchronous callback. Publish
        // running first, then complete the exact restart fence in the same
        // event-loop turn. If an explicit stop won the durable CAS, roll the
        // unobservable lifecycle transition back and shut this successor down.
        lifecycle.activate();
        if (!completeSparkDaemonRestartSuccessor(paths, lifecycle.processIdentity)) {
          lifecycle.deactivate();
          stopRequested = true;
          stopIntent.abort(new Error("Spark daemon restart was cancelled before readiness."));
          shutdown.abort();
        }
      },
    });
    return sparkDaemonServiceExitCode({
      managed: options.managed,
      restartRequested: lifecycle.restartRequested,
      stopRequested,
    });
  } finally {
    await localRpc?.close();
    db.close();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await releaseSparkDaemonProcessOwnership(paths, lifecycle.processIdentity, () =>
      lock.release(),
    );
  }
}

export async function stop(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (!(await confirmAction(io, parseFlags(args), "Stop Spark daemon?"))) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }

  const cancelledRestart = cancelSparkDaemonRestartSuccessor(paths);
  const pid = readRunningPid(paths);
  if (!pid) {
    // The service label remains the source of truth during a managed handoff.
    if (process.platform === "darwin") {
      const service = (io.stopService ?? stopSparkDaemonService)(paths);
      if (service) {
        io.stdout.write(`${service.detail}\n`);
        return 0;
      }
      io.stderr.write(
        "Failed to unregister the Spark daemon launchd service; it may remain registered.\n",
      );
      return 1;
    }
    if (cancelledRestart) {
      io.stdout.write("Cancelled pending Spark daemon restart.\n");
      return 0;
    }
    io.stdout.write("Spark daemon is not running.\n");
    return 0;
  }

  try {
    await (io.daemonStopFromService ?? requestDaemonStop)(paths);
    if (process.platform === "darwin") {
      const service = (io.stopService ?? stopSparkDaemonService)(paths);
      if (service) {
        io.stdout.write(`${service.detail}\n`);
        return 0;
      }
      io.stderr.write(
        "Spark daemon stopped accepting RPC, but its launchd service may remain registered.\n",
      );
      return 1;
    }
    io.stdout.write(`Stopped Spark daemon process ${pid}.\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof LocalRpcUnavailableError)) {
      throw error;
    }
  }

  const service = (io.stopService ?? stopSparkDaemonService)(paths);
  if (service) {
    io.stdout.write(`${service.detail}\n`);
    return 0;
  }

  io.stderr.write(
    `Spark daemon process ${pid} could not be reached and its ownership could not be verified; no signal was sent.\n`,
  );
  return 1;
}

export async function daemon(
  paths: ReturnType<typeof resolveSparkPaths>,
  subcommand: string | undefined,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (helpRequested(args)) {
    printDaemonHelp(io);
    return 0;
  }

  switch (subcommand) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printDaemonHelp(io);
      return 0;
    case "status":
      return await daemonStatus(paths, args, io);
    case "start":
      return await start(paths, { explicit: true, managed: false });
    case "stop":
      return await stop(paths, args, io);
    case "restart":
      return await restart(paths, args, io);
    case "logs":
      return await logsCommand(paths, args, io);
    case "submit":
      return await daemonSubmit(paths, args, io);
    default:
      throw new Error("Usage: spark daemon <status|start|stop|restart|logs|submit>");
  }
}

export async function restart(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  if (!(await confirmAction(io, flags, "Restart Spark daemon?"))) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }

  const previousPid = readRunningPid(paths);
  if (!previousPid) {
    clearSparkDaemonRestartFenceForExplicitStart(paths);
    const service = startSparkDaemonProcess(paths, io);
    io.stdout.write(`${service.detail}\n`);
    if (flags.wait === "true" && flags["no-wait"] !== "true") {
      const readyPid = await waitForDaemonReady(paths, null, io);
      io.stdout.write(`Spark daemon is ready as process ${readyPid}.\n`);
    }
    return 0;
  }

  let requested: Awaited<ReturnType<typeof requestDaemonRestart>> | undefined;
  try {
    requested = await (io.daemonRestartFromService ?? requestDaemonRestart)(paths);
  } catch (error) {
    if (error instanceof LocalRpcUnavailableError) {
      // The request may have reached the daemon even if its ACK was lost.
      // Never turn that ambiguity into SIGTERM, which would cancel the very
      // invocations a drain restart is meant to preserve.
      throw new Error(
        "Spark daemon restart acknowledgement is unavailable; active work was not force-stopped. Check `spark daemon status` before retrying.",
        { cause: error },
      );
    }
    if (!isRestartRpcUnsupported(error)) throw error;
  }

  if (requested) {
    io.stdout.write(
      `Spark daemon restart requested at ${requested.requestedAt}; draining active invocations.\n`,
    );
    // Async is the safe default for daemon-hosted callers: waiting for the
    // replacement from inside an active invocation would deadlock the drain.
    if (flags.wait !== "true" || flags["no-wait"] === "true") {
      io.stdout.write("Replacement will start after active work finishes.\n");
      return 0;
    }

    const replacementPid = await waitForDaemonReady(paths, previousPid, io, {
      restartId: requested.restartId,
      targetInstanceId: requested.targetInstanceId,
      targetGeneration: requested.targetGeneration,
    });
    io.stdout.write(`Spark daemon restarted as process ${replacementPid}.\n`);
    return 0;
  }

  // Compatibility path for a daemon that predates drain restart or whose
  // local socket is already unusable. This preserves the old stop/start repair
  // behavior, but cannot promise active invocation continuity.
  const stopped = await stop(paths, ["--yes"], io);
  if (stopped !== 0) return stopped;

  const stoppedOrReplaced = await waitForDaemonStoppedOrReplaced(paths, previousPid);
  const currentPid = readRunningPid(paths);
  if (currentPid && currentPid !== previousPid) {
    io.stdout.write(`Spark daemon restarted as process ${currentPid}.\n`);
    return 0;
  }
  if (!stoppedOrReplaced) {
    io.stderr.write(
      previousPid
        ? `Spark daemon process ${previousPid} did not stop before restart timeout.\n`
        : "Spark daemon did not stop before restart timeout.\n",
    );
    return 1;
  }
  clearSparkDaemonRestartFenceForExplicitStart(paths);
  const service = startSparkDaemonProcess(paths, io);
  io.stdout.write(`${service.detail}\n`);
  if (flags.wait === "true" && flags["no-wait"] !== "true") {
    const replacementPid = await waitForDaemonReady(paths, previousPid, io);
    io.stdout.write(`Spark daemon restarted as process ${replacementPid}.\n`);
  }
  return 0;
}

export async function restartSuccessor(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const previousPid = Number(args[0]);
  const restartId = args[1]?.trim();
  if (!Number.isInteger(previousPid) || previousPid <= 0 || !restartId || args.length !== 2) {
    throw new Error("Invalid Spark daemon restart successor request.");
  }
  const intentCommitted = waitForRestartIntentCommit(paths, previousPid, restartId);
  await notifyRestartHelperReady(restartId);
  const commitSource = await intentCommitted;
  if (commitSource === "cancelled") {
    io.stdout.write("Spark daemon restart successor was cancelled.\n");
    return 0;
  }
  const service = await runSparkDaemonRestartSuccessor(paths, previousPid, {
    expectedRestartId: restartId,
    onIntentArmed: async (intent) => {
      if (commitSource !== "ipc") return;
      try {
        await notifyRestartHelperArmed(intent);
      } catch (error) {
        // Once exact Armed intent is durable, parent death transfers ownership
        // to this detached helper. If the parent is alive it will publish a
        // Cancelled tombstone when its two-stage handshake fails.
        if (!isSparkDaemonRestartArmed(paths, previousPid, restartId)) throw error;
      }
    },
  });
  io.stdout.write(
    service ? `${service.detail}\n` : "Spark daemon restart successor was cancelled.\n",
  );
  return 0;
}

async function notifyRestartHelperReady(restartId: string): Promise<void> {
  await sendRestartHelperMessage({ type: "spark-daemon-restart-helper-ready", restartId });
}

async function notifyRestartHelperArmed(intent: {
  restartId: string;
  targetInstanceId: string;
  targetGeneration: string;
}): Promise<void> {
  await sendRestartHelperMessage({
    type: "spark-daemon-restart-helper-armed",
    restartId: intent.restartId,
    targetInstanceId: intent.targetInstanceId,
    targetGeneration: intent.targetGeneration,
  });
}

async function sendRestartHelperMessage(message: Record<string, string>): Promise<void> {
  if (!process.send) throw new Error("Spark daemon restart helper IPC is unavailable.");
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function waitForRestartIntentCommit(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number,
  restartId: string,
): Promise<"ipc" | "durable" | "cancelled"> {
  return await new Promise<"ipc" | "durable" | "cancelled">((resolve) => {
    let settled = false;
    const finish = (result: "ipc" | "durable" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      resolve(result);
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "spark-daemon-restart-intent-committed" &&
        "restartId" in message &&
        message.restartId === restartId
      ) {
        finish("ipc");
      }
    };
    const finishFromDurableState = () =>
      finish(isSparkDaemonRestartArmed(paths, previousPid, restartId) ? "durable" : "cancelled");
    const onDisconnect = () => finishFromDurableState();
    const timeout = setTimeout(finishFromDurableState, 10_000);
    timeout.unref();
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

async function waitForDaemonReady(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number | null,
  io: CliIo,
  expectedRestart?: {
    restartId: string;
    targetInstanceId: string;
    targetGeneration: string;
  },
): Promise<number> {
  const progressIntervalMs = 5_000;
  let nextProgressAt = Date.now() + progressIntervalMs;
  let replacementDeadline = previousPid === null ? Date.now() + 30_000 : undefined;
  let observedTerminal: ReturnType<typeof readSparkDaemonRestartTerminal> = null;
  let observedLifecycle: SparkDaemonLifecycleSnapshot | undefined;
  while (true) {
    const currentPid = readRunningPid(paths);
    if (expectedRestart && previousPid !== null && !observedTerminal) {
      observedTerminal = readSparkDaemonRestartTerminal(paths, {
        previousPid,
        restartId: expectedRestart.restartId,
      });
      if (observedTerminal?.state === "cancelled") {
        throw new Error(`Spark daemon restart ${expectedRestart.restartId} was cancelled.`);
      }
    }

    // An exact local-RPC identity is stronger readiness evidence than the
    // pidfile projection. During handoff the pidfile/identity pair can be
    // briefly absent while the accepted successor is already serving. Probe
    // unconditionally for exact restarts so that projection race cannot leave
    // --wait spinning forever.
    if (expectedRestart || (currentPid && currentPid !== previousPid)) {
      try {
        const status = await (io.daemonStatusFromService ?? requestDaemonStatus)(paths);
        observedLifecycle = status.lifecycle;
        const identity = status.lifecycle.process;
        const targetInstanceId =
          observedTerminal?.state === "completed"
            ? observedTerminal.targetInstanceId
            : expectedRestart?.targetInstanceId;
        const targetGeneration =
          observedTerminal?.state === "completed"
            ? observedTerminal.targetGeneration
            : expectedRestart?.targetGeneration;
        const exactAcceptedSuccessor = Boolean(
          expectedRestart &&
          identity !== undefined &&
          identity.pid !== previousPid &&
          identity.instanceId === targetInstanceId &&
          identity.generation === targetGeneration &&
          identity.acceptedRestartId === expectedRestart.restartId,
        );
        if (
          (!expectedRestart && status.lifecycle.state === "running") ||
          (exactAcceptedSuccessor &&
            (status.lifecycle.state === "running" || status.lifecycle.state === "draining"))
        ) {
          return expectedRestart ? identity!.pid : currentPid!;
        }
        if (
          expectedRestart &&
          identity?.pid !== previousPid &&
          identity?.acceptedRestartId &&
          identity.acceptedRestartId !== expectedRestart.restartId &&
          (status.lifecycle.state === "running" || status.lifecycle.state === "draining")
        ) {
          throw new Error(
            `Spark daemon restart ${expectedRestart.restartId} was superseded by ${identity.acceptedRestartId}.`,
          );
        }
      } catch (error) {
        if (!isRetryableDaemonReadinessRpcError(error)) throw error;
      }
    }
    if (expectedRestart && Date.now() >= nextProgressAt) {
      const activeRestart = readSparkDaemonActiveRestart(paths);
      const restartState =
        observedTerminal?.state ??
        (activeRestart?.restartId === expectedRestart.restartId
          ? activeRestart.state
          : "awaiting-successor");
      io.stdout.write(
        `Spark daemon restart ${expectedRestart.restartId}: ${restartState}; ` +
          `predecessor pid ${previousPid}; observed pid ${currentPid ?? "none"}; ` +
          `target generation ${expectedRestart.targetGeneration}` +
          `${formatRestartDrainBlockers(observedLifecycle)}.\n`,
      );
      nextProgressAt = Date.now() + progressIntervalMs;
    }
    if (
      previousPid === null ||
      !isProcessAlive(previousPid) ||
      observedTerminal?.state === "completed"
    ) {
      replacementDeadline ??= Date.now() + 30_000;
      if (Date.now() >= replacementDeadline) {
        throw new Error(
          previousPid === null
            ? "Spark daemon did not become ready within 30 seconds."
            : `Spark daemon process ${previousPid} exited, but its replacement did not become ready within 30 seconds.`,
        );
      }
    }
    await delay(50);
  }
}

function formatRestartDrainBlockers(lifecycle: SparkDaemonLifecycleSnapshot | undefined): string {
  if (lifecycle?.state !== "draining" || !lifecycle.drain) return "";
  const scheduled = lifecycle.drain.scheduler;
  const direct = lifecycle.drain.direct;
  const blockers = [...scheduled, ...direct];
  const stage = lifecycle.drain.stage;
  if (blockers.length === 0) return `; drain stage ${stage}; blockers 0`;
  const ids = blockers
    .slice(0, 3)
    .map((entry) => entry.invocationId)
    .join(",");
  return (
    `; drain stage ${stage}; blockers scheduler=${scheduled.length} direct=${direct.length}` +
    ` ids=${ids}${blockers.length > 3 ? ",…" : ""}`
  );
}

function isRetryableDaemonReadinessRpcError(error: unknown): error is LocalRpcUnavailableError {
  return (
    error instanceof LocalRpcUnavailableError &&
    !/does not support|unknown local RPC method:/iu.test(error.message)
  );
}

function isRestartRpcUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unknown local RPC method: daemon.restart") ||
    message.includes("does not support daemon.restart") ||
    message.includes("restart control is not available")
  );
}

async function waitForDaemonStoppedOrReplaced(
  paths: ReturnType<typeof resolveSparkPaths>,
  previousPid: number | null,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentPid = readRunningPid(paths);
    const previousStillAlive = previousPid !== null && isProcessAlive(previousPid);
    if (!previousStillAlive && (currentPid === null || currentPid !== previousPid)) return true;
    await delay(50);
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function daemonStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const status = await buildDaemonStatus(paths, io);
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  if (!status.running) {
    if (status.restart) {
      io.stdout.write(
        "restarting\n" +
          `  restart id       ${status.restart.restartId}\n` +
          `  restart state    ${status.restart.state}\n` +
          `  requested        ${status.restart.requestedAt}\n` +
          `  previous pid     ${status.restart.previousPid}\n` +
          `  target instance  ${status.restart.targetInstanceId}\n` +
          `  target generation ${status.restart.targetGeneration}\n` +
          `  socket           ${status.socketPath} (temporarily unavailable)\n` +
          ("unreachable" in status
            ? `  observed pid     ${status.pid}\n` + `  error            ${status.error}\n`
            : "") +
          "  inspect          spark daemon status --json\n",
      );
      return 0;
    }
    if ("unreachable" in status) {
      io.stdout.write(
        "unreachable\n" +
          `  pid              ${status.pid}\n` +
          `  socket           ${status.socketPath} (not reachable)\n` +
          `  state db         ${status.stateDbPath}\n` +
          `  started          ${status.startedAt}\n` +
          `  error            ${status.error}\n` +
          "  restart          spark daemon restart\n",
      );
      return 0;
    }
    io.stdout.write(
      "not running\n" +
        `  socket           ${status.socketPath} (absent)\n` +
        "  start            spark daemon start\n" +
        "                   or run any 'spark daemon workspace' command to lazy-spawn\n",
    );
    return 0;
  }

  const workspaceCount = status.servers.reduce((sum, server) => sum + server.workspaceCount, 0);
  const processIdentity = status.lifecycle.process;
  io.stdout.write(
    `${status.lifecycle.state}\n` +
      `  pid              ${status.pid}\n` +
      `  phase            ${status.lifecycle.phase ?? status.lifecycle.state}\n` +
      (processIdentity
        ? `  instance         ${processIdentity.instanceId}\n` +
          `  generation       ${processIdentity.generation}\n` +
          `  protocol         ${processIdentity.protocolVersion}\n`
        : "") +
      (status.lifecycle.restartId ? `  restart id       ${status.lifecycle.restartId}\n` : "") +
      (status.lifecycle.drain
        ? `  drain stage      ${status.lifecycle.drain.stage}\n` +
          `  drain blockers   ${status.lifecycle.drain.scheduler.length} scheduler · ${status.lifecycle.drain.direct.length} direct\n`
        : "") +
      (status.lifecycle.stopReason ? `  stop reason      ${status.lifecycle.stopReason}\n` : "") +
      `  socket           ${status.socketPath}\n` +
      `  state db         ${status.stateDbPath}\n` +
      `  started          ${status.startedAt}\n` +
      `  registered       ${workspaceCount} workspaces across ${status.servers.length} servers\n` +
      `  invocations      ${status.invocations.queued} queued · ${status.invocations.running} running · ${status.invocations.succeeded} succeeded · ${status.invocations.failed} failed · ${status.invocations.cancelled} cancelled\n`,
  );
  for (const server of status.servers) {
    io.stdout.write(
      `    ${server.url}    ${server.workspaceCount} workspaces · ${daemonServerConnectionLabel(server)}\n`,
    );
  }
  return 0;
}

export async function daemonSubmit(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const sessionId = flags.session?.trim();
  const prompt = (flags.prompt ?? positionalArgs(args).join(" ")).trim();
  if (!sessionId) throw new Error(STRINGS.submitRequiresSession);
  if (!prompt) throw new Error(STRINGS.submitRequiresPrompt);
  const idempotencyKey = flags["idempotency-key"]?.trim() || createId("idem");
  const submit = io.turnSubmitToService ?? requestTurnSubmit;
  const input = { sessionId, prompt, idempotencyKey };
  let result;
  try {
    result = await submit(paths, input);
  } catch (error) {
    if (!(error instanceof LocalRpcUnavailableError)) throw error;
    // A lost response is ambiguous: the daemon may already have committed the
    // invocation. Retrying once with the same key recovers that invocation.
    result = await submit(paths, input);
  }
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`queued ${result.invocationId}\n`);
  return 0;
}

function daemonServerConnectionLabel(server: {
  wsConnected: boolean;
  lastHeartbeatAt?: string;
  lastDisconnectReason?: string;
}): string {
  if (server.wsConnected) {
    return server.lastHeartbeatAt
      ? `WS connected · last heartbeat ${server.lastHeartbeatAt}`
      : "WS connected";
  }
  return server.lastDisconnectReason
    ? `WS disconnected · ${server.lastDisconnectReason}`
    : "WS disconnected";
}

interface DaemonRestartStatus {
  state: "armed" | "claimed";
  restartId: string;
  requestedAt: string;
  previousPid: number;
  previousInstanceId: string;
  previousGeneration: string;
  targetInstanceId: string;
  targetGeneration: string;
}

export type DaemonStatus =
  | { running: false; socketPath: string; restart?: DaemonRestartStatus }
  | {
      running: false;
      unreachable: true;
      pid: number;
      socketPath: string;
      stateDbPath: string;
      startedAt: string;
      error: string;
      restart?: DaemonRestartStatus;
    }
  | {
      running: true;
      pid: number;
      socketPath: string;
      stateDbPath: string;
      startedAt: string;
      servers: Array<{
        url: string;
        workspaceCount: number;
        wsConnected: boolean;
        lastHeartbeatAt?: string;
        lastDisconnectReason?: string;
      }>;
      invocations: {
        queued: number;
        running: number;
        succeeded: number;
        failed: number;
        cancelled: number;
      };
      lifecycle: SparkDaemonLifecycleSnapshot;
    };

export async function buildDaemonStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
): Promise<DaemonStatus> {
  const socketPath = localRpcSocketPath(paths);
  const pid = readRunningPid(paths);
  const restart = daemonRestartStatus(paths);
  if (!pid) {
    return { running: false, socketPath, ...(restart ? { restart } : {}) };
  }

  try {
    const status = await (io.daemonStatusFromService ?? requestDaemonStatus)(paths);
    return {
      running: true,
      pid,
      socketPath,
      stateDbPath: paths.databasePath,
      startedAt: statSync(paths.pidFile).mtime.toISOString(),
      servers: status.servers,
      invocations: status.invocations,
      lifecycle: status.lifecycle,
    };
  } catch (error) {
    return {
      running: false,
      unreachable: true,
      pid,
      socketPath,
      stateDbPath: paths.databasePath,
      startedAt: statSync(paths.pidFile).mtime.toISOString(),
      error: errorMessage(error),
      ...(restart ? { restart } : {}),
    };
  }
}

function daemonRestartStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
): DaemonRestartStatus | undefined {
  const restart = readSparkDaemonActiveRestart(paths);
  if (!restart) return undefined;
  return {
    state: restart.state,
    restartId: restart.restartId,
    requestedAt: restart.requestedAt,
    previousPid: restart.previousPid,
    previousInstanceId: restart.previousInstanceId,
    previousGeneration: restart.previousGeneration,
    targetInstanceId: restart.targetInstanceId,
    targetGeneration: restart.targetGeneration,
  };
}
