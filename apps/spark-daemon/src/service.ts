import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import { launchctlCommand, type SparkPaths } from "@zendev-lab/spark-system";
import { requestSparkDaemonLocalRpcWire } from "@zendev-lab/spark-daemon-client/local-rpc";
import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";
import { cappedExponentialCeiling } from "@zendev-lab/spark-retry";

const launchdLabel = "dev.spark.daemon";
const restartIntentFileName = "restart.intent.json";
const restartStartingFileName = "restart.starting.json";
const restartTerminalFilePrefix = "restart.terminal.";
const restartTerminalFileSuffix = ".json";
const legacyRestartTerminalFileName = "restart.terminal.json";
const processIdentityFileName = "daemon.identity.json";
const processOwnershipMutexName = "daemon.identity.lock";
const restartStartRetryBaseMs = 100;
const restartStartRetryMaxMs = 5_000;

type SparkDaemonRestartRecordState = "armed" | "claimed" | "cancelled" | "completed";

export interface SparkDaemonRestartIntent {
  restartId: string;
  previousPid: number;
  previousInstanceId: string;
  previousGeneration: string;
  previousStartedAt: string;
  previousProcessStartToken: string;
  targetInstanceId: string;
  targetGeneration: string;
  targetVersion?: string;
  targetBuildFingerprint?: string;
  protocolVersion: typeof SPARK_PROTOCOL_VERSION;
  requestedAt: string;
  /** Whether the predecessor is owned by a supervisor that may replace it on exit. */
  supervisorManaged?: boolean;
}

export type SparkDaemonActiveRestart = SparkDaemonRestartIntent & {
  state: "armed" | "claimed";
};

interface SparkDaemonRestartRecord extends SparkDaemonRestartIntent {
  state: SparkDaemonRestartRecordState;
}

type SparkDaemonRestartTerminalRecord = SparkDaemonRestartRecord & {
  state: "cancelled" | "completed";
};

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
  targetVersion?: string;
  targetBuildFingerprint?: string;
}

export interface SparkDaemonRestartTerminal {
  state: "cancelled" | "completed";
  restartId: string;
  previousPid: number;
  targetInstanceId: string;
  targetGeneration: string;
  targetVersion?: string;
  targetBuildFingerprint?: string;
}

export interface SparkDaemonRestartRetryFailure {
  phase: "start" | "readiness";
  attempt: number;
  error: Error;
  service?: SparkDaemonServiceResult;
}

export interface SparkDaemonProcessOwnership {
  pid: number;
  processStartToken: string;
  instanceId: string;
  generation: string;
}

export type SparkDaemonRestartStartDecision =
  | { start: false; reason: "cancelled" | "completed" | "missing" | "superseded" }
  | { start: true; successorContext: SparkDaemonRestartSuccessorContext | null };

export interface SparkDaemonServiceResult {
  kind: "launchd" | "detached";
  alreadyRunning: boolean;
  detail: string;
  ownership?: "spawned" | "observed";
  /** Spawned or observed process, used to fence a pre-pidfile cancellation race. */
  pid?: number;
  processStartToken?: string;
}

export function startSparkDaemonService(
  paths: SparkPaths,
  options: { expectedRestartId?: string } = {},
): SparkDaemonServiceResult {
  if (process.platform === "darwin") {
    return startLaunchdService(paths);
  }

  return startDetachedSparkDaemon(paths, options.expectedRestartId);
}

export function stopSparkDaemonService(paths: SparkPaths): SparkDaemonServiceResult | null {
  if (process.platform === "darwin") {
    return stopSparkDaemonLaunchdLabel();
  }

  return stopSparkDaemonPidFileProcess(paths);
}

/**
 * Durably cancel the exact active restart before removing its transient files.
 * The terminal tombstone is authoritative over a helper that already observed
 * an Armed/Claimed record, closing the check-then-start race with `stop`.
 */
export function cancelSparkDaemonRestartSuccessor(
  paths: SparkPaths,
  expected?: { previousPid: number; restartId: string },
): boolean {
  const active = readRestartActiveRecord(paths);
  const terminal = readRestartTerminalRecord(paths, expected?.restartId);
  if (
    expected &&
    (!active ||
      active.previousPid !== expected.previousPid ||
      active.restartId !== expected.restartId)
  ) {
    return terminal?.state === "cancelled";
  }
  if (!active) return terminal?.state === "cancelled";
  writeRestartTerminalDurably(paths, { ...active, state: "cancelled" });
  removeRestartActiveRecord(paths, active.restartId);
  return true;
}

/** Public/manual start supersedes an earlier terminal restart decision. */
export function clearSparkDaemonRestartFenceForExplicitStart(paths: SparkPaths): void {
  for (const path of [
    restartIntentPath(paths),
    restartStartingPath(paths),
    ...restartTerminalPaths(paths),
  ]) {
    rmSync(path, { force: true });
  }
  fsyncDirectory(paths.runtimeDir);
}

/**
 * Read the exact durable restart operation that still owns the handoff fence.
 * Matching terminal records suppress the projection, so callers never report
 * a completed or cancelled operation as active merely because a stale
 * transient file remains on disk.
 */
export function readSparkDaemonActiveRestart(paths: SparkPaths): SparkDaemonActiveRestart | null {
  const active = readRestartActiveRecord(paths);
  if (!active || (active.state !== "armed" && active.state !== "claimed")) return null;
  return { ...active, state: active.state };
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
    supervisorManaged?: boolean;
    targetVersion?: string;
    targetBuildFingerprint?: string;
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
  if (
    existing &&
    (existing.targetVersion !== options.targetVersion ||
      existing.targetBuildFingerprint !== options.targetBuildFingerprint)
  ) {
    throw new Error(`Spark daemon restart ${existing.restartId} targets a different build.`);
  }
  const intent: SparkDaemonRestartIntent = existing ?? {
    restartId: randomUUID(),
    previousPid,
    previousInstanceId: previousIdentity.instanceId,
    previousGeneration: previousIdentity.generation,
    previousStartedAt: previousIdentity.startedAt,
    previousProcessStartToken:
      processStartTokenForPid(previousPid) ??
      (() => {
        throw new Error(`Cannot identify Spark daemon process ${previousPid} for restart.`);
      })(),
    targetInstanceId: randomUUID(),
    targetGeneration: randomUUID(),
    protocolVersion: SPARK_PROTOCOL_VERSION,
    requestedAt,
    supervisorManaged: options.supervisorManaged === true,
    ...(options.targetVersion ? { targetVersion: options.targetVersion } : {}),
    ...(options.targetBuildFingerprint
      ? { targetBuildFingerprint: options.targetBuildFingerprint }
      : {}),
  };
  if (!existing) {
    // A running daemon owns the process lock while arming a new restart, so it
    // may safely supersede an older terminal tombstone before publishing the
    // new restart id. Delayed helpers for the old id then observe supersession.
    for (const path of restartTerminalPaths(paths)) rmSync(path, { force: true });
    rmSync(restartStartingPath(paths), { force: true });
    fsyncDirectory(paths.runtimeDir);
  }
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
    helperProcessStartToken = processStartTokenForPid(child.pid) ?? undefined;
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
    helperProcessStartToken ??= processStartTokenForPid(child.pid) ?? undefined;
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
      processStartTokenForPid(helperPid) === helperProcessStartToken
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
  const intent = readRestartActiveRecord(paths);
  if (!intent || predecessorProcessMatches(intent)) {
    return null;
  }
  return restartSuccessorContext(intent);
}

/**
 * Resolve daemon startup only after the process lock has been acquired. A
 * service-managed activation adopts the exact active generation; an expected
 * detached successor exits cleanly when its restart was cancelled/completed or
 * superseded. The readiness path performs the final state transition.
 */
export function prepareSparkDaemonRestartAwareStart(
  paths: SparkPaths,
  expectedRestartId?: string,
): SparkDaemonRestartStartDecision {
  let active = readRestartActiveRecord(paths);
  const terminal = readRestartTerminalRecord(paths, expectedRestartId ?? active?.restartId);
  if (expectedRestartId && terminal?.restartId === expectedRestartId) {
    return { start: false, reason: terminal.state };
  }

  if (expectedRestartId && (!active || active.restartId !== expectedRestartId)) {
    return { start: false, reason: active ? "superseded" : "missing" };
  }
  if (!active) {
    if (terminal?.state === "cancelled") return { start: false, reason: "cancelled" };
    if (terminal?.state === "completed") {
      for (const path of restartTerminalPaths(paths)) rmSync(path, { force: true });
      fsyncDirectory(paths.runtimeDir);
    }
    return { start: true, successorContext: null };
  }
  if (predecessorProcessMatches(active)) {
    return { start: false, reason: "missing" };
  }
  if (active.state === "armed") {
    if (!claimRestartIntentFor(paths, active.previousPid, active.restartId)) {
      return { start: false, reason: "superseded" };
    }
    active = readRestartActiveRecord(paths);
  }
  if (!active || active.state !== "claimed") {
    return { start: false, reason: "superseded" };
  }
  return { start: true, successorContext: restartSuccessorContext(active) };
}

/**
 * Complete the exact successor fence only after the caller has opened every
 * daemon admission gate and entered its synchronous serving transition. A
 * concurrent Cancelled tombstone wins and asks this process to exit.
 */
export function completeSparkDaemonRestartSuccessor(
  paths: SparkPaths,
  identity: {
    acceptedRestartId?: string;
    instanceId: string;
    generation: string;
  },
): boolean {
  if (!identity.acceptedRestartId) return true;
  const terminal = readRestartTerminalRecord(paths, identity.acceptedRestartId);
  if (terminal?.restartId === identity.acceptedRestartId) {
    return terminal.state === "completed";
  }
  const active = readRestartActiveRecord(paths);
  if (
    !active ||
    active.state !== "claimed" ||
    active.restartId !== identity.acceptedRestartId ||
    active.targetInstanceId !== identity.instanceId ||
    active.targetGeneration !== identity.generation
  ) {
    return false;
  }
  const completed = writeRestartTerminalDurably(paths, { ...active, state: "completed" });
  removeRestartActiveRecord(paths, active.restartId);
  return (
    completed || readRestartTerminalRecord(paths, identity.acceptedRestartId)?.state === "completed"
  );
}

/**
 * Read the durable terminal decision for one exact restart generation. The
 * caller supplies both predecessor pid and restart id so an older waiter can
 * never consume a later restart's tombstone after files are rotated.
 */
export function readSparkDaemonRestartTerminal(
  paths: SparkPaths,
  expected: { previousPid: number; restartId: string },
): SparkDaemonRestartTerminal | null {
  const terminal = readRestartTerminalRecord(paths, expected.restartId);
  if (
    !terminal ||
    terminal.previousPid !== expected.previousPid ||
    terminal.restartId !== expected.restartId
  ) {
    return null;
  }
  return {
    state: terminal.state,
    restartId: terminal.restartId,
    previousPid: terminal.previousPid,
    targetInstanceId: terminal.targetInstanceId,
    targetGeneration: terminal.targetGeneration,
    ...(terminal.targetVersion ? { targetVersion: terminal.targetVersion } : {}),
    ...(terminal.targetBuildFingerprint
      ? { targetBuildFingerprint: terminal.targetBuildFingerprint }
      : {}),
  };
}

/** Exact filesystem fallback used only when the helper's parent IPC vanishes. */
export function isSparkDaemonRestartArmed(
  paths: SparkPaths,
  previousPid: number,
  restartId: string,
): boolean {
  const active = readRestartActiveRecord(paths);
  return Boolean(
    active &&
    active.state === "armed" &&
    active.previousPid === previousPid &&
    active.restartId === restartId,
  );
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
    startService?: (expectedRestartId?: string) => SparkDaemonServiceResult;
    stopStartedService?: (service: SparkDaemonServiceResult) => void;
    expectedRestartId?: string;
    intentArmTimeoutMs?: number;
    onIntentArmed?: (intent: SparkDaemonRestartIntent) => void | Promise<void>;
    restartIntentActive?: () => boolean;
    claimRestartIntent?: () => boolean;
    restartClaimActive?: () => boolean;
    restartCompleted?: () => boolean;
    completeRestartIntent?: () => void;
    replacementReady?: (pid: number) => Promise<boolean>;
    sleep?: (delayMs: number) => Promise<void>;
    now?: () => number;
    startRetryBaseMs?: number;
    startRetryMaxMs?: number;
    /** Maximum time an exactly-owned spawned child may stay alive without RPC readiness. */
    replacementReadinessTimeoutMs?: number;
    /** Test/adapter seam for exact child liveness. */
    startedServiceAlive?: (service: SparkDaemonServiceResult) => boolean;
    /** Observability hook; production defaults to the helper's persisted stderr. */
    onRetryFailure?: (failure: SparkDaemonRestartRetryFailure) => void;
    /** Test/adapter seam for the live service-manager registration probe. */
    supervisorRegistered?: () => boolean;
  } = {},
): Promise<SparkDaemonServiceResult | null> {
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const sleep = options.sleep ?? (async (delayMs: number) => await delay(delayMs));
  const now = options.now ?? Date.now;
  if (options.expectedRestartId && options.intentArmTimeoutMs !== undefined) {
    const armDeadline = now() + options.intentArmTimeoutMs;
    while (!restartIntentMatches(paths, previousPid, options.expectedRestartId)) {
      if (now() >= armDeadline) return null;
      await sleep(pollIntervalMs);
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
  const startService =
    options.startService ?? ((restartId?: string) => startDetachedSparkDaemon(paths, restartId));
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
  const restartCompleted =
    options.restartCompleted ??
    (() => restartTerminalMatches(paths, previousPid, expectedRestartId, "completed"));
  const completeRestartIntent =
    options.completeRestartIntent ??
    (() => completeRestartClaim(paths, previousPid, expectedRestartId));
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
  const configuredReadinessTimeoutMs = options.replacementReadinessTimeoutMs;
  const replacementReadinessTimeoutMs =
    typeof configuredReadinessTimeoutMs === "number" &&
    Number.isFinite(configuredReadinessTimeoutMs)
      ? Math.max(1, Math.floor(configuredReadinessTimeoutMs))
      : 30_000;
  const startedServiceAlive = options.startedServiceAlive ?? sparkDaemonRestartStartedServiceAlive;
  const reportRetryFailure = (failure: SparkDaemonRestartRetryFailure) => {
    if (options.onRetryFailure) {
      try {
        options.onRetryFailure(failure);
        return;
      } catch (observerError) {
        console.error("[spark-daemon] restart retry observer failed", observerError);
      }
    }
    console.error(
      `[spark-daemon] restart successor ${failure.phase} attempt ${failure.attempt} failed; retrying`,
      failure.error,
    );
  };
  const waitForClaimedReplacement = async (
    initialService?: SparkDaemonServiceResult,
  ): Promise<SparkDaemonServiceResult | null> => {
    let service = initialService;
    let lastService = initialService;
    let serviceStartedAt = initialService ? now() : undefined;
    let failedStartAttempts = 0;
    while (true) {
      if (!restartClaimActive()) {
        if (restartCompleted()) return service ?? lastService ?? null;
        if (service) stopStartedService(service);
        return null;
      }
      const replacementPid = runningPid();
      if (
        replacementPid &&
        replacementPid !== previousPid &&
        (await replacementReady(replacementPid))
      ) {
        completeRestartIntent();
        return (
          service ??
          lastService ?? {
            kind: process.platform === "darwin" ? "launchd" : "detached",
            alreadyRunning: true,
            detail: `Spark daemon supervisor started replacement process ${replacementPid}.`,
            ownership: "observed",
            pid: replacementPid,
          }
        );
      }

      if (service) {
        const exactOwnedChild =
          service.kind === "detached" &&
          service.ownership === "spawned" &&
          Boolean(service.pid && service.processStartToken);
        const serviceMayStillBecomeReady =
          service.kind === "launchd" ||
          (service.pid
            ? startedServiceAlive(service)
            : replacementPid !== null && replacementPid !== previousPid);
        const readinessExpired =
          exactOwnedChild &&
          serviceMayStillBecomeReady &&
          serviceStartedAt !== undefined &&
          now() - serviceStartedAt >= replacementReadinessTimeoutMs;
        if (readinessExpired) {
          failedStartAttempts += 1;
          const error = new Error(
            `Spark daemon replacement process ${service.pid} stayed alive without RPC readiness for ${replacementReadinessTimeoutMs}ms.`,
          );
          reportRetryFailure({
            phase: "readiness",
            attempt: failedStartAttempts,
            error,
            service,
          });
          // stopStartedService is identity-fenced and refuses observed or
          // tokenless processes, so a stale watchdog cannot kill a later owner.
          stopStartedService(service);
          service = undefined;
          serviceStartedAt = undefined;
        } else if (serviceMayStillBecomeReady) {
          await sleep(pollIntervalMs);
          continue;
        } else {
          // The exact spawned child is already dead (or never acquired a pid).
          // Keep the Claimed fence and let the detached watchdog retry forever;
          // only an explicit Cancelled/Completed tombstone ends this loop.
          stopStartedService(service);
          service = undefined;
          serviceStartedAt = undefined;
          failedStartAttempts += 1;
        }
      }

      if (failedStartAttempts > 0) {
        await sleep(
          restartStartRetryDelayMs(
            failedStartAttempts,
            options.startRetryBaseMs,
            options.startRetryMaxMs,
          ),
        );
        if (!restartClaimActive()) {
          if (restartCompleted()) return lastService ?? null;
          return null;
        }
      }

      try {
        service = startService(expectedRestartId);
        lastService = service;
        serviceStartedAt = now();
      } catch (error) {
        failedStartAttempts += 1;
        reportRetryFailure({
          phase: "start",
          attempt: failedStartAttempts,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        // Spawn/service-manager failures are transient during replacement.
        // Preserve the durable claim and retry with capped backoff instead of
        // manufacturing a permanent Cancelled tombstone after a fixed count.
      }
    }
  };
  const previousExitDeadline =
    options.previousExitTimeoutMs === undefined ? undefined : now() + options.previousExitTimeoutMs;
  while (processAlive(previousPid)) {
    if (!restartIntentActive()) return null;
    if (previousExitDeadline !== undefined && now() >= previousExitDeadline) {
      throw new Error(`Spark daemon process ${previousPid} did not exit for restart handoff.`);
    }
    await sleep(pollIntervalMs);
  }

  if (!restartIntentActive()) return null;
  // Claim immediately after predecessor exit. This makes the expected restart
  // identity visible to a launchd/systemd replacement before readiness is
  // probed, rather than racing the new process startup.
  if (!claimRestartIntent() || !restartClaimActive()) return null;

  const supervisorMayRestart =
    expectedIntent?.supervisorManaged === true &&
    (options.supervisorRegistered?.() ?? isSparkDaemonSupervisorRegistered());
  const supervisorDeadline =
    now() +
    (options.supervisorGraceMs ??
      (supervisorMayRestart ? (process.platform === "darwin" ? 30_000 : 2_000) : 0));
  while (now() < supervisorDeadline) {
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
    await sleep(pollIntervalMs);
  }
  if (!restartClaimActive()) return null;

  return await waitForClaimedReplacement();
}

function restartStartRetryDelayMs(
  failedAttempts: number,
  configuredBaseMs?: number,
  configuredMaxMs?: number,
): number {
  const baseMs = Math.max(0, Math.floor(configuredBaseMs ?? restartStartRetryBaseMs));
  const maxMs = Math.max(baseMs, Math.floor(configuredMaxMs ?? restartStartRetryMaxMs));
  return cappedExponentialCeiling(failedAttempts, baseMs, maxMs, { exponentCap: 16 });
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

function restartTerminalPath(paths: SparkPaths, restartId: string): string {
  return join(
    paths.runtimeDir,
    `${restartTerminalFilePrefix}${encodeURIComponent(restartId)}${restartTerminalFileSuffix}`,
  );
}

function restartTerminalPaths(paths: SparkPaths): string[] {
  try {
    return readdirSync(paths.runtimeDir)
      .filter(
        (name) =>
          name === legacyRestartTerminalFileName ||
          (name.startsWith(restartTerminalFilePrefix) && name.endsWith(restartTerminalFileSuffix)),
      )
      .map((name) => join(paths.runtimeDir, name));
  } catch {
    return [];
  }
}

function processIdentityPath(paths: SparkPaths): string {
  return join(paths.runtimeDir, processIdentityFileName);
}

function restartIntentMatches(paths: SparkPaths, previousPid: number, restartId?: string): boolean {
  return restartFenceMatches(
    readRestartIntentFile(restartIntentPath(paths), "armed"),
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
    const claimed = readRestartIntentFile(restartStartingPath(paths), "claimed");
    if (claimed) writeRestartRecordDurably(restartStartingPath(paths), claimed, true);
    if (restartTerminalMatches(paths, previousPid, restartId)) {
      if (claimed) removeRestartActiveRecord(paths, claimed.restartId);
      else {
        rmSync(restartStartingPath(paths), { force: true });
        fsyncDirectory(paths.runtimeDir);
      }
      return false;
    }
    return restartClaimMatches(paths, previousPid, restartId);
  } catch {
    return false;
  }
}

function restartClaimMatches(paths: SparkPaths, previousPid: number, restartId?: string): boolean {
  const claimed = readRestartIntentFile(restartStartingPath(paths), "claimed");
  return (
    !restartTerminalMatches(paths, previousPid, restartId) &&
    restartFenceMatches(claimed, previousPid, restartId)
  );
}

function restartTerminalMatches(
  paths: SparkPaths,
  previousPid: number,
  restartId: string | undefined,
  state?: "cancelled" | "completed",
): boolean {
  const terminal = readRestartTerminalRecord(paths, restartId);
  return Boolean(
    terminal &&
    terminal.previousPid === previousPid &&
    (restartId === undefined || terminal.restartId === restartId) &&
    (state === undefined || terminal.state === state),
  );
}

function completeRestartClaim(paths: SparkPaths, previousPid: number, restartId?: string): void {
  const claimed = readRestartIntentFile(restartStartingPath(paths), "claimed");
  if (!restartFenceMatches(claimed, previousPid, restartId)) return;
  writeRestartTerminalDurably(paths, { ...claimed!, state: "completed" });
  removeRestartActiveRecord(paths, claimed!.restartId);
}

function writeRestartIntentDurably(paths: SparkPaths, intent: SparkDaemonRestartIntent): void {
  const target = restartIntentPath(paths);
  if (existsSync(target) || existsSync(restartStartingPath(paths))) {
    throw new Error("Spark daemon restart intent changed while a helper was being armed.");
  }
  writeRestartRecordDurably(target, { ...intent, state: "armed" }, false);
}

/** First terminal writer linearizes completion versus an explicit stop. */
function writeRestartTerminalDurably(paths: SparkPaths, record: SparkDaemonRestartRecord): boolean {
  const target = restartTerminalPath(paths, record.restartId);
  if (existsSync(target)) return false;
  const temporary = join(paths.runtimeDir, `.restart.terminal.${process.pid}.${randomUUID()}.tmp`);
  let file: number | undefined;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    linkSync(temporary, target);
    rmSync(temporary, { force: true });
    fsyncDirectory(paths.runtimeDir);
    return true;
  } catch (error) {
    if (file !== undefined) closeSync(file);
    rmSync(temporary, { force: true });
    if (existsSync(target)) return false;
    throw error;
  }
}

function writeRestartRecordDurably(
  target: string,
  record: SparkDaemonRestartRecord,
  replace: boolean,
): void {
  const directory = join(target, "..");
  const temporary = join(directory, `.restart.record.${process.pid}.${randomUUID()}.tmp`);
  let file: number | undefined;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    if (!replace && existsSync(target)) {
      throw new Error("Spark daemon restart record already exists.");
    }
    renameSync(temporary, target);
    fsyncDirectory(directory);
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
  return readRestartActiveRecord(paths);
}

function readRestartActiveRecord(paths: SparkPaths): SparkDaemonRestartRecord | null {
  const active =
    readRestartIntentFile(restartStartingPath(paths), "claimed") ??
    readRestartIntentFile(restartIntentPath(paths), "armed");
  if (!active) return null;
  const terminal = readRestartTerminalRecord(paths, active.restartId);
  return terminal?.restartId === active.restartId ? null : active;
}

function readRestartTerminalRecord(
  paths: SparkPaths,
  restartId?: string,
): SparkDaemonRestartTerminalRecord | null {
  const candidates = restartId
    ? [restartTerminalPath(paths, restartId), join(paths.runtimeDir, legacyRestartTerminalFileName)]
    : restartTerminalPaths(paths);
  const records = candidates
    .map((path) => readRestartIntentFile(path))
    .filter(
      (record): record is SparkDaemonRestartTerminalRecord =>
        (record?.state === "cancelled" || record?.state === "completed") &&
        (restartId === undefined || record.restartId === restartId),
    );
  return (
    records.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0] ?? null
  );
}

function readRestartIntentFile(
  path: string,
  expectedState?: "armed" | "claimed",
): SparkDaemonRestartRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const state = expectedState ?? value.state;
    if (
      (state !== "armed" &&
        state !== "claimed" &&
        state !== "cancelled" &&
        state !== "completed") ||
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
      state,
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
      supervisorManaged: value.supervisorManaged === true,
      ...(typeof value.targetVersion === "string" ? { targetVersion: value.targetVersion } : {}),
      ...(typeof value.targetBuildFingerprint === "string"
        ? { targetBuildFingerprint: value.targetBuildFingerprint }
        : {}),
    };
  } catch {
    return null;
  }
}

function removeRestartActiveRecord(paths: SparkPaths, restartId: string): void {
  for (const [path, state] of [
    [restartIntentPath(paths), "armed"],
    [restartStartingPath(paths), "claimed"],
  ] as const) {
    const record = readRestartIntentFile(path, state);
    if (record?.restartId === restartId) rmSync(path, { force: true });
  }
  fsyncDirectory(paths.runtimeDir);
}

function restartSuccessorContext(
  intent: SparkDaemonRestartIntent,
): SparkDaemonRestartSuccessorContext {
  return {
    acceptedRestartId: intent.restartId,
    instanceId: intent.targetInstanceId,
    generation: intent.targetGeneration,
    predecessorInstanceId: intent.previousInstanceId,
    predecessorGeneration: intent.previousGeneration,
    ...(intent.targetVersion ? { targetVersion: intent.targetVersion } : {}),
    ...(intent.targetBuildFingerprint
      ? { targetBuildFingerprint: intent.targetBuildFingerprint }
      : {}),
  };
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
  const token = (options.readProcessStartToken ?? processStartTokenForPid)(intent.previousPid);
  if (token !== null) return token === intent.previousProcessStartToken;
  return (options.processAlive ?? isProcessAlive)(intent.previousPid);
}

export function publishSparkDaemonProcessOwnership(
  paths: SparkPaths,
  identity: { pid: number; instanceId: string; generation: string },
): SparkDaemonProcessOwnership {
  return withProcessOwnershipMutex(paths, () => {
    const processStartToken = processStartTokenForPid(identity.pid);
    if (!processStartToken) {
      throw new Error(`Cannot identify Spark daemon process ${identity.pid}.`);
    }
    const ownership: SparkDaemonProcessOwnership = { ...identity, processStartToken };
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    const target = processIdentityPath(paths);
    const temporary = join(
      paths.runtimeDir,
      `.daemon.identity.${identity.pid}.${randomUUID()}.tmp`,
    );
    let file: number | undefined;
    try {
      file = openSync(temporary, "wx", 0o600);
      writeFileSync(file, `${JSON.stringify(ownership)}\n`, "utf8");
      fsyncSync(file);
      closeSync(file);
      file = undefined;
      renameSync(temporary, target);
      fsyncDirectory(paths.runtimeDir);
      return ownership;
    } catch (error) {
      if (file !== undefined) closeSync(file);
      rmSync(temporary, { force: true });
      throw error;
    }
  });
}

export function clearSparkDaemonProcessOwnership(
  paths: SparkPaths,
  identity: { pid: number; instanceId: string; generation: string },
): void {
  withProcessOwnershipMutex(paths, () => {
    const current = readSparkDaemonProcessOwnership(paths);
    if (
      !current ||
      current.pid !== identity.pid ||
      current.instanceId !== identity.instanceId ||
      current.generation !== identity.generation
    ) {
      return;
    }
    try {
      if (Number(readFileSync(paths.pidFile, "utf8").trim()) === identity.pid) {
        rmSync(paths.pidFile, { force: true });
      }
    } catch {
      // The runtime loop normally removes the pidfile first.
    }
    rmSync(processIdentityPath(paths), { force: true });
    fsyncDirectory(paths.runtimeDir);
  });
}

/** Keep ownership visible through shutdown; clear only after releasing the daemon lock. */
export async function releaseSparkDaemonProcessOwnership(
  paths: SparkPaths,
  identity: { pid: number; instanceId: string; generation: string },
  releaseLock: () => Promise<void>,
): Promise<void> {
  await releaseLock();
  clearSparkDaemonProcessOwnership(paths, identity);
}

function withProcessOwnershipMutex<T>(paths: SparkPaths, action: () => T): T {
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = join(paths.runtimeDir, processOwnershipMutexName);
  const ownerPath = join(lockPath, "owner.json");
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          pid: process.pid,
          processStartToken: processStartTokenForPid(process.pid),
        })}\n`,
        { mode: 0o600 },
      );
      break;
    } catch (error) {
      if (!existsSync(lockPath)) throw error;
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
        stale =
          !Number.isInteger(owner.pid) ||
          typeof owner.processStartToken !== "string" ||
          processStartTokenForPid(Number(owner.pid)) !== owner.processStartToken;
      } catch {
        try {
          stale = Date.now() - statSync(lockPath).mtimeMs > 5_000;
        } catch {
          if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for Spark daemon ownership publication lock.");
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          continue;
        }
      }
      if (stale) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for Spark daemon ownership publication lock.");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
    fsyncDirectory(paths.runtimeDir);
  }
}

export function readSparkDaemonProcessOwnership(
  paths: SparkPaths,
): SparkDaemonProcessOwnership | null {
  try {
    const value = JSON.parse(readFileSync(processIdentityPath(paths), "utf8")) as Record<
      string,
      unknown
    >;
    if (
      !Number.isInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.processStartToken !== "string" ||
      value.processStartToken.length === 0 ||
      typeof value.instanceId !== "string" ||
      value.instanceId.length === 0 ||
      typeof value.generation !== "string" ||
      value.generation.length === 0
    ) {
      return null;
    }
    return {
      pid: Number(value.pid),
      processStartToken: value.processStartToken,
      instanceId: value.instanceId,
      generation: value.generation,
    };
  } catch {
    return null;
  }
}

export function stopSparkDaemonRestartStartedService(
  _paths: SparkPaths,
  service: SparkDaemonServiceResult,
  options: {
    readProcessStartToken?: (pid: number) => string | null;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): void {
  // Never boot out the shared launchd label from a stale helper. An observed
  // manager process may belong to a later explicit start. Cancellation is
  // enforced by the durable tombstone and by the exact successor itself.
  if (service.kind === "launchd") return;
  if (
    service.ownership !== "spawned" ||
    !service.pid ||
    !service.processStartToken ||
    (options.readProcessStartToken ?? processStartTokenForPid)(service.pid) !==
      service.processStartToken
  ) {
    return;
  }
  try {
    (options.kill ?? ((pid, signal) => process.kill(pid, signal)))(service.pid, "SIGTERM");
  } catch {
    // The exact spawned child already exited.
  }
}

type LaunchctlResult = { status: number | null; stdout: string; stderr: string };

/** True only when launchd currently owns a job that can replace the daemon. */
export function isSparkDaemonSupervisorRegistered(
  options: {
    platform?: NodeJS.Platform;
    uid?: number;
    run?: (args: string[]) => LaunchctlResult;
  } = {},
): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return false;
  const result = (options.run ?? runLaunchctl)(["print", `gui/${uid}/${launchdLabel}`]);
  return result.status === 0;
}

export function stopSparkDaemonLaunchdLabel(
  options: {
    uid?: number;
    run?: (args: string[]) => LaunchctlResult;
  } = {},
): SparkDaemonServiceResult {
  const uid = options.uid ?? readCurrentUid();
  const target = `gui/${uid}/${launchdLabel}`;
  const run = options.run ?? runLaunchctl;
  const stopped = run(["bootout", target]);
  const registered = run(["print", target]);
  if (registered.status === 0) {
    const detail = stopped.stderr || stopped.stdout || "launchctl still reports the job";
    throw new Error(
      `Failed to unregister Spark daemon ${launchdLabel}; the launchd label remains registered: ${detail}`,
    );
  }
  return {
    kind: "launchd",
    alreadyRunning: false,
    detail:
      stopped.status === 0
        ? `Stopped Spark daemon ${launchdLabel}.`
        : `Spark daemon ${launchdLabel} was not registered.`,
  };
}

export function isSparkDaemonRestartHelperDefinitelyDead(
  schedule: Pick<SparkDaemonRestartSchedule, "helperPid" | "helperProcessStartToken">,
  options: {
    readProcessStartToken?: (pid: number) => string | null;
    processAlive?: (pid: number) => boolean;
  } = {},
): boolean {
  if (!schedule.helperPid) return false;
  const token = (options.readProcessStartToken ?? processStartTokenForPid)(schedule.helperPid);
  if (token !== null && schedule.helperProcessStartToken) {
    return token !== schedule.helperProcessStartToken;
  }
  return !(options.processAlive ?? isProcessAlive)(schedule.helperPid);
}

function sparkDaemonRestartStartedServiceAlive(service: SparkDaemonServiceResult): boolean {
  if (!service.pid) return false;
  if (!service.processStartToken) return isProcessAlive(service.pid);
  const token = processStartTokenForPid(service.pid);
  if (token !== null) return token === service.processStartToken;
  return isProcessAlive(service.pid);
}

function processStartTokenForPid(pid: number): string | null {
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
  const plistPath = writeSparkDaemonLaunchdPlist(paths);
  const target = `gui/${uid}/${launchdLabel}`;

  runLaunchctl(["bootout", target]);
  runLaunchctl(["bootout", `gui/${uid}`, plistPath]);
  rotateSparkDaemonServiceLogs(paths);
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

export function writeSparkDaemonLaunchdPlist(
  paths: SparkPaths,
  options: { home?: string } = {},
): string {
  const home = options.home ?? process.env.HOME ?? homedir();
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
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
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

function startDetachedSparkDaemon(
  paths: SparkPaths,
  expectedRestartId?: string,
): SparkDaemonServiceResult {
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
  rotateSparkDaemonServiceLogs(paths);
  const stdout = openSync(join(paths.logDir, "service.stdout.log"), "a", 0o600);
  const stderr = openSync(join(paths.logDir, "service.stderr.log"), "a", 0o600);
  const command = sparkDaemonStartCommand();
  const child = spawn(command[0]!, command.slice(1), {
    detached: true,
    env: {
      ...process.env,
      ...(expectedRestartId ? { SPARK_DAEMON_EXPECTED_RESTART_ID: expectedRestartId } : {}),
    },
    stdio: ["ignore", stdout, stderr],
  });
  child.once("error", (error) => {
    console.error("[spark-daemon] detached service failed to spawn", error);
  });
  child.unref();
  const childStartToken = child.pid ? processStartTokenForPid(child.pid) : null;

  return {
    kind: "detached",
    alreadyRunning: false,
    detail: `Started Spark daemon in the background as process ${child.pid}.`,
    ownership: "spawned",
    ...(child.pid ? { pid: child.pid } : {}),
    ...(childStartToken ? { processStartToken: childStartToken } : {}),
  };
}

export function stopSparkDaemonPidFileProcess(
  paths: SparkPaths,
  options: {
    readProcessStartToken?: (pid: number) => string | null;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): SparkDaemonServiceResult | null {
  const runningPid = readRunningPid(paths);
  if (!runningPid) {
    return null;
  }

  const ownership = readSparkDaemonProcessOwnership(paths);
  if (
    !ownership ||
    ownership.pid !== runningPid ||
    (options.readProcessStartToken ?? processStartTokenForPid)(runningPid) !==
      ownership.processStartToken
  ) {
    // Legacy numeric-only pidfiles and PID reuse are not proof of ownership.
    // The local RPC path is attempted first; the fallback must fail closed.
    return null;
  }

  (options.kill ?? ((pid, signal) => process.kill(pid, signal)))(runningPid, "SIGTERM");
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

  const ownership = readSparkDaemonProcessOwnership(paths);
  if (ownership) {
    const token = processStartTokenForPid(pid);
    if (ownership.pid !== pid || token !== ownership.processStartToken) {
      if (ownership.pid === pid) {
        rmSync(paths.pidFile, { force: true });
        rmSync(processIdentityPath(paths), { force: true });
        fsyncDirectory(paths.runtimeDir);
      }
      return null;
    }
    return pid;
  }
  return isProcessAlive(pid) ? pid : null;
}

function sparkDaemonStartCommand(): string[] {
  return [...sparkDaemonCliCommand(), "__service-start"];
}

function sparkDaemonCliCommand(): string[] {
  const stableLauncher = process.env.SPARK_STABLE_LAUNCHER?.trim();
  if (stableLauncher) return [stableLauncher, "daemon"];
  return [process.execPath, realpathSync(process.argv[1]!)];
}

export function rotateSparkDaemonServiceLogs(
  paths: Pick<SparkPaths, "logDir">,
  options: { maxBytes?: number; backups?: number } = {},
): void {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 8 * 1024 * 1024));
  const backups = Math.max(1, Math.floor(options.backups ?? 2));
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  for (const name of ["service.stdout.log", "service.stderr.log"]) {
    const path = join(paths.logDir, name);
    if (!existsSync(path) || statSync(path).size <= maxBytes) continue;
    for (let index = backups; index >= 2; index -= 1) {
      const target = `${path}.${index}`;
      const previous = `${path}.${index - 1}`;
      rmSync(target, { force: true });
      if (existsSync(previous)) renameSync(previous, target);
    }

    const descriptor = openSync(path, "r+");
    try {
      const size = statSync(path).size;
      const retainedBytes = Math.min(size, maxBytes);
      const tail = Buffer.allocUnsafe(retainedBytes);
      readSync(descriptor, tail, 0, retainedBytes, size - retainedBytes);
      writeFileSync(`${path}.1`, tail, { mode: 0o600 });
      ftruncateSync(descriptor, 0);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

function serviceEnvironment(): Record<string, string> {
  const keys = [
    "HOME",
    "PATH",
    "SPARK_HOME",
    "SPARK_BUILD_INFO_PATH",
    "SPARK_DEPLOYMENT_WATCH_PATH",
    "SPARK_STABLE_LAUNCHER",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
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
