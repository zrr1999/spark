/** Managed client registry, retry, and local daemon auto-start. */

import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import { spawn } from "node:child_process";
import { cappedExponentialCeiling, equalJitter } from "@zendev-lab/spark-retry";
import { cueShellProcessEnvironment } from "../executable-environment.ts";
import {
  CueClient,
  CueError,
  cueOperationId,
  type CueOperationKey,
  type CueResolvedTransport,
  type CueSessionOptions,
  isRetryableCueTransportError,
  resolveCueTransport,
} from "../client/cue-client.ts";
import { checkAndWarn as checkCuedVersionAndWarn } from "../version-check.ts";
import type { SparkCueToolContext } from "./host-types.ts";

function resolveCueWorkingDirectory(
  requestedCwd: string | undefined,
  fallbackCwd?: string,
): string {
  const baseCwd = fallbackCwd?.trim() || process.cwd();
  if (!requestedCwd) return nodePath.resolve(baseCwd);
  return nodePath.isAbsolute(requestedCwd) ? requestedCwd : nodePath.resolve(baseCwd, requestedCwd);
}

export type CueClientOwner = symbol;

interface CueClientRegistryEntry {
  readonly key: string;
  readonly sessionId: string;
  readonly owners: Set<CueClientOwner>;
  connectPromise: Promise<CueClient>;
  client?: CueClient;
}

const clientRegistry = new Map<string, CueClientRegistryEntry>();

export function __resetSparkCueClientForTests(): void {
  for (const entry of clientRegistry.values()) closeClientRegistryEntry(entry);
  clientRegistry.clear();
}

function closeClientRegistryEntry(entry: CueClientRegistryEntry): void {
  if (clientRegistry.get(entry.key) === entry) clientRegistry.delete(entry.key);
  if (entry.client) {
    entry.client.close();
    return;
  }
  void entry.connectPromise.then(
    (connected) => connected.close(),
    () => undefined,
  );
}

function cueTransportKey(transport: CueResolvedTransport): string {
  if (transport.transport === "unix") return `unix:${transport.socket_path}`;
  return ["ssh", transport.profile_name, transport.destination, transport.gateway_command].join(
    ":",
  );
}

function cueErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cueSessionOptionsFromContext(
  ctx?: SparkCueToolContext,
): Required<CueSessionOptions> {
  const cwd = resolveCueWorkingDirectory(undefined, ctx?.cwd);
  const sessionId = cueSessionIdFromContext(ctx, cwd);
  return { sessionId, cwd, env: ctx?.env ?? process.env, refresh: false };
}

function cueSessionIdFromContext(ctx: SparkCueToolContext | undefined, cwd: string): string {
  const direct = ctx?.sessionId?.trim();
  if (direct) return direct;
  const sessionFile = ctx?.sessionManager?.getSessionFile?.()?.trim();
  if (sessionFile) return `session:${stableStringHash(sessionFile)}`;
  const leafId = ctx?.sessionManager?.getLeafId?.()?.trim();
  if (leafId) return `leaf:${leafId}`;
  const envSession = process.env.PI_SESSION_ID?.trim() || process.env.SPARK_SESSION_ID?.trim();
  if (envSession) return envSession;
  return `spark-cue:${process.pid}:${stableStringHash(cwd)}`;
}

function stableStringHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function releaseClientOwner(owner: CueClientOwner, ctx?: SparkCueToolContext): void {
  const ownedEntries = Array.from(clientRegistry.values()).filter((entry) =>
    entry.owners.has(owner),
  );
  const hasSessionIdentity = Boolean(
    ctx?.sessionId?.trim() ||
    ctx?.cwd?.trim() ||
    ctx?.sessionManager?.getSessionFile?.()?.trim() ||
    ctx?.sessionManager?.getLeafId?.()?.trim() ||
    process.env.PI_SESSION_ID?.trim() ||
    process.env.SPARK_SESSION_ID?.trim(),
  );
  let sessionId = hasSessionIdentity
    ? cueSessionIdFromContext(ctx, resolveCueWorkingDirectory(undefined, ctx?.cwd))
    : undefined;
  if (!sessionId) {
    const ownedSessionIds = new Set(ownedEntries.map((entry) => entry.sessionId));
    if (ownedSessionIds.size !== 1) return;
    sessionId = ownedSessionIds.values().next().value;
  }

  for (const entry of ownedEntries) {
    if (entry.sessionId !== sessionId) continue;
    if (!entry.owners.delete(owner)) continue;
    if (entry.owners.size === 0) closeClientRegistryEntry(entry);
  }
}

async function connectClient(
  transport: CueResolvedTransport,
  session: Required<CueSessionOptions>,
  ctx?: SparkCueToolContext,
): Promise<CueClient> {
  try {
    return await CueClient.connectResolved(transport, session);
  } catch (error) {
    if (error instanceof CueError && error.code === "UNSUPPORTED_PROTOCOL") throw error;
    if (transport.transport === "ssh") throw error;
    if (!(error instanceof CueError) || error.code !== "DAEMON_UNREACHABLE") throw error;
    // Local socket could not be reached — auto-start local/unix transports only.
    ctx?.ui?.notify?.("cue-shell: auto-starting daemon…", "info");
    try {
      await autoStartDaemon(transport.socket_path);
    } catch (startErr) {
      const msg = [
        `cue-shell daemon not reachable at ${transport.socket_path}.`,
        `Initial connection failure: ${cueErrorDetail(error)}`,
        `Auto-start failed: ${cueErrorDetail(startErr)}`,
      ].join("\n");
      throw new CueError("DAEMON_UNREACHABLE", msg);
    }
    // Retry connection after starting.
    try {
      return await CueClient.connectResolved(transport, session);
    } catch (err) {
      if (err instanceof CueError && err.code === "UNSUPPORTED_PROTOCOL") throw err;
      const msg = [
        `cue-shell daemon auto-started but still not reachable at ${transport.socket_path}.`,
        `Initial connection failure: ${cueErrorDetail(error)}`,
        `Retry failure: ${cueErrorDetail(err)}`,
      ].join("\n");
      throw new CueError("DAEMON_UNREACHABLE", msg);
    }
  }
}

export async function getClient(
  ctx: SparkCueToolContext | undefined,
  owner: CueClientOwner,
): Promise<CueClient> {
  if (ctx?.cueClient) return ctx.cueClient;
  const transport = await resolveCueTransport();
  const session = cueSessionOptionsFromContext(ctx);
  const key = `${cueTransportKey(transport)}|session:${session.sessionId}`;
  let entry = clientRegistry.get(key);
  if (entry?.client?.isClosed) {
    closeClientRegistryEntry(entry);
    entry = undefined;
  }

  if (!entry) {
    const pendingEntry: CueClientRegistryEntry = {
      key,
      sessionId: session.sessionId,
      owners: new Set(),
      connectPromise: connectClient(transport, session, ctx),
    };
    pendingEntry.connectPromise = pendingEntry.connectPromise
      .then((connected) => {
        pendingEntry.client = connected;
        if (clientRegistry.get(key) !== pendingEntry || pendingEntry.owners.size === 0) {
          connected.close();
        }
        return connected;
      })
      .catch((error) => {
        if (clientRegistry.get(key) === pendingEntry) clientRegistry.delete(key);
        throw error;
      });
    entry = pendingEntry;
    clientRegistry.set(key, entry);
  }

  entry.owners.add(owner);
  const client = await entry.connectPromise;
  if (client.isClosed) {
    closeClientRegistryEntry(entry);
    throw new CueError(
      "DAEMON_UNREACHABLE",
      `cue-shell connection closed during initialization for session ${session.sessionId}`,
    );
  }

  // Best-effort outdated-cued warning, fired at most once per process.
  // Detached on purpose: the warning hits GitHub for the latest release
  // and we never want that to delay the first IPC call.
  void checkCuedVersionAndWarn(client, ctx);
  return client;
}

export function cueToolOperation(
  ctx: SparkCueToolContext | undefined,
  toolCallId: string,
  kind: string,
): CueOperationKey {
  return {
    sessionId: cueSessionOptionsFromContext(ctx).sessionId,
    toolCallId,
    kind,
  };
}

async function invalidateManagedClientForRetry(client: CueClient): Promise<void> {
  for (const entry of [...clientRegistry.values()]) {
    if (entry.client !== client) continue;
    if (clientRegistry.get(entry.key) === entry) clientRegistry.delete(entry.key);
  }
  client.close();
  await client.closed;
}

interface CueSideEffectRetryOptions {
  /** False until the daemon exposes enough query state to reconstruct the result. */
  replaySafe?: boolean;
  /** Execution budget shared by connection, backoff, and replay attempts. */
  deadlineMs?: number;
  /** Cancellation budget inherited from the owning tool call. */
  signal?: AbortSignal;
  /** Safe, bounded retry telemetry for the active tool surface. */
  onRetry?: (progress: CueSideEffectRetryProgress) => void;
}

interface CueSideEffectAttempt {
  attempt: number;
  remainingMs?: number;
}

interface CueSideEffectRetryProgress {
  /** Attempt about to run; the initial attempt is 1. */
  attempt: number;
  delayMs: number;
  remainingMs?: number;
}

const CUE_RETRY_BASE_DELAY_MS = 100;
const CUE_RETRY_MAX_DELAY_MS = 5_000;

function cueRetryDelayMs(replayIndex: number): number {
  const cap = cappedExponentialCeiling(
    replayIndex,
    CUE_RETRY_BASE_DELAY_MS,
    CUE_RETRY_MAX_DELAY_MS,
    { exponentCap: 16 },
  );
  // Equal jitter avoids synchronized reconnect storms while retaining a useful
  // minimum pause when a local daemon or remote SSH gateway is unavailable.
  return equalJitter(cap);
}

function cueRetryDeadlineError(operationId: string): CueError {
  return new CueError(
    "IDEMPOTENT_RETRY_DEADLINE_EXCEEDED",
    `operation ${operationId} remained transport-ambiguous when its retry deadline expired`,
  );
}

async function withinCueRetryBudget<T>(
  promise: Promise<T>,
  operationId: string,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): Promise<T> {
  signal?.throwIfAborted();
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw cueRetryDeadlineError(operationId);
  }
  if (!signal && deadlineAt === undefined) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      settle(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (deadlineAt !== undefined) {
      deadlineTimer = setTimeout(
        () => settle(() => reject(cueRetryDeadlineError(operationId))),
        Math.max(0, deadlineAt - Date.now()),
      );
    }
    void promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

function waitForCueRetry(
  delayMs: number,
  operationId: string,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): Promise<void> {
  return withinCueRetryBudget(
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    operationId,
    signal,
    deadlineAt,
  );
}

function cueRetryProgressUpdate(
  onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
): (progress: CueSideEffectRetryProgress) => void {
  return ({ attempt, delayMs, remainingMs }) => {
    const budget = remainingMs === undefined ? "" : `; ${Math.ceil(remainingMs / 1_000)}s left`;
    onUpdate({
      content: [
        {
          type: "text",
          text: `cue-shell transport interrupted; retrying attempt ${attempt} in ${delayMs}ms${budget}`,
        },
      ],
    });
  };
}

export function cueToolRetryOptions(
  signal: AbortSignal,
  onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
  options: Omit<CueSideEffectRetryOptions, "signal" | "onRetry"> = {},
): CueSideEffectRetryOptions {
  return { ...options, signal, onRetry: cueRetryProgressUpdate(onUpdate) };
}

export async function withCueIdempotentRetry<T>(
  ctx: SparkCueToolContext | undefined,
  owner: CueClientOwner,
  operation: CueOperationKey,
  run: (client: CueClient, attempt: CueSideEffectAttempt) => Promise<T>,
  options: CueSideEffectRetryOptions = {},
): Promise<T> {
  const operationId = cueOperationId(operation);
  const deadlineAt =
    options.deadlineMs === undefined ? undefined : Date.now() + Math.max(0, options.deadlineMs);
  const attemptContext = (attempt: number): CueSideEffectAttempt => {
    if (deadlineAt === undefined) return { attempt };
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    return { attempt, remainingMs };
  };
  const firstClient = await withinCueRetryBudget(
    getClient(ctx, owner),
    operationId,
    options.signal,
    deadlineAt,
  );
  const firstInstanceId = firstClient.daemonInstanceId;
  let client = firstClient;
  let attempt = 1;
  for (;;) {
    try {
      return await withinCueRetryBudget(
        run(client, attemptContext(attempt)),
        operationId,
        options.signal,
        deadlineAt,
      );
    } catch (error) {
      if (!isRetryableCueTransportError(error)) throw error;
      if (ctx?.cueClient) {
        throw new CueError(
          "IDEMPOTENT_RETRY_UNAVAILABLE",
          `operation ${operationId} became transport-ambiguous, and an externally injected CueClient cannot be rebuilt safely: ${cueErrorDetail(error)}`,
        );
      }
      if (options.replaySafe === false) {
        throw new CueError(
          "IDEMPOTENT_RECOVERY_UNSUPPORTED",
          `operation ${operationId} may have executed, but its result cannot yet be reconstructed after reconnect`,
        );
      }

      // Close the old transport before reconnecting. A late response on the old
      // request id must not race the replay on the new connection.
      await invalidateManagedClientForRetry(client);
      for (;;) {
        const nextAttempt = attempt + 1;
        const delayMs = cueRetryDelayMs(attempt);
        const remainingMs =
          deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now());
        options.onRetry?.({ attempt: nextAttempt, delayMs, remainingMs });
        await waitForCueRetry(delayMs, operationId, options.signal, deadlineAt);

        let retryClient: CueClient;
        try {
          retryClient = await withinCueRetryBudget(
            getClient(ctx, owner),
            operationId,
            options.signal,
            deadlineAt,
          );
        } catch (reconnectError) {
          if (reconnectError instanceof CueError && reconnectError.code === "DAEMON_UNREACHABLE") {
            attempt = nextAttempt;
            continue;
          }
          throw reconnectError;
        }
        if (
          firstInstanceId === null ||
          retryClient.daemonInstanceId === null ||
          retryClient.daemonInstanceId !== firstInstanceId
        ) {
          const retryInstanceId = retryClient.daemonInstanceId;
          await invalidateManagedClientForRetry(retryClient);
          throw new CueError(
            "IDEMPOTENT_DAEMON_CHANGED",
            `operation ${operationId} cannot be replayed because cued changed from instance ${firstInstanceId ?? "unknown"} to ${retryInstanceId ?? "unknown"}`,
          );
        }
        client = retryClient;
        attempt = nextAttempt;
        break;
      }
    }
  }
}

export const DEFAULT_CUED_AUTOSTART_TIMEOUT_MS = 10_000;

/** Spawn `cued start` as a detached background process. */
async function autoStartDaemon(socketPath: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const command = "cued";
  const args = ["start", "--socket", socketPath];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      env: cueShellProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutMs = timeoutMsFromEnv(
      "PI_CUE_AUTOSTART_TIMEOUT_MS",
      DEFAULT_CUED_AUTOSTART_TIMEOUT_MS,
    );
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (cb: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cb();
    };
    child.stdout?.on("data", (chunk: Buffer) => appendBoundedBuffer(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendBoundedBuffer(stderr, chunk));
    child.on("error", (error) => {
      settle(() =>
        reject(
          new Error(renderCuedStartFailure({ command, args, socketPath, error, stdout, stderr })),
        ),
      );
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (code === 0 || code === null) {
          // Give the daemon a moment to bind its socket.
          setTimeout(resolve, 500);
        } else {
          reject(
            new Error(
              renderCuedStartFailure({ command, args, socketPath, code, signal, stdout, stderr }),
            ),
          );
        }
      });
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(() =>
          reject(
            new Error(
              renderCuedStartFailure({
                command,
                args,
                socketPath,
                error: new Error(`cued start timed out after ${timeoutMs}ms`),
                stdout,
                stderr,
              }),
            ),
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
    }
    // Don't wait for the child — cued start backgrounds itself.
    child.unref();
  });
}

const CUED_START_OUTPUT_LIMIT = 32 * 1024;

function timeoutMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : 0;
}

function appendBoundedBuffer(chunks: Buffer[], chunk: Buffer): void {
  chunks.push(Buffer.from(chunk));
  let total = chunks.reduce((sum, item) => sum + item.length, 0);
  while (total > CUED_START_OUTPUT_LIMIT && chunks.length > 0) {
    const first = chunks[0]!;
    const extra = total - CUED_START_OUTPUT_LIMIT;
    if (first.length <= extra) {
      chunks.shift();
      total -= first.length;
    } else {
      chunks[0] = first.subarray(extra);
      total -= extra;
    }
  }
}

function renderCuedStartFailure(input: {
  command: string;
  args: string[];
  socketPath: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stdout: Buffer[];
  stderr: Buffer[];
}): string {
  const status = input.error
    ? input.error.message
    : input.signal
      ? `cued start terminated by signal ${input.signal}`
      : `cued start exited with code ${input.code}`;
  const stdout = Buffer.concat(input.stdout).toString("utf8").trim();
  const stderr = Buffer.concat(input.stderr).toString("utf8").trim();
  const lines = [
    status,
    `Attempted: ${[input.command, ...input.args].join(" ")}`,
    `Socket: ${input.socketPath}`,
    `Socket directory: ${nodePath.dirname(input.socketPath)}`,
    `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? "<unset>"}`,
    `TMPDIR=${process.env.TMPDIR ?? "<unset>"}`,
    `Config directory: ${cueConfigDirHint()}`,
  ];
  lines.push(stderr ? `stderr:\n${stderr}` : "stderr: <empty>");
  lines.push(stdout ? `stdout:\n${stdout}` : "stdout: <empty>");
  lines.push(
    `Recovery: run ${JSON.stringify(`cued start --fg --socket ${input.socketPath}`)} in a terminal for daemon logs; check for a stale socket at ${input.socketPath}; after protocol upgrades, restart/reload the Pi host so its spark-cue client matches cued.`,
  );
  return lines.join("\n");
}

function cueConfigDirHint(): string {
  if (process.env.XDG_CONFIG_HOME?.trim())
    return nodePath.join(process.env.XDG_CONFIG_HOME, "cue-shell");
  if (process.env.HOME?.trim()) return nodePath.join(process.env.HOME, ".config", "cue-shell");
  return "<unknown: HOME unset>";
}
