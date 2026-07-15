import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { launchctlCommand, type SparkPaths } from "@zendev-lab/spark-system";
import { requestSparkDaemonLocalRpcWire } from "@zendev-lab/spark-system/daemon-local-rpc";
import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";

const launchdLabel = "dev.spark.daemon";
const restartIntentFileName = "restart.intent.json";
const restartStartingFileName = "restart.starting.json";

export interface SparkDaemonRestartIntent {
  restartId: string;
  previousPid: number;
  previousInstanceId: string;
  previousGeneration: string;
  previousStartedAt: string;
  previousProcessStartToken: string;
  targetInstanceId: string;
  targetGeneration: string;
  protocolVersion: typeof SPARK_PROTOCOL_VERSION;
  requestedAt: string;
}

export interface SparkDaemonRestartSchedule extends SparkDaemonRestartIntent {
  helperPid?: number;
  helperProcessStartToken?: string;
}

export interface SparkDaemonRestartSuccessorContext {
  acceptedRestartId: string;
  instanceId: string;
  generation: string;
  predecessorInstanceId: string;
  predecessorGeneration: string;
}

export interface SparkDaemonServiceResult {
  kind: "launchd" | "detached";
  alreadyRunning: boolean;
  detail: string;
  ownership?: "spawned" | "observed";
  /** Spawned or observed process, used to fence a pre-pidfile cancellation race. */
  pid?: number;
  processStartToken?: string;
}

export function startSparkDaemonService(paths: SparkPaths): SparkDaemonServiceResult {
  if (process.platform === "darwin") {
    return startLaunchdService(paths);
  }

  return startDetachedSparkDaemon(paths);
}

export function stopSparkDaemonService(paths: SparkPaths): SparkDaemonServiceResult | null {
  if (process.platform === "darwin") {
    const stopped = stopSparkDaemonLaunchdLabel();
    if (stopped) return stopped;
  }

  return stopPidFileProcess(paths);
}

/** Cancel a detached successor that has been armed but has not started yet. */
export function cancelSparkDaemonRestartSuccessor(paths: SparkPaths): boolean {
  let cancelled = false;
  for (const path of [restartIntentPath(paths), restartStartingPath(paths)]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    cancelled = true;
  }
  if (cancelled) fsyncDirectory(paths.runtimeDir);
  return cancelled;
}

/**
 * Arm a process-independent successor before admission draining begins. The
 * helper first confirms it is resident, then the durable intent is written.
 * Admission may close only after this function resolves.
 */
export async function scheduleSparkDaemonRestartSuccessor(
  paths: SparkPaths,
  previousPid: number,
  previousIdentity: { instanceId: string; generation: string; startedAt: string },
  requestedAt = new Date().toISOString(),
  options: {
    signal?: AbortSignal;
    helperReadyTimeoutMs?: number;
    helperCommand?: string[];
    helperEnv?: NodeJS.ProcessEnv;
  } = {},
): Promise<SparkDaemonRestartSchedule> {
  // launchd normally wins on macOS; the helper remains as a fenced watchdog
  // and only re-registers the job if no RPC-ready replacement appears.
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const existing = readRestartFence(paths);
  if (existing && existing.previousPid !== previousPid) {
    throw new Error(
      `Spark daemon restart ${existing.restartId} is still completing for process ${existing.previousPid}.`,
    );
  }
  if (
    existing &&
    (existing.previousInstanceId !== previousIdentity.instanceId ||
      existing.previousGeneration !== previousIdentity.generation)
  ) {
    throw new Error(`Spark daemon restart fence generation mismatch for process ${previousPid}.`);
  }
  const intent: SparkDaemonRestartIntent = existing ?? {
    restartId: randomUUID(),
    previousPid,
    previousInstanceId: previousIdentity.instanceId,
    previousGeneration: previousIdentity.generation,
    previousStartedAt: previousIdentity.startedAt,
    previousProcessStartToken:
      processStartToken(previousPid) ??
      (() => {
        throw new Error(`Cannot identify Spark daemon process ${previousPid} for restart.`);
      })(),
    targetInstanceId: randomUUID(),
    targetGeneration: randomUUID(),
    protocolVersion: SPARK_PROTOCOL_VERSION,
    requestedAt,
  };
  if (options.signal?.aborted) throw options.signal.reason;
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  const stdout = openSync(join(paths.logDir, "service.stdout.log"), "a", 0o600);
  const stderr = openSync(join(paths.logDir, "service.stderr.log"), "a", 0o600);
  const command = options.helperCommand ?? sparkDaemonCliCommand();
  let helperPid: number | undefined;
  let helperProcessStartToken: string | undefined;
  let publishedNewIntent = false;
  try {
    const child = spawn(
      command[0]!,
      [...command.slice(1), "__restart-successor", String(previousPid), intent.restartId],
      {
        detached: true,
        env: { ...process.env, ...options.helperEnv },
        stdio: ["ignore", stdout, stderr, "ipc"],
      },
    );
    if (!child.pid) throw new Error("Spark daemon restart helper did not receive a process id.");
    helperPid = child.pid;
    helperProcessStartToken = processStartToken(child.pid) ?? undefined;
    await armRestartHelper(
      child,
      intent,
      () => {
        if (!existing) {
          writeRestartIntentDurably(paths, intent);
          publishedNewIntent = true;
        }
      },
      options.helperReadyTimeoutMs ?? 5_000,
      options.signal,
    );
    if (options.signal?.aborted) throw options.signal.reason;
    child.disconnect();
    child.unref();
    helperProcessStartToken ??= processStartToken(child.pid) ?? undefined;
    return {
      ...intent,
      helperPid: child.pid,
      ...(helperProcessStartToken ? { helperProcessStartToken } : {}),
    };
  } catch (error) {
    // Do not revoke an existing fence merely because a redundant watchdog
    // failed to start. A newly published fence must be revoked because no
    // helper proved it loaded the exact committed identity.
    if (publishedNewIntent) cancelSparkDaemonRestartSuccessor(paths);
    if (
      helperPid &&
      helperProcessStartToken &&
      processStartToken(helperPid) === helperProcessStartToken
    ) {
      try {
        process.kill(helperPid, "SIGTERM");
      } catch {
        // Helper already exited on its own failure path.
      }
    }
    throw error;
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

/** Read the restart fence a newly acquired daemon generation is expected to satisfy. */
export function readSparkDaemonRestartSuccessorContext(
  paths: SparkPaths,
): SparkDaemonRestartSuccessorContext | null {
  const intent = readRestartFence(paths);
  if (!intent || predecessorProcessMatches(intent)) {
    return null;
  }
  return {
    acceptedRestartId: intent.restartId,
    instanceId: intent.targetInstanceId,
    generation: intent.targetGeneration,
    predecessorInstanceId: intent.previousInstanceId,
    predecessorGeneration: intent.previousGeneration,
  };
}

/** Internal successor entrypoint; it never runs concurrently as an active daemon. */
export async function runSparkDaemonRestartSuccessor(
  paths: SparkPaths,
  previousPid: number,
  options: {
    previousExitTimeoutMs?: number;
    supervisorGraceMs?: number;
    pollIntervalMs?: number;
    processAlive?: (pid: number) => boolean;
    runningPid?: () => number | null;
    startService?: () => SparkDaemonServiceResult;
    stopStartedService?: (service: SparkDaemonServiceResult) => void;
    expectedRestartId?: string;
    intentArmTimeoutMs?: number;
    onIntentArmed?: (intent: SparkDaemonRestartIntent) => void | Promise<void>;
    restartIntentActive?: () => boolean;
    claimRestartIntent?: () => boolean;
    restartClaimActive?: () => boolean;
    completeRestartIntent?: () => void;
    startedReadyTimeoutMs?: number;
    replacementReady?: (pid: number) => Promise<boolean>;
    maxStartAttempts?: number;
  } = {},
): Promise<SparkDaemonServiceResult | null> {
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  if (options.expectedRestartId && options.intentArmTimeoutMs !== undefined) {
    const armDeadline = Date.now() + options.intentArmTimeoutMs;
    while (!restartIntentMatches(paths, previousPid, options.expectedRestartId)) {
      if (Date.now() >= armDeadline) return null;
      await delay(pollIntervalMs);
    }
  }
  const expectedIntent = readRestartFence(paths);
  if (
    options.expectedRestartId &&
    (!expectedIntent ||
      expectedIntent.restartId !== options.expectedRestartId ||
      expectedIntent.previousPid !== previousPid)
  ) {
    return null;
  }
  if (expectedIntent && options.onIntentArmed) await options.onIntentArmed(expectedIntent);
  const expectedRestartId = options.expectedRestartId ?? expectedIntent?.restartId;
  const processAlive =
    options.processAlive ??
    (() =>
      expectedIntent ? predecessorProcessMatches(expectedIntent) : isProcessAlive(previousPid));
  const runningPid = options.runningPid ?? (() => readRunningPid(paths));
  const startService = options.startService ?? (() => startSparkDaemonService(paths));
  const stopStartedService =
    options.stopStartedService ??
    ((service: SparkDaemonServiceResult) => stopSparkDaemonRestartStartedService(paths, service));
  const restartIntentActive =
    options.restartIntentActive ??
    (() => restartIntentMatches(paths, previousPid, expectedRestartId));
  const claimRestartIntent =
    options.claimRestartIntent ??
    (() => claimRestartIntentFor(paths, previousPid, expectedRestartId));
  const restartClaimActive =
    options.restartClaimActive ??
    (() => restartClaimMatches(paths, previousPid, expectedRestartId));
  const completeRestartIntent = options.completeRestartIntent ?? (() => clearRestartClaim(paths));
  const replacementReady =
    options.replacementReady ??
    (async (pid) =>
      expectedRestartId
        ? await probeSparkDaemonReady(paths, {
            expectedPid: pid,
            expectedRestartId,
            targetInstanceId: expectedIntent?.targetInstanceId,
            targetGeneration: expectedIntent?.targetGeneration,
          })
        : false);
  const waitForClaimedReplacement = async (
    initialService: SparkDaemonServiceResult,
  ): Promise<SparkDaemonServiceResult | null> => {
    let service = initialService;
    let startAttempts = 1;
    const startedReadyTimeoutMs = options.startedReadyTimeoutMs ?? 30_000;
    const startedDeadline = Date.now() + startedReadyTimeoutMs;
    while (true) {
      if (!restartClaimActive()) {
        stopStartedService(service);
        return null;
      }
      const replacementPid = runningPid();
      if (
        replacementPid &&
        replacementPid !== previousPid &&
        (await replacementReady(replacementPid))
      ) {
        completeRestartIntent();
        return service;
      }
      if (
        service.kind === "detached" &&
        !service.alreadyRunning &&
        !sparkDaemonRestartStartedServiceAlive(service) &&
        startAttempts < (options.maxStartAttempts ?? 3)
      ) {
        startAttempts += 1;
        await delay(Math.max(pollIntervalMs, 100));
        if (!restartClaimActive()) {
          stopStartedService(service);
          return null;
        }
        service = startService();
        continue;
      }
      if (Date.now() >= startedDeadline) {
        stopStartedService(service);
        completeRestartIntent();
        throw new Error(
          `Spark daemon restart successor did not become ready within ${startedReadyTimeoutMs}ms.`,
        );
      }
      await delay(pollIntervalMs);
    }
  };
  const previousExitDeadline =
    options.previousExitTimeoutMs === undefined
      ? undefined
      : Date.now() + options.previousExitTimeoutMs;
  while (processAlive(previousPid)) {
    if (!restartIntentActive()) return null;
    if (previousExitDeadline !== undefined && Date.now() >= previousExitDeadline) {
      throw new Error(`Spark daemon process ${previousPid} did not exit for restart handoff.`);
    }
    await delay(pollIntervalMs);
  }

  if (!restartIntentActive()) return null;
  // Claim immediately after predecessor exit. This makes the expected restart
  // identity visible to a launchd/systemd replacement before readiness is
  // probed, rather than racing the new process startup.
  if (!claimRestartIntent() || !restartClaimActive()) return null;

  const supervisorDeadline =
    Date.now() + (options.supervisorGraceMs ?? (process.platform === "darwin" ? 30_000 : 2_000));
  while (Date.now() < supervisorDeadline) {
    if (!restartClaimActive()) return null;
    const replacementPid = runningPid();
    if (replacementPid && replacementPid !== previousPid) {
      return await waitForClaimedReplacement({
        kind: process.platform === "darwin" ? "launchd" : "detached",
        alreadyRunning: true,
        detail: `Spark daemon supervisor started replacement process ${replacementPid}.`,
        ownership: "observed",
        pid: replacementPid,
      });
    }
    await delay(pollIntervalMs);
  }
  if (!restartClaimActive()) return null;

  let service: SparkDaemonServiceResult;
  try {
    service = startService();
  } catch (error) {
    completeRestartIntent();
    throw error;
  }

  return await waitForClaimedReplacement(service);
}

async function probeSparkDaemonReady(
  paths: SparkPaths,
  expected: {
    expectedPid: number;
    expectedRestartId: string;
    targetInstanceId?: string;
    targetGeneration?: string;
  },
): Promise<boolean> {
  try {
    const status = await requestSparkDaemonLocalRpcWire<{
      lifecycle?: {
        state?: unknown;
        process?: {
          pid?: unknown;
          instanceId?: unknown;
          generation?: unknown;
          protocolVersion?: unknown;
          acceptedRestartId?: unknown;
        };
      };
    }>(
      { id: `restart_successor_${process.pid}_${Date.now()}`, method: "daemon.status" },
      { paths },
    );
    return matchesSparkDaemonRestartReplacement(status, expected);
  } catch {
    return false;
  }
}

export function matchesSparkDaemonRestartReplacement(
  status: {
    lifecycle?: {
      state?: unknown;
      process?: {
        pid?: unknown;
        instanceId?: unknown;
        generation?: unknown;
        protocolVersion?: unknown;
        acceptedRestartId?: unknown;
      };
    };
  },
  expected: {
    expectedPid: number;
    expectedRestartId: string;
    targetInstanceId?: string;
    targetGeneration?: string;
  },
): boolean {
  const processIdentity = status.lifecycle?.process;
  return (
    status.lifecycle?.state === "running" &&
    processIdentity?.pid === expected.expectedPid &&
    processIdentity.instanceId === expected.targetInstanceId &&
    processIdentity.generation === expected.targetGeneration &&
    processIdentity.protocolVersion === SPARK_PROTOCOL_VERSION &&
    processIdentity.acceptedRestartId === expected.expectedRestartId
  );
}

function restartIntentPath(paths: SparkPaths): string {
  return join(paths.runtimeDir, restartIntentFileName);
}

function restartStartingPath(paths: SparkPaths): string {
  return join(paths.runtimeDir, restartStartingFileName);
}

function restartIntentMatches(paths: SparkPaths, previousPid: number, restartId?: string): boolean {
  return restartFenceMatches(
    readRestartIntentFile(restartIntentPath(paths)),
    previousPid,
    restartId,
  );
}

function claimRestartIntentFor(
  paths: SparkPaths,
  previousPid: number,
  restartId?: string,
): boolean {
  if (!restartIntentMatches(paths, previousPid, restartId)) return false;
  try {
    renameSync(restartIntentPath(paths), restartStartingPath(paths));
    fsyncDirectory(paths.runtimeDir);
    return restartClaimMatches(paths, previousPid, restartId);
  } catch {
    return false;
  }
}

function restartClaimMatches(paths: SparkPaths, previousPid: number, restartId?: string): boolean {
  return restartFenceMatches(
    readRestartIntentFile(restartStartingPath(paths)),
    previousPid,
    restartId,
  );
}

function clearRestartClaim(paths: SparkPaths): void {
  rmSync(restartStartingPath(paths), { force: true });
  fsyncDirectory(paths.runtimeDir);
}

function writeRestartIntentDurably(paths: SparkPaths, intent: SparkDaemonRestartIntent): void {
  const target = restartIntentPath(paths);
  if (existsSync(target) || existsSync(restartStartingPath(paths))) {
    throw new Error("Spark daemon restart intent changed while a helper was being armed.");
  }
  const temporary = join(paths.runtimeDir, `.restart.intent.${process.pid}.${randomUUID()}.tmp`);
  let file: number | undefined;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeFileSync(file, `${JSON.stringify(intent)}\n`, "utf8");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    renameSync(temporary, target);
    fsyncDirectory(paths.runtimeDir);
  } catch (error) {
    if (file !== undefined) closeSync(file);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  try {
    const directory = openSync(path, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // Some filesystems do not support directory fsync. The atomically
    // renamed, fsynced file remains the source of truth.
  }
}

function readRestartFence(paths: SparkPaths): SparkDaemonRestartIntent | null {
  return (
    readRestartIntentFile(restartStartingPath(paths)) ??
    readRestartIntentFile(restartIntentPath(paths))
  );
}

function readRestartIntentFile(path: string): SparkDaemonRestartIntent | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      typeof value.restartId !== "string" ||
      value.restartId.length === 0 ||
      !Number.isInteger(value.previousPid) ||
      Number(value.previousPid) <= 0 ||
      typeof value.previousInstanceId !== "string" ||
      value.previousInstanceId.length === 0 ||
      typeof value.previousGeneration !== "string" ||
      value.previousGeneration.length === 0 ||
      typeof value.previousStartedAt !== "string" ||
      typeof value.previousProcessStartToken !== "string" ||
      value.previousProcessStartToken.length === 0 ||
      typeof value.targetInstanceId !== "string" ||
      value.targetInstanceId.length === 0 ||
      typeof value.targetGeneration !== "string" ||
      value.targetGeneration.length === 0 ||
      value.protocolVersion !== SPARK_PROTOCOL_VERSION ||
      typeof value.requestedAt !== "string"
    ) {
      return null;
    }
    return {
      restartId: value.restartId,
      previousPid: Number(value.previousPid),
      previousInstanceId: value.previousInstanceId,
      previousGeneration: value.previousGeneration,
      previousStartedAt: value.previousStartedAt,
      previousProcessStartToken: value.previousProcessStartToken,
      targetInstanceId: value.targetInstanceId,
      targetGeneration: value.targetGeneration,
      protocolVersion: SPARK_PROTOCOL_VERSION,
      requestedAt: value.requestedAt,
    };
  } catch {
    return null;
  }
}

function restartFenceMatches(
  intent: SparkDaemonRestartIntent | null,
  previousPid: number,
  restartId?: string,
): boolean {
  return Boolean(
    intent &&
    intent.previousPid === previousPid &&
    (restartId === undefined || intent.restartId === restartId),
  );
}

async function armRestartHelper(
  child: ReturnType<typeof spawn>,
  intent: SparkDaemonRestartIntent,
  publishIntent: () => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let ready = false;
    let committed = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () =>
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Spark daemon restart arming was cancelled."),
      );
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signalName: NodeJS.Signals | null) =>
      finish(
        new Error(
          `Spark daemon restart helper exited before readiness (${code ?? signalName ?? "unknown"}).`,
        ),
      );
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (
        message.type === "spark-daemon-restart-helper-ready" &&
        "restartId" in message &&
        message.restartId === intent.restartId &&
        !ready
      ) {
        ready = true;
        try {
          publishIntent();
          committed = true;
          child.send(
            {
              type: "spark-daemon-restart-intent-committed",
              restartId: intent.restartId,
            },
            (error) => {
              if (error) finish(error);
            },
          );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (
        message.type === "spark-daemon-restart-helper-armed" &&
        "restartId" in message &&
        message.restartId === intent.restartId &&
        "targetInstanceId" in message &&
        message.targetInstanceId === intent.targetInstanceId &&
        "targetGeneration" in message &&
        message.targetGeneration === intent.targetGeneration &&
        ready &&
        committed
      ) {
        finish();
      }
    };
    const timer = setTimeout(
      () =>
        finish(new Error(`Spark daemon restart helper was not fully armed within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    timer.unref();
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function predecessorProcessMatches(intent: SparkDaemonRestartIntent): boolean {
  return isSparkDaemonRestartPredecessorAlive(intent);
}

/**
 * Conservatively fence the predecessor when its OS birth token cannot be
 * observed transiently. A different non-null token proves PID reuse; a null
 * token alone does not prove process exit.
 */
export function isSparkDaemonRestartPredecessorAlive(
  intent: Pick<SparkDaemonRestartIntent, "previousPid" | "previousProcessStartToken">,
  options: {
    readProcessStartToken?: (pid: number) => string | null;
    processAlive?: (pid: number) => boolean;
  } = {},
): boolean {
  const token = (options.readProcessStartToken ?? processStartToken)(intent.previousPid);
  if (token !== null) return token === intent.previousProcessStartToken;
  return (options.processAlive ?? isProcessAlive)(intent.previousPid);
}

export function stopSparkDaemonRestartStartedService(
  paths: SparkPaths,
  service: SparkDaemonServiceResult,
  options: {
    readProcessStartToken?: (pid: number) => string | null;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    stopLaunchd?: (paths: SparkPaths) => void;
  } = {},
): void {
  if (service.kind === "launchd") {
    (options.stopLaunchd ?? (() => void stopSparkDaemonLaunchdLabel()))(paths);
    return;
  }
  if (
    service.ownership !== "spawned" ||
    !service.pid ||
    !service.processStartToken ||
    (options.readProcessStartToken ?? processStartToken)(service.pid) !== service.processStartToken
  ) {
    return;
  }
  try {
    (options.kill ?? ((pid, signal) => process.kill(pid, signal)))(service.pid, "SIGTERM");
  } catch {
    // The exact spawned child already exited.
  }
}

function stopSparkDaemonLaunchdLabel(): SparkDaemonServiceResult | null {
  if (process.platform !== "darwin") return null;
  const uid = readCurrentUid();
  const target = `gui/${uid}/${launchdLabel}`;
  const stopped = runLaunchctl(["bootout", target]);
  return stopped.status === 0
    ? {
        kind: "launchd",
        alreadyRunning: false,
        detail: `Stopped Spark daemon ${launchdLabel}.`,
      }
    : null;
}

export function isSparkDaemonRestartHelperDefinitelyDead(
  schedule: Pick<SparkDaemonRestartSchedule, "helperPid" | "helperProcessStartToken">,
  options: {
    readProcessStartToken?: (pid: number) => string | null;
    processAlive?: (pid: number) => boolean;
  } = {},
): boolean {
  if (!schedule.helperPid) return false;
  const token = (options.readProcessStartToken ?? processStartToken)(schedule.helperPid);
  if (token !== null && schedule.helperProcessStartToken) {
    return token !== schedule.helperProcessStartToken;
  }
  return !(options.processAlive ?? isProcessAlive)(schedule.helperPid);
}

function sparkDaemonRestartStartedServiceAlive(service: SparkDaemonServiceResult): boolean {
  if (!service.pid) return false;
  if (!service.processStartToken) return isProcessAlive(service.pid);
  const token = processStartToken(service.pid);
  if (token !== null) return token === service.processStartToken;
  return isProcessAlive(service.pid);
}

function processStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      return startTime ? `linux:${startTime}` : null;
    } catch {
      return null;
    }
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const startedAt = result.status === 0 ? result.stdout.trim() : "";
  return startedAt ? `${process.platform}:${startedAt}` : null;
}

function startLaunchdService(paths: SparkPaths): SparkDaemonServiceResult {
  const uid = readCurrentUid();
  const plistPath = writeLaunchdPlist(paths);
  const target = `gui/${uid}/${launchdLabel}`;

  runLaunchctl(["bootout", target]);
  runLaunchctl(["bootout", `gui/${uid}`, plistPath]);
  const bootstrap = runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
  if (bootstrap.status !== 0) {
    throw new Error(`Failed to register Spark daemon: ${bootstrap.stderr || bootstrap.stdout}`);
  }

  const kickstart = runLaunchctl(["kickstart", "-k", target]);
  if (kickstart.status !== 0) {
    throw new Error(`Failed to start Spark daemon: ${kickstart.stderr || kickstart.stdout}`);
  }

  return {
    kind: "launchd",
    alreadyRunning: false,
    detail: `Started Spark daemon ${launchdLabel}.`,
  };
}

function writeLaunchdPlist(paths: SparkPaths): string {
  const home = process.env.HOME || homedir();
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, `${launchdLabel}.plist`);
  mkdirSync(launchAgentsDir, { recursive: true, mode: 0o755 });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });

  const programArguments = sparkDaemonStartCommand();
  const stdoutPath = join(paths.logDir, "service.stdout.log");
  const stderrPath = join(paths.logDir, "service.stderr.log");
  const environment = serviceEnvironment();

  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(launchdLabel)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment)
  .map(
    ([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
  )
  .join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(process.cwd())}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`,
    { encoding: "utf8", mode: 0o644 },
  );

  return plistPath;
}

function startDetachedSparkDaemon(paths: SparkPaths): SparkDaemonServiceResult {
  const runningPid = readRunningPid(paths);
  if (runningPid) {
    return {
      kind: "detached",
      alreadyRunning: true,
      detail: `Spark daemon is already running as process ${runningPid}.`,
      ownership: "observed",
      pid: runningPid,
    };
  }

  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  const stdout = openSync(join(paths.logDir, "service.stdout.log"), "a", 0o600);
  const stderr = openSync(join(paths.logDir, "service.stderr.log"), "a", 0o600);
  const command = sparkDaemonStartCommand();
  const child = spawn(command[0]!, command.slice(1), {
    detached: true,
    env: process.env,
    stdio: ["ignore", stdout, stderr],
  });
  child.once("error", (error) => {
    console.error("[spark-daemon] detached service failed to spawn", error);
  });
  child.unref();
  const childStartToken = child.pid ? processStartToken(child.pid) : null;

  return {
    kind: "detached",
    alreadyRunning: false,
    detail: `Started Spark daemon in the background as process ${child.pid}.`,
    ownership: "spawned",
    ...(child.pid ? { pid: child.pid } : {}),
    ...(childStartToken ? { processStartToken: childStartToken } : {}),
  };
}

function stopPidFileProcess(paths: SparkPaths): SparkDaemonServiceResult | null {
  const runningPid = readRunningPid(paths);
  if (!runningPid) {
    return null;
  }

  process.kill(runningPid, "SIGTERM");
  return {
    kind: "detached",
    alreadyRunning: false,
    detail: `Stopped Spark daemon process ${runningPid}.`,
  };
}

export function readRunningPid(paths: SparkPaths): number | null {
  if (!existsSync(paths.pidFile)) {
    return null;
  }

  const pid = Number(readFileSync(paths.pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function sparkDaemonStartCommand(): string[] {
  return [...sparkDaemonCliCommand(), "start"];
}

function sparkDaemonCliCommand(): string[] {
  const cliPath = realpathSync(process.argv[1] ?? fileURLToPath(import.meta.url));
  return [process.execPath, cliPath];
}

function serviceEnvironment(): Record<string, string> {
  const keys = [
    "HOME",
    "PATH",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "SPARK_DAEMON_DATA_DIR",
    "SPARK_DAEMON_CACHE_DIR",
    "SPARK_DAEMON_STATE_DIR",
    "SPARK_DAEMON_RUNTIME_DIR",
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function runLaunchctl(args: string[]) {
  return spawnSync(launchctlCommand(), args, { encoding: "utf8" });
}

function readCurrentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("launchd service registration requires a POSIX user id.");
  }
  return uid;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
