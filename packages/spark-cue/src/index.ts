/**
 * spark-cue extension
 *
 * Atomic execution tools organized by the three category objects:
 *
 *   Execution:
 *     cue_exec     — execute a command and create a job
 *     cue_run      — run a `.cue` file-script (sequential, fail-fast)
 *     cue_script   — run an inline `.cue` script body (sequential, fail-fast)
 *     script_run   — run a script file with an explicit language
 *     script_eval  — run an inline script with an explicit language
 *
 *   Jobs:
 *     cue_jobs     — list, inspect, wait for, or stop jobs
 *
 *   Schedules:
 *     cue_schedule — add, list, pause, resume, or remove scheduled jobs
 *
 *   System:
 *     cue_scope    — inspect scopes, env, or config
 *     cue_history  — show job and daemon history
 *
 * See ARCHITECTURE.md for the category-theoretic model.
 */

import type {
  ExtensionAPI,
  ToolEffect,
  ToolExecutionMode,
  ToolPolicy,
} from "@zendev-lab/spark-extension-api";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import { truncateToWidth } from "@zendev-lab/spark-tui/text";
import { cappedExponentialCeiling, equalJitter } from "@zendev-lab/spark-retry";
import { Type } from "typebox";
import { cueShellProcessEnvironment } from "./executable-environment.ts";

export interface PiCueExtensionApi {
  registerTool(config: PiCueToolConfig): void;
  on?(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
}

export type PiCueNotifyLevel = "info" | "warning" | "error" | "success";

export interface PiCueToolContext {
  cwd?: string;
  sessionId?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
  env?: Record<string, string | undefined>;
  cueClient?: CueClient;
  ui?: { notify?: (msg: string, level: PiCueNotifyLevel) => void };
}

export interface PiCueToolConfig {
  name: string;
  label?: string;
  description: string;
  policy?: ToolPolicy;
  /** Legacy mirrors populated from policy for Pi/current Spark turn hosts. */
  effect?: ToolEffect;
  executionMode?: ToolExecutionMode;
  /** Cue exec family tools require host approval gated by session approvalMethod. */
  requiresApproval?: boolean;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: PiCueToolContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

const CUE_EXECUTION_TOOL_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "execution"],
  phases: ["implement"],
  approval: "required",
} as const satisfies ToolPolicy;

const CUE_JOBS_TOOL_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "jobs"],
  phases: ["implement"],
  approval: "required",
} as const satisfies ToolPolicy;

const CUE_RESOURCES_TOOL_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["cue", "resources"],
  phases: ["plan", "implement"],
  approval: "none",
} as const satisfies ToolPolicy;

const CUE_SCHEDULE_TOOL_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "schedules"],
  phases: ["implement"],
  approval: "required",
} as const satisfies ToolPolicy;

const CUE_SCOPE_TOOL_POLICY = {
  // cue_scope combines inspection with cwd/env mutation, so the whole action
  // surface is conservatively stateful until actions gain parameter policies.
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "scope"],
  phases: ["plan", "implement"],
  approval: "none",
} as const satisfies ToolPolicy;

const CUE_HISTORY_TOOL_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["cue", "history"],
  phases: ["plan", "implement"],
  approval: "none",
} as const satisfies ToolPolicy;

function registerCueTool(pi: PiCueExtensionApi, config: PiCueToolConfig): void {
  const effect = config.effect ?? config.policy?.effect;
  const executionMode = config.executionMode ?? config.policy?.executionMode;
  const requiresApproval =
    config.requiresApproval ?? (config.policy?.approval === "required" ? true : undefined);
  pi.registerTool({
    ...config,
    ...(effect ? { effect } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(requiresApproval === true ? { requiresApproval } : {}),
  });
}

interface ToolCallRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

interface ToolCallComponent {
  render(width: number): string[];
}

class ToolCallText implements ToolCallComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}

export {
  CueClient,
  CueError,
  CueTransportError,
  cueOperationId,
  cueOperationStep,
  defaultSocketPath,
  isRetryableCueTransportError,
  resolveCueTransport,
} from "./cue-client.ts";
export type {
  CueOperationKey,
  CueResolvedTransport,
  CueSessionOptions,
  CancelReason,
  JobInfo,
  JobOutputResult,
  JobResult,
  JobStatus,
  OutputEncoding,
  ResourceNeeds,
  ScriptItemSummary,
  ScriptResult,
  StartJobResult,
} from "./cue-client.ts";
export {
  __resetForTests as __resetVersionCheckForTests,
  checkAndWarn as checkCuedVersionAndWarn,
  classifyDaemonVersion,
  compareSemver,
  fetchLatestRelease,
  renderWarning as renderCuedVersionWarning,
} from "./version-check.ts";
export type { DaemonVersion, VersionCheckOptions, VersionVerdict } from "./version-check.ts";

import {
  CueClient,
  CueError,
  cueOperationId,
  type CueOperationKey,
  type CueResolvedTransport,
  type CueSessionOptions,
  type JobInfo,
  type JobStatus,
  type ResourceNeeds,
  type ScriptResult,
  isSensitiveCueEnvKey,
  isRetryableCueTransportError,
  resolveCueTransport,
} from "./cue-client.ts";
import { checkAndWarn as checkCuedVersionAndWarn } from "./version-check.ts";

// ── Shared state ───────────────────────────────────────────────────────────

type CueClientOwner = symbol;

interface CueClientRegistryEntry {
  readonly key: string;
  readonly sessionId: string;
  readonly owners: Set<CueClientOwner>;
  connectPromise: Promise<CueClient>;
  client?: CueClient;
}

const clientRegistry = new Map<string, CueClientRegistryEntry>();

export function __resetPiCueClientForTests(): void {
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

function cueSessionOptionsFromContext(ctx?: PiCueToolContext): Required<CueSessionOptions> {
  const cwd = resolveCueWorkingDirectory(undefined, ctx?.cwd);
  const sessionId = cueSessionIdFromContext(ctx, cwd);
  return { sessionId, cwd, env: ctx?.env ?? process.env, refresh: false };
}

function cueSessionIdFromContext(ctx: PiCueToolContext | undefined, cwd: string): string {
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

function releaseClientOwner(owner: CueClientOwner, ctx?: PiCueToolContext): void {
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
  ctx?: PiCueToolContext,
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

async function getClient(
  ctx: PiCueToolContext | undefined,
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

function cueToolOperation(
  ctx: PiCueToolContext | undefined,
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

function cueToolRetryOptions(
  signal: AbortSignal,
  onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
  options: Omit<CueSideEffectRetryOptions, "signal" | "onRetry"> = {},
): CueSideEffectRetryOptions {
  return { ...options, signal, onRetry: cueRetryProgressUpdate(onUpdate) };
}

async function withCueIdempotentRetry<T>(
  ctx: PiCueToolContext | undefined,
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

// ── Helpers ────────────────────────────────────────────────────────────────

const SHORT_TIMEOUT_COMMANDS = new Set([
  "mv",
  "cp",
  "rm",
  "mkdir",
  "rmdir",
  "ln",
  "touch",
  "chmod",
  "chown",
  "ls",
  "cat",
  "echo",
  "pwd",
  "which",
  "wc",
  "head",
  "tail",
  "file",
  "find",
  "fd",
  "rg",
  "grep",
  "stat",
  "readlink",
  "dirname",
  "basename",
  "true",
  "false",
  "test",
  "[",
]);
const SHORT_TIMEOUT_S = 10;
const DEFAULT_CUE_TAIL_BYTES = 16 * 1024;
const DEFAULT_LIST_LIMIT = 20;
const CUE_JOB_ACTIONS = ["list", "status", "wait", "stop"] as const;
const CUE_RESOURCE_ACTIONS = ["providers", "resources"] as const;
const CUE_RESOURCE_NEED_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const CUE_JOB_STATUS_FILTERS = [
  "all",
  "running",
  "pending",
  "done",
  "failed",
  "killed",
  "cancelled",
] as const;
const CUE_SCHEDULE_ACTIONS = ["add", "list", "pause", "resume", "remove"] as const;
const CUE_SCHEDULE_STATUS_FILTERS = [
  "all",
  "scheduled",
  "paused",
  "completed",
  "expired",
  "failed",
] as const;
const CUE_SCOPE_ACTIONS = [
  "list",
  "env",
  "config",
  "env_set",
  "env_unset",
  "path_prepend",
  "cd",
  "refresh",
  "status",
] as const;
const SCRIPT_LANGUAGES = ["cue-shell", "python"] as const;

function isFileOp(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  if (!firstWord) return false;
  const base = firstWord.split("/").pop() ?? firstWord;
  return SHORT_TIMEOUT_COMMANDS.has(base);
}

function statusLabel(status: JobStatus): string {
  switch (status) {
    case "Running":
      return "🟢 running";
    case "Done":
      return "✅ done";
    case "Failed":
      return "❌ failed";
    case "Killed":
      return "⏹️ killed";
    case "Cancelled":
      return "🚫 cancelled";
    case "Pending":
      return "⏳ pending";
    default:
      return status;
  }
}

function tailStr(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) throw new Error("tail byte limit must be a positive integer");
  if (s.length <= maxBytes) return { text: s, truncated: false };
  return { text: s.slice(s.length - maxBytes), truncated: true };
}

export function renderCueScriptResult(
  result: ScriptResult,
  options: { pathLabel: string; timeout: number; tailBytes: number },
): string[] {
  const sourceLabel = result.source.kind === "file" ? result.source.path : options.pathLabel;
  const headerParts = [
    `Script ${result.scriptId}: ${result.status === "done" ? "✅ done" : "❌ failed"}`,
  ];
  if (result.exitCode !== null) headerParts.push(`exit=${result.exitCode}`);
  if (result.failedItemIndex !== null) headerParts.push(`failed_item=${result.failedItemIndex}`);
  headerParts.push(`source=${sourceLabel}`);
  if (result.timedOut) headerParts.push("timed_out=true");

  const lines: string[] = [headerParts.join("  |  ")];
  if (result.timedOut) {
    lines.push(
      `Script timed out after ${options.timeout}s and its active execution was cancelled.`,
    );
  }

  let cleanItems: Array<ScriptResult["items"][number]> = [];
  const flushCleanItems = () => {
    if (cleanItems.length === 0) return;
    lines.push("", renderCleanCueScriptItems(cleanItems));
    cleanItems = [];
  };

  for (const item of result.items) {
    if (isCleanCueScriptItem(item)) {
      cleanItems.push(item);
      continue;
    }
    flushCleanItems();
    const idLabel = renderCueScriptItemId(item);
    const statusBadge = item.kind === "message" ? "ℹ️ message" : statusLabel(item.status);
    const exitSuffix =
      item.exitCode !== null && item.exitCode !== 0 ? ` (exit ${item.exitCode})` : "";
    lines.push("");
    lines.push(`--- item ${item.index}: ${item.source} [${idLabel}] ${statusBadge}${exitSuffix}`);
    if (item.kind === "message" && item.message) {
      lines.push(item.message.trimEnd());
      continue;
    }
    const stdout = normalizeCueTerminalOutput(item.stdout);
    const stderr = normalizeCueStderrForDisplay(item.stderr, stdout);
    if (stdout.trim()) {
      const t = tailStr(stdout, options.tailBytes);
      lines.push(t.text.trimEnd());
      if (t.truncated) {
        lines.push(
          `[stdout truncated — use cue_jobs action=status id=${item.jobIds[0] ?? "?"} with a larger bounded tail_bytes value]`,
        );
      }
    }
    if (stderr.trim()) {
      const t = tailStr(stderr, options.tailBytes);
      lines.push("[stderr]");
      lines.push(t.text.trimEnd());
      if (t.truncated) {
        lines.push(
          `[stderr truncated — use cue_jobs action=status id=${item.jobIds[0] ?? "?"} with a larger bounded tail_bytes value]`,
        );
      }
    }
  }
  flushCleanItems();
  return lines;
}

function isCleanCueScriptItem(item: ScriptResult["items"][number]): boolean {
  if (item.kind === "message") return false;
  if (item.status !== "Done") return false;
  if (item.exitCode !== null && item.exitCode !== 0) return false;
  const stdout = normalizeCueTerminalOutput(item.stdout);
  const stderr = normalizeCueStderrForDisplay(item.stderr, stdout);
  return !stdout.trim() && !stderr.trim();
}

function renderCleanCueScriptItems(items: Array<ScriptResult["items"][number]>): string {
  const sampleLimit = 8;
  const sample = items
    .slice(0, sampleLimit)
    .map((item) => `${item.index}:${renderCueScriptItemId(item)}`)
    .join(", ");
  const more = items.length > sampleLimit ? `, +${items.length - sampleLimit} more` : "";
  return `--- ${items.length} clean item(s) done with no output (${sample}${more})`;
}

function renderCueScriptItemId(item: ScriptResult["items"][number]): string {
  switch (item.kind) {
    case "chain":
      return `chain ${item.chainId ?? "?"} (${item.jobIds.join(",")})`;
    case "job":
      return `job ${item.jobIds[0] ?? "?"}`;
    case "cron":
      return `cron ${item.cronId ?? "?"}`;
    case "message":
      return "message";
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_OSC_SEQUENCE_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_CONTROL_SEQUENCE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsiSequences(value: string): string {
  return value
    .replaceAll(ANSI_OSC_SEQUENCE_PATTERN, "")
    .replaceAll(ANSI_CONTROL_SEQUENCE_PATTERN, "");
}

function applyCarriageReturnOverwrites(value: string): string {
  const normalizedNewlines = value.replaceAll("\r\n", "\n");
  const lines: string[] = [];
  let current = "";
  for (let index = 0; index < normalizedNewlines.length; index += 1) {
    const char = normalizedNewlines[index];
    if (char === "\r") {
      current = "";
      continue;
    }
    if (char === "\n") {
      lines.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  lines.push(current);
  return lines.join("\n");
}

function progressLineKey(line: string): string | undefined {
  const key = line.replace(/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◒◐◓◑⣾⣽⣻⢿⡿⣟⣯⣷|/\\-]\s+/, "");
  if (key === line) return undefined;
  return key.trim() || undefined;
}

function collapseRepeatedProgressLines(value: string): string {
  const lines = value.split("\n");
  const collapsed: string[] = [];
  let previousProgressKey: string | undefined;
  for (const line of lines) {
    const key = progressLineKey(line);
    if (key && key === previousProgressKey) {
      collapsed[collapsed.length - 1] = line;
      continue;
    }
    collapsed.push(line);
    previousProgressKey = key;
  }
  return collapsed.join("\n");
}

export function normalizeCueTerminalOutput(value: string): string {
  if (!value) return value;
  return collapseRepeatedProgressLines(applyCarriageReturnOverwrites(stripAnsiSequences(value)));
}

const PTY_MERGED_STDOUT_STDERR_LINE = "[PTY: stdout and stderr are merged]";

export function normalizeCueStderrForDisplay(stderr: string, stdout = ""): string {
  const normalizedStderr = normalizeCueTerminalOutput(stderr);
  if (!normalizedStderr.includes(PTY_MERGED_STDOUT_STDERR_LINE)) return normalizedStderr;

  const mergedOutput = normalizedStderr
    .split(/\r?\n/)
    .filter((line) => line.trim() !== PTY_MERGED_STDOUT_STDERR_LINE)
    .join("\n")
    .replace(/^\r?\n/, "");
  const normalizedStdout = normalizeCueTerminalOutput(stdout);
  if (!mergedOutput.trim()) return "";
  if (mergedOutput.trimEnd() === normalizedStdout.trimEnd()) return "";
  return mergedOutput;
}

function warningLines(warnings: string[]): string[] {
  if (warnings.length === 0) return [];
  return ["", "[warnings]", ...warnings];
}

function warningBlock(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `\n\n[warnings]\n${warnings.join("\n")}`;
}

function isTerminalJob(status: JobStatus): boolean {
  return status === "Done" || status === "Failed" || status === "Killed" || status === "Cancelled";
}

function jobsForChain(jobs: JobInfo[], chainId: string): JobInfo[] {
  return jobs
    .filter((job) => job.chain_id != null && String(job.chain_id) === chainId)
    .sort((a, b) => (a.chain_index ?? 0) - (b.chain_index ?? 0));
}

function chainStatus(jobs: JobInfo[]): JobStatus {
  const failed = jobs.find((job) => job.status !== "Done" && isTerminalJob(job.status));
  if (failed) return failed.status;
  if (jobs.every((job) => job.status === "Done")) return "Done";
  if (jobs.some((job) => job.status === "Running")) return "Running";
  return "Pending";
}

function jobPendingReason(job: JobInfo): string | undefined {
  return typeof job.pending_reason === "string" && job.pending_reason.trim()
    ? job.pending_reason.trim()
    : undefined;
}

function appendPendingReason(job: JobInfo, lines: string[]): void {
  const reason = jobPendingReason(job);
  if (reason) lines.push(`Pending reason: ${reason}`);
}

function formatJobListLine(job: JobInfo): string {
  let line = `${job.id}  ${statusLabel(job.status)}  ${job.pipeline}`;
  if (job.exit_code != null) line += ` (exit ${job.exit_code})`;
  if (job.chain_id) line += ` [${job.chain_id}]`;
  const reason = jobPendingReason(job);
  if (reason) line += ` — pending: ${reason}`;
  return line;
}

type CueJobOutputReader = Pick<CueClient, "jobOutput">;

async function collectJobOutputLines(
  cued: CueJobOutputReader,
  job: JobInfo,
  tailBytes: number,
): Promise<{ lines: string[]; hasOutput: boolean }> {
  const output = await cued.jobOutput(job.id, tailBytes);
  const lines: string[] = [];
  const stdout = normalizeCueTerminalOutput(output.stdout);
  const stdoutDisplay = tailStr(stdout, tailBytes);
  if (stdoutDisplay.text.trim()) lines.push("", stdoutDisplay.text.trimEnd());
  if (stdoutDisplay.truncated || output.truncated) lines.push("[stdout truncated]");

  const stderrDisplay = tailStr(normalizeCueStderrForDisplay(output.stderr, stdout), tailBytes);
  if (stderrDisplay.text.trim()) lines.push("", "[stderr]", stderrDisplay.text.trimEnd());
  if (stderrDisplay.truncated || output.stderrTruncated) lines.push("[stderr truncated]");
  return { lines, hasOutput: lines.length > 0 };
}

async function appendJobOutput(
  cued: CueJobOutputReader,
  job: JobInfo,
  lines: string[],
  tailBytes: number,
): Promise<void> {
  const output = await collectJobOutputLines(cued, job, tailBytes);
  lines.push(...output.lines);
}

interface ChainLeafDisplay {
  job: JobInfo;
  lines: string[];
  clean: boolean;
}

export async function renderCueChainStatus(
  cued: CueJobOutputReader,
  chainId: string,
  jobs: JobInfo[],
  tailBytes: number,
): Promise<string[]> {
  const status = chainStatus(jobs);
  const leafDisplays: ChainLeafDisplay[] = [];
  for (const job of jobs) {
    const output = await collectJobOutputLines(cued, job, tailBytes);
    const leafLabel = `Leaf ${(job.chain_index ?? 0) + 1}/${job.chain_total ?? jobs.length}`;
    const lines = [`${leafLabel}: ${statusLabel(job.status)} — ${job.pipeline}`];
    if (job.exit_code != null) lines.push(`Exit code: ${job.exit_code}`);
    appendPendingReason(job, lines);
    lines.push(...output.lines);
    leafDisplays.push({
      job,
      lines,
      clean:
        job.status === "Done" &&
        (job.exit_code == null || job.exit_code === 0) &&
        !output.hasOutput,
    });
  }

  const lines = [`${statusLabel(status)} — chain ${chainId}`];
  const important = leafDisplays.filter((leaf) => !leaf.clean && leaf.job.status !== "Done");
  const doneWithOutput = leafDisplays.filter((leaf) => !leaf.clean && leaf.job.status === "Done");
  const clean = leafDisplays.filter((leaf) => leaf.clean);

  for (const leaf of [...important, ...doneWithOutput]) {
    lines.push("", ...leaf.lines);
  }
  if (clean.length > 0) lines.push("", renderCleanCueChainLeaves(clean));
  return lines;
}

function renderCleanCueChainLeaves(leaves: ChainLeafDisplay[]): string {
  const sampleLimit = 8;
  const sample = leaves
    .slice(0, sampleLimit)
    .map((leaf) => `leaf ${(leaf.job.chain_index ?? 0) + 1}:${leaf.job.id}`)
    .join(", ");
  const more = leaves.length > sampleLimit ? `, +${leaves.length - sampleLimit} more` : "";
  return `--- ${leaves.length} clean successful leaf(s) done with no output (${sample}${more})`;
}

function formatValidValues(values: readonly string[]): string {
  if (values.length === 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

function normalizeCueEnum<const T extends readonly string[]>(
  value: unknown,
  fallback: T[number] | undefined,
  values: T,
  field: string,
): T[number] {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${field} is required`);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be ${formatValidValues(values)}`);
  }
  const normalized = value.trim().toLowerCase();
  if (!(values as readonly string[]).includes(normalized)) {
    throw new Error(`${field} must be ${formatValidValues(values)}`);
  }
  return normalized as T[number];
}

export function normalizeCueTailBytes(
  value: unknown,
  fallback = DEFAULT_CUE_TAIL_BYTES,
  field = "tail_bytes",
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

export function normalizeCueLimit(
  value: unknown,
  fallback = DEFAULT_LIST_LIMIT,
  field = "limit",
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

export function normalizeCueTimeoutSeconds(
  value: unknown,
  fallback: number,
  field = "timeout",
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

export function normalizeCueBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function resolveCueWorkingDirectory(
  requestedCwd: string | undefined,
  ctxCwd: string | undefined,
  fallbackCwd = process.cwd(),
): string {
  const baseCwd = ctxCwd?.trim() ? ctxCwd.trim() : fallbackCwd;
  if (!requestedCwd) return nodePath.resolve(baseCwd);
  return nodePath.isAbsolute(requestedCwd) ? requestedCwd : nodePath.resolve(baseCwd, requestedCwd);
}

function normalizeRequiredCueString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeOptionalCueString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

const CUE_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeCueEnvKey(value: unknown, field: string): string {
  const key = normalizeRequiredCueString(value, field);
  if (!CUE_ENV_KEY_PATTERN.test(key)) {
    throw new Error(`${field} must be a valid environment variable name`);
  }
  return key;
}

function normalizeCueEnvValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (/\s/u.test(value)) {
    throw new Error(
      `${field} cannot contain whitespace because cue-shell :env set uses KEY=VALUE words`,
    );
  }
  return value;
}

function normalizeCueSessionPath(value: unknown, field: string): string {
  const path = normalizeRequiredCueString(value, field);
  if (/\s/u.test(path)) {
    throw new Error(
      `${field} cannot contain whitespace because cue-shell session commands use word tokens`,
    );
  }
  return path;
}

function parseCueEnvValue(text: string, key: string): string | undefined {
  const prefix = `${key}=`;
  const line = text.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
  return line?.slice(prefix.length);
}

function redactCueEnvText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0) return line;
      const key = line.slice(0, separator);
      return isSensitiveCueEnvKey(key) ? `${key}=<redacted>` : line;
    })
    .join("\n");
}

export function normalizeCueResourceNeeds(
  value: unknown,
  field = "needs",
): ResourceNeeds | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object mapping resource keys to quantities`);
  }
  const needs: ResourceNeeds = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) throw new Error(`${field} keys must be non-empty`);
    if (key.startsWith("need.")) throw new Error(`${field} keys must omit the need. prefix`);
    if (!CUE_RESOURCE_NEED_KEY_PATTERN.test(key)) {
      throw new Error(`${field}.${key} may contain only letters, numbers, _, ., :, and -`);
    }
    if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue) || !Number.isInteger(rawValue) || rawValue < 0) {
        throw new Error(`${field}.${key} must be a non-negative integer count or string quantity`);
      }
      needs[key] = rawValue;
      continue;
    }
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      throw new Error(`${field}.${key} must be a non-empty string or non-negative integer`);
    }
    needs[key] = rawValue.trim();
  }
  return Object.keys(needs).length > 0 ? needs : undefined;
}

function quoteCueWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

async function runPythonScriptJob(
  cued: CueClient,
  options: {
    path?: string;
    inlineScript?: string;
    pathLabel?: string;
    timeout: number;
    tailBytes: number;
    cwd: string;
    venv?: string;
    signal?: AbortSignal;
    operation: CueOperationKey;
  },
) {
  const inline = options.inlineScript !== undefined;
  const runner = resolvePythonRunner({ venv: options.venv, scriptMode: true });
  const scriptPath = inline ? "-" : (options.path ?? "");
  const runCommand = [...runner.argv, scriptPath].map(quoteCueWord).join(" ");
  const command = inline
    ? `${["printf", "%s", options.inlineScript ?? ""].map(quoteCueWord).join(" ")} |> ${runCommand}`
    : runCommand;
  const result = await cued.runJob(command, {
    timeout: options.timeout,
    cwd: options.cwd,
    signal: options.signal,
    operation: options.operation,
  });
  const stdout = normalizeCueTerminalOutput(result.stdout);
  const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);
  const lines = [`Script job ${result.jobId}: ${result.status}`];
  if (result.exitCode !== null) lines[0] += ` (exit ${result.exitCode})`;
  if (result.timedOut) lines[0] += ` — timed out after ${options.timeout}s`;
  if (stdout.trim()) {
    const out = tailStr(stdout, options.tailBytes);
    lines.push("", out.text.trimEnd());
    if (out.truncated || result.stdoutTruncated) {
      lines.push(truncationLine("stdout", result.jobId));
    }
  }
  if (stderr.trim()) {
    const err = tailStr(stderr, options.tailBytes);
    lines.push("", "[stderr]", err.text.trimEnd());
    if (err.truncated || result.stderrTruncated) {
      lines.push(truncationLine("stderr", result.jobId));
    }
  }
  const details = {
    language: "python",
    path: options.path ?? options.pathLabel ?? "<inline>",
    inline: options.inlineScript !== undefined,
    jobId: result.jobId,
    status: result.status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    warnings: result.warnings,
    stdoutEncoding: result.stdoutEncoding,
    stderrEncoding: result.stderrEncoding,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    ...(result.stdoutBase64 ? { stdoutBase64: result.stdoutBase64 } : {}),
    ...(result.stderrBase64 ? { stderrBase64: result.stderrBase64 } : {}),
    pythonRunner: runner,
    resolvedScriptPath: scriptPath,
    ...(runner.python ? { pythonInterpreter: runner.python } : {}),
    ...(options.venv ? { venv: options.venv } : {}),
  };
  if (result.status === "Failed" && !result.timedOut) {
    const err = new Error(lines.join("\n"));
    (err as unknown as { details?: unknown }).details = details;
    throw err;
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
}

export interface PythonRunnerResolution {
  executable: "uv";
  source: "uv";
  argv: string[];
  python?: {
    executable: string;
    source: "venv";
    version?: string;
  };
  note: string;
}

export function resolvePythonRunner(
  options: {
    venv?: string;
    scriptMode?: boolean;
  } = {},
): PythonRunnerResolution {
  if (options.venv) {
    const executable = `${options.venv.replace(/\/+$/u, "")}/bin/python`;
    return {
      executable: "uv",
      source: "uv",
      argv: options.scriptMode
        ? ["uv", "run", "--python", executable, "--script"]
        : ["uv", "run", "--python", executable, "python"],
      python: {
        executable,
        source: "venv",
        version: pythonVersion(executable),
      },
      note: options.scriptMode
        ? "Python scripts are executed through `uv run --python <venv>/bin/python --script <path>` or `uv run --python <venv>/bin/python --script -`."
        : "Python is executed through `uv run --python <venv>/bin/python python ...`.",
    };
  }

  if (options.scriptMode) {
    return {
      executable: "uv",
      source: "uv",
      argv: ["uv", "run", "--script"],
      note: "Python scripts are executed through `uv run --script <path>` or `uv run --script -`; inline scripts are piped through stdin.",
    };
  }

  return {
    executable: "uv",
    source: "uv",
    argv: ["uv", "run", "python"],
    note: "Python is executed through `uv run python ...`; uv resolves the project/session Python environment.",
  };
}

function pythonVersion(executable: string): string | undefined {
  try {
    const output = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function rejectRemovedCueParam(
  params: Record<string, unknown>,
  param: string,
  replacement: string,
  toolName: string,
): void {
  if (param in params && params[param] !== undefined && params[param] !== null) {
    throw new Error(
      `${toolName} ${param} is not supported; use ${replacement}. ${toolName} ${param} is no longer supported; use ${replacement}`,
    );
  }
}

function truncationLine(stream: string, jobId: string): string {
  return `[${stream} truncated — use cue_jobs action=status id=${jobId} with a larger bounded tail_bytes value]`;
}

function limitLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (maxLines <= 0) throw new Error("history line limit must be a positive integer");
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(Math.max(0, lines.length - maxLines)).join("\n"), truncated: true };
}

const TOOL_CALL_DEFAULT_ARG_MAX_LENGTH = 80;
const TOOL_CALL_COMMAND_MAX_LENGTH = 120;
const TOOL_CALL_PATH_MAX_LENGTH = 60;
const TOOL_CALL_LABEL_MAX_LENGTH = 40;
const TOOL_CALL_INLINE_SCRIPT_PREVIEW_LINES = 5;
const TOOL_CALL_INLINE_SCRIPT_PREVIEW_MAX_LENGTH = 240;

function renderToolCall(
  toolName: string,
  parts: Array<string | undefined>,
  theme: ToolCallRenderTheme,
): ToolCallComponent {
  const title =
    theme.fg?.("toolTitle", theme.bold?.(`${toolName} `) ?? `${toolName} `) ?? `${toolName} `;
  const renderedParts = parts.filter((part): part is string => Boolean(part));
  const args = theme.fg?.("muted", renderedParts.join(" ")) ?? renderedParts.join(" ");
  return new ToolCallText(`${title}${args}`.trimEnd());
}

function formatStringArg(
  value: unknown,
  options: { prefix?: string; fallback?: string; maxLength?: number } = {},
): string | undefined {
  const text = typeof value === "string" && value.trim() ? value.trim() : options.fallback;
  if (!text) return undefined;
  const rendered = needsQuoting(text) ? JSON.stringify(text) : text;
  return `${options.prefix ?? ""}${truncateInline(rendered, options.maxLength ?? TOOL_CALL_DEFAULT_ARG_MAX_LENGTH)}`;
}

function formatInlineScriptPreview(script: unknown): string[] {
  if (typeof script !== "string" || !script.trim()) return [];
  const nonEmptyLines = script
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const lineCountArg = `inline=${nonEmptyLines.length}line(s)`;
  const preview = nonEmptyLines.slice(0, TOOL_CALL_INLINE_SCRIPT_PREVIEW_LINES).join(" ↵ ");
  return [
    lineCountArg,
    formatStringArg(preview, {
      prefix: "preview=",
      maxLength: TOOL_CALL_INLINE_SCRIPT_PREVIEW_MAX_LENGTH,
    }),
  ].filter((part): part is string => Boolean(part));
}

function formatNumberArg(
  value: unknown,
  options: { prefix?: string; suffix?: string } = {},
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${options.prefix ?? ""}${value}${options.suffix ?? ""}`;
}

function formatNeedsArg(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  const text = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, quantity]) => `${key}=${String(quantity)}`)
    .join(",");
  return `needs=${truncateInline(text, TOOL_CALL_DEFAULT_ARG_MAX_LENGTH)}`;
}

function needsQuoting(value: string): boolean {
  return /\s|["'`]/.test(value);
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

// ── Extension ──────────────────────────────────────────────────────────────

export function registerPiCueTools(pi: PiCueExtensionApi) {
  const clientOwner: CueClientOwner = Symbol("spark-cue-extension");

  // ═══════════════════════════════════════════════════════════════════
  //  cue_exec — execute a command and create a job
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(pi, {
    name: "cue_exec",
    label: "Run Command",
    policy: CUE_EXECUTION_TOOL_POLICY,
    description:
      "Execute a command in cue-shell using the active cue-client transport profile (Unix socket or SSH gateway). " +
      "SSH profiles connect through the configured remote `cued gateway --stdio`; spark-cue does not auto-start remote daemons. " +
      "cue-shell is direct-exec (execvp), not bash: do not use shell-only syntax such as semicolon command lists, redirection, or subshell tests. " +
      "Its composition operators are: |> pipes stdout within one job, &&/|| are job-internal logical operators, -> runs jobs serially on success, ~> runs serially ignoring failure, ||| runs jobs in parallel, and |?| races jobs until one succeeds. " +
      "Prefer direct-exec commands and Pi file tools; do not use shell wrappers for shell-only syntax. " +
      "Set background=true to start without waiting; track with cue_jobs action=status/wait, stop with cue_jobs action=stop. " +
      "For resource-gated jobs, pass needs={ gpu: 1, gpu_mem: '24GiB' } instead of embedding :run(need...) in command. " +
      "Runs without a PTY by default; set pty=true only for commands that genuinely need terminal semantics. " +
      "File-system commands (mv, cp, rm, ls, cat, find, ...) get a short 10s timeout by default.",
    parameters: Type.Object({
      command: Type.String({
        description:
          "Command to execute in cue-shell, not bash. Use cue operators: '|>' for an in-job pipe, '&&'/'||' for job-internal logical operators, '->' for serial-on-success jobs, '~>' for serial ignoring failure, '|||' for parallel jobs, and '|?|' for any-success race jobs. Prefer separate tool calls/Pi file tools over shell wrappers. Examples: 'cargo build |> grep error -> cargo test', '(cargo build ||| cargo audit) -> cargo test'.",
      }),
      background: Type.Optional(
        Type.Boolean({
          description: "If true, start and return immediately with job ID. Default: false.",
          default: false,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Timeout in seconds. Default: 300 (or 10 for file ops). Ignored when background=true.",
          default: 300,
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for the daemon-side job. Defaults to the current Pi session working directory; with SSH profiles this must be valid on the remote host.",
        }),
      ),
      pty: Type.Optional(
        Type.Boolean({
          description:
            "Whether to allocate a PTY. Default: false for non-interactive tool runs; use true only when a command genuinely needs terminal semantics.",
          default: false,
        }),
      ),
      needs: Type.Optional(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
          description:
            "Resource requirements to reserve before spawn, encoded as cue-shell mode params need.<key>=<quantity>. Examples: { gpu: 1, gpu_mem: '24GiB' } or { license: 1 }. Keys omit the need. prefix.",
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit stdout/stderr to the last N bytes per stream. Default: 16384. Must be positive.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_exec",
        [
          formatStringArg(args.command, { maxLength: TOOL_CALL_COMMAND_MAX_LENGTH }),
          args.background === true ? "background" : undefined,
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatStringArg(args.cwd, { prefix: "cwd=" }),
          args.pty === true ? "pty=true" : undefined,
          formatNeedsArg(args.needs),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      rejectRemovedCueParam(params, "tail", "tail_bytes", "cue_exec");
      const command = normalizeRequiredCueString(params.command, "cue_exec command");
      const background = normalizeCueBoolean(params.background, false, "cue_exec background");
      const pty = normalizeCueBoolean(params.pty, false, "cue_exec pty");
      const cwd = resolveCueWorkingDirectory(
        normalizeOptionalCueString(params.cwd, "cue_exec cwd"),
        ctx.cwd,
      );
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_exec tail_bytes",
      );
      const needs = normalizeCueResourceNeeds(params.needs, "cue_exec needs");
      const effectiveTimeout = normalizeCueTimeoutSeconds(
        params.timeout,
        isFileOp(command) ? SHORT_TIMEOUT_S : 300,
        "cue_exec timeout",
      );
      signal.throwIfAborted();

      if (background) {
        const operation = cueToolOperation(ctx, toolCallId, "cue_exec/background");
        const result = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (cued) => cued.startJob(command, { cwd, pty, needs, operation }),
          cueToolRetryOptions(signal, onUpdate),
        );
        const lines: string[] = [];
        if (result.kind === "chain" && result.chain) {
          const chain = result.chain;
          lines.push(`Chain: ${chain.id}  |  ${chain.total_jobs} job(s)`);
          for (const j of chain.jobs)
            lines.push(`  ${j.job_id ?? "(pending)"}  [${j.status.toLowerCase()}]  ${j.pipeline}`);
        } else {
          lines.push(`Job:   ${result.jobId}  [running]`);
          lines.push(`Cmd:   ${result.pipeline ?? command}`);
        }
        lines.push(...warningLines(result.warnings));
        const trackId = result.kind === "chain" && result.chain ? result.chain.id : result.jobId;
        lines.push("", `Track with cue_jobs action=status/wait using id ${trackId}.`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            jobId: result.jobId,
            kind: result.kind,
            chainId: result.chain?.id ?? null,
            chain: result.chain ?? null,
            warnings: result.warnings,
          },
        };
      }

      const operation = cueToolOperation(ctx, toolCallId, "cue_exec/foreground");
      const result = await withCueIdempotentRetry(
        ctx,
        clientOwner,
        operation,
        (cued, attempt) =>
          cued.runJob(command, {
            timeout: (attempt.remainingMs ?? effectiveTimeout * 1_000) / 1_000,
            cwd,
            pty,
            needs,
            signal,
            operation,
          }),
        cueToolRetryOptions(signal, onUpdate, { deadlineMs: effectiveTimeout * 1_000 }),
      );

      if (result.timedOut) {
        const stdout = normalizeCueTerminalOutput(result.stdout);
        const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);
        const lines = [
          `Job ${result.jobId}: Cancelled after timing out at ${effectiveTimeout}s.`,
          ...warningLines(result.warnings),
        ];
        if (stdout.trim()) {
          const t = tailStr(stdout, tailBytes);
          lines.push("", "[stdout so far]", t.text.trimEnd());
          if (t.truncated || result.stdoutTruncated) {
            lines.push(truncationLine("stdout", result.jobId));
          }
        }
        if (stderr.trim()) {
          const t = tailStr(stderr, tailBytes);
          lines.push("", "[stderr so far]", t.text.trimEnd());
          if (t.truncated || result.stderrTruncated) {
            lines.push(truncationLine("stderr", result.jobId));
          }
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            jobId: result.jobId,
            timedOut: true,
            switchedToBackground: false,
            warnings: result.warnings,
            stdoutEncoding: result.stdoutEncoding,
            stderrEncoding: result.stderrEncoding,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            ...(result.stdoutBase64 ? { stdoutBase64: result.stdoutBase64 } : {}),
            ...(result.stderrBase64 ? { stderrBase64: result.stderrBase64 } : {}),
          },
        };
      }

      const stdout = normalizeCueTerminalOutput(result.stdout);
      const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);

      if (
        result.status === "Failed" ||
        result.status === "Killed" ||
        result.status === "Cancelled"
      ) {
        const parts = [`Job ${result.jobId}: ${result.status}`];
        if (result.exitCode !== null) parts.push(` (exit ${result.exitCode})`);
        parts.push(warningBlock(result.warnings));
        if (stdout.trim()) {
          const t = tailStr(stdout, tailBytes);
          parts.push("\n" + t.text.trimEnd());
          if (t.truncated || result.stdoutTruncated) {
            parts.push(`\n${truncationLine("stdout", result.jobId)}`);
          }
        }
        if (stderr.trim()) {
          const t = tailStr(stderr, Math.min(tailBytes, 2_000));
          parts.push("\n[stderr tail]\n" + t.text.trimEnd());
          if (t.truncated || result.stderrTruncated) {
            parts.push(`\n${truncationLine("stderr", result.jobId)}`);
          }
        }
        throw new Error(parts.join(""));
      }

      const out = [`Job ${result.jobId}: ${result.status}`];
      if (result.exitCode !== null && result.exitCode !== 0) out.push(` (exit ${result.exitCode})`);
      out.push(warningBlock(result.warnings));
      if (stdout.trim()) {
        const t = tailStr(stdout, tailBytes);
        out.push("\n" + t.text.trimEnd());
        if (t.truncated || result.stdoutTruncated) {
          out.push(`\n${truncationLine("stdout", result.jobId)}`);
        }
      }
      if (stderr.trim()) {
        const t = tailStr(stderr, tailBytes);
        out.push("\n[stderr]\n" + t.text.trimEnd());
        if (t.truncated || result.stderrTruncated) {
          out.push(`\n${truncationLine("stderr", result.jobId)}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: out.join("") }],
        details: {
          jobId: result.jobId,
          status: result.status,
          exitCode: result.exitCode,
          warnings: result.warnings,
          cancelReason: result.cancelReason ?? null,
          stdoutEncoding: result.stdoutEncoding,
          stderrEncoding: result.stderrEncoding,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          ...(result.stdoutBase64 ? { stdoutBase64: result.stdoutBase64 } : {}),
          ...(result.stderrBase64 ? { stderrBase64: result.stderrBase64 } : {}),
        },
      };
    },
  });

  // ══════════════════════════════════════════════════════════════════
  //  cue_run / cue_script — run a .cue script (path or inline body)
  // ══════════════════════════════════════════════════════════════════

  async function runCueScript(
    options: {
      resolvedPath: string;
      body: string;
      pathLabel: string;
      timeout: number;
      tailBytes: number;
      toolName: "cue_run" | "cue_script" | "script_run" | "script_eval";
      toolCallId: string;
      signal: AbortSignal;
      onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void;
    },
    ctx: PiCueToolContext,
  ) {
    const {
      resolvedPath,
      body,
      pathLabel,
      timeout,
      tailBytes,
      toolName,
      toolCallId,
      signal,
      onUpdate,
    } = options;
    signal.throwIfAborted();
    if (!body.trim()) {
      throw new Error(`${toolName} body is empty (cue-shell rejects empty scripts)`);
    }
    const operation = cueToolOperation(ctx, toolCallId, `${toolName}/run-script`);
    const result = await withCueIdempotentRetry(
      ctx,
      clientOwner,
      operation,
      (cued, attempt) =>
        cued.runScript({
          path: resolvedPath,
          input: body,
          timeout: (attempt.remainingMs ?? timeout * 1_000) / 1_000,
          signal,
          operation,
        }),
      cueToolRetryOptions(signal, onUpdate, {
        replaySafe: true,
        deadlineMs: timeout * 1_000,
      }),
    );
    const lines = renderCueScriptResult(result, { pathLabel, timeout, tailBytes });
    const summary = result.items.map((item) => ({
      index: item.index,
      source: item.source,
      kind: item.kind,
      jobIds: item.jobIds,
      chainId: item.chainId,
      cronId: item.cronId,
      status: item.status,
      exitCode: item.exitCode,
    }));
    const output = { content: [{ type: "text" as const, text: lines.join("\n") }] };
    const details = {
      scriptId: result.scriptId,
      source: result.source,
      status: result.status,
      exitCode: result.exitCode,
      failedItemIndex: result.failedItemIndex,
      timedOut: result.timedOut,
      items: summary,
    };
    if (result.status === "failed" && !result.timedOut) {
      const err = new Error(lines.join("\n"));
      (err as unknown as { details?: unknown }).details = details;
      throw err;
    }
    return { ...output, details };
  }

  registerCueTool(pi, {
    name: "cue_run",
    label: "Run Cue File",
    policy: CUE_EXECUTION_TOOL_POLICY,
    description:
      "Run a .cue file in cue-shell, mirroring `cue run <file.cue>`. " +
      "Top-level items execute sequentially with fail-fast semantics inside a fresh isolated scope forked from HEAD. " +
      "Each item may use cue-shell composition operators (`|>`, `&&`, `||`, `->`, `~>`, `|||`, `|?|`) but must not use bash-shell syntax (`;`, redirection). " +
      "For inline bodies (no file on disk) use cue_script instead. " +
      "Foreground only: blocks until ScriptFinished or `timeout` seconds elapse; timeout cancels the active script execution before returning.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Path to a .cue file to run. Required. Resolved against the current Pi session working directory when relative.",
      }),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Foreground wait budget in seconds. Default: 300. On timeout the active script execution is cancelled before the tool returns timedOut=true.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit per-item stdout/stderr to the last N bytes when rendering the aggregated transcript. Default: 16384. Must be positive.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_run",
        [
          formatStringArg(args.path, { prefix: "path=", maxLength: TOOL_CALL_PATH_MAX_LENGTH }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const pathParam = normalizeRequiredCueString(params.path, "cue_run path");
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "cue_run timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_run tail_bytes",
      );
      const baseCwd = resolveCueWorkingDirectory(undefined, ctx.cwd);
      const { isAbsolute, resolve } = await import("node:path");
      const resolvedPath = isAbsolute(pathParam) ? pathParam : resolve(baseCwd, pathParam);
      if (!resolvedPath.endsWith(".cue")) {
        throw new Error(`cue_run path must end in .cue (got ${resolvedPath})`);
      }
      const { readFile } = await import("node:fs/promises");
      let body: string;
      try {
        body = await readFile(resolvedPath, "utf-8");
      } catch (err) {
        throw new Error(`cue_run failed to read ${resolvedPath}: ${(err as Error).message}`);
      }
      return runCueScript(
        {
          resolvedPath,
          body,
          pathLabel: resolvedPath,
          timeout,
          tailBytes,
          toolName: "cue_run",
          toolCallId,
          signal,
          onUpdate,
        },
        ctx,
      );
    },
  });

  registerCueTool(pi, {
    name: "cue_script",
    label: "Run Cue Script",
    policy: CUE_EXECUTION_TOOL_POLICY,
    description:
      "Run an inline .cue script body in cue-shell. " +
      "Top-level items execute sequentially with fail-fast semantics inside a fresh isolated scope forked from HEAD. " +
      "Each item may use cue-shell composition operators (`|>`, `&&`, `||`, `->`, `~>`, `|||`, `|?|`) but must not use bash-shell syntax (`;`, redirection). " +
      "If you have a real .cue file on disk, prefer cue_run. " +
      "Optionally provide `pathLabel` to label the inline script in TUI history. " +
      "Foreground only: blocks until ScriptFinished or `timeout` seconds elapse; timeout cancels the active script execution before returning.",
    parameters: Type.Object({
      script: Type.String({
        description:
          "Inline .cue script body. Required. The script is sent to the daemon as if it were a file at `pathLabel` (defaults to `<inline>`).",
      }),
      pathLabel: Type.Optional(
        Type.String({
          description: "Display label for inline scripts. Default: `<inline>`.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Foreground wait budget in seconds. Default: 300. On timeout the active script execution is cancelled before the tool returns timedOut=true.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit per-item stdout/stderr to the last N bytes when rendering the aggregated transcript. Default: 16384. Must be positive.",
        }),
      ),
    }),
    renderCall(args, theme) {
      const scriptArg =
        typeof args.script === "string" && args.script.trim()
          ? `inline=${(args.script as string).split(/\r?\n/).filter((l) => l.trim()).length}line(s)`
          : undefined;
      return renderToolCall(
        "cue_script",
        [
          scriptArg,
          formatStringArg(args.pathLabel, {
            prefix: "label=",
            maxLength: TOOL_CALL_LABEL_MAX_LENGTH,
          }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const scriptParam = normalizeRequiredCueString(params.script, "cue_script script");
      const pathLabel =
        normalizeOptionalCueString(params.pathLabel, "cue_script pathLabel") ?? "<inline>";
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "cue_script timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_script tail_bytes",
      );
      return runCueScript(
        {
          resolvedPath: pathLabel,
          body: scriptParam,
          pathLabel,
          timeout,
          tailBytes,
          toolName: "cue_script",
          toolCallId,
          signal,
          onUpdate,
        },
        ctx,
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  script_run / script_eval — generic script runners
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(pi, {
    name: "script_run",
    label: "Run Script File",
    policy: CUE_EXECUTION_TOOL_POLICY,
    description:
      "Run a script file with an explicit language runner. " +
      "Supported languages in this version: cue-shell and python. " +
      "For cue-shell this delegates to RunScript and mirrors cue_run; for python it executes through uv run --script <path>, optionally with --python <venv>/bin/python, and reports the resolved runner in details.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the script file to run." }),
      language: Type.String({ description: "Script language. Required: cue-shell or python." }),
      timeout: Type.Optional(
        Type.Number({
          description: "Foreground wait budget in seconds. Default: 300.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description: "Limit stdout/stderr to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
      venv: Type.Optional(
        Type.String({ description: "Python virtualenv path. Only valid for language=python." }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "script_run",
        [
          formatStringArg(args.language, { prefix: "lang=" }),
          formatStringArg(args.path, { prefix: "path=", maxLength: TOOL_CALL_PATH_MAX_LENGTH }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
          formatStringArg(args.venv, { prefix: "venv=", maxLength: TOOL_CALL_LABEL_MAX_LENGTH }),
        ],
        theme,
      );
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const language = normalizeCueEnum(
        params.language,
        undefined,
        SCRIPT_LANGUAGES,
        "script_run language",
      );
      const pathParam = normalizeRequiredCueString(params.path, "script_run path");
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "script_run timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "script_run tail_bytes",
      );
      const venvParam = normalizeOptionalCueString(params.venv, "script_run venv");
      if (language !== "python" && venvParam)
        throw new Error("script_run venv is only supported for language=python");
      const baseCwd = resolveCueWorkingDirectory(undefined, ctx.cwd);
      const { isAbsolute, resolve } = await import("node:path");
      const resolvedPath = isAbsolute(pathParam) ? pathParam : resolve(baseCwd, pathParam);
      const venv = venvParam
        ? isAbsolute(venvParam)
          ? venvParam
          : resolve(baseCwd, venvParam)
        : undefined;
      if (language === "cue-shell") {
        if (!resolvedPath.endsWith(".cue")) {
          throw new Error(
            `script_run language=cue-shell path must end in .cue (got ${resolvedPath})`,
          );
        }
        const { readFile } = await import("node:fs/promises");
        let body: string;
        try {
          body = await readFile(resolvedPath, "utf-8");
        } catch (err) {
          throw new Error(`script_run failed to read ${resolvedPath}: ${(err as Error).message}`);
        }
        return runCueScript(
          {
            resolvedPath,
            body,
            pathLabel: resolvedPath,
            timeout,
            tailBytes,
            toolName: "script_run",
            toolCallId,
            signal,
            onUpdate,
          },
          ctx,
        );
      }

      const operation = cueToolOperation(ctx, toolCallId, "script_run/python");
      return withCueIdempotentRetry(
        ctx,
        clientOwner,
        operation,
        (cued, attempt) =>
          runPythonScriptJob(cued, {
            path: resolvedPath,
            timeout: (attempt.remainingMs ?? timeout * 1_000) / 1_000,
            tailBytes,
            cwd: baseCwd,
            venv,
            signal,
            operation,
          }),
        cueToolRetryOptions(signal, onUpdate, { deadlineMs: timeout * 1_000 }),
      );
    },
  });

  registerCueTool(pi, {
    name: "script_eval",
    label: "Evaluate Script",
    policy: CUE_EXECUTION_TOOL_POLICY,
    description:
      "Run an inline script body with an explicit language runner. " +
      "Supported languages in this version: cue-shell and python. " +
      "Inline Python is piped to uv run --script - through cue-shell, optionally with --python <venv>/bin/python, and reports the resolved runner in details. Manual cue_exec python calls are blocked by the default daemon guardrails.",
    parameters: Type.Object({
      script: Type.String({ description: "Inline script body to run." }),
      language: Type.String({ description: "Script language. Required: cue-shell or python." }),
      pathLabel: Type.Optional(
        Type.String({ description: "Display label for inline scripts. Default: <inline>." }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Foreground wait budget in seconds. Default: 300.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description: "Limit stdout/stderr to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
      venv: Type.Optional(
        Type.String({ description: "Python virtualenv path. Only valid for language=python." }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "script_eval",
        [
          formatStringArg(args.language, { prefix: "lang=" }),
          ...formatInlineScriptPreview(args.script),
          formatStringArg(args.pathLabel, {
            prefix: "label=",
            maxLength: TOOL_CALL_LABEL_MAX_LENGTH,
          }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
          formatStringArg(args.venv, { prefix: "venv=", maxLength: TOOL_CALL_LABEL_MAX_LENGTH }),
        ],
        theme,
      );
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const language = normalizeCueEnum(
        params.language,
        undefined,
        SCRIPT_LANGUAGES,
        "script_eval language",
      );
      const script = normalizeRequiredCueString(params.script, "script_eval script");
      const pathLabel =
        normalizeOptionalCueString(params.pathLabel, "script_eval pathLabel") ?? "<inline>";
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "script_eval timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "script_eval tail_bytes",
      );
      const venvParam = normalizeOptionalCueString(params.venv, "script_eval venv");
      if (language !== "python" && venvParam)
        throw new Error("script_eval venv is only supported for language=python");
      const baseCwd = resolveCueWorkingDirectory(undefined, ctx.cwd);
      const { isAbsolute, resolve } = await import("node:path");
      const venv = venvParam
        ? isAbsolute(venvParam)
          ? venvParam
          : resolve(baseCwd, venvParam)
        : undefined;
      if (language === "cue-shell") {
        return runCueScript(
          {
            resolvedPath: pathLabel,
            body: script,
            pathLabel,
            timeout,
            tailBytes,
            toolName: "script_eval",
            toolCallId,
            signal,
            onUpdate,
          },
          ctx,
        );
      }

      const operation = cueToolOperation(ctx, toolCallId, "script_eval/python");
      return withCueIdempotentRetry(
        ctx,
        clientOwner,
        operation,
        (cued, attempt) =>
          runPythonScriptJob(cued, {
            inlineScript: script,
            pathLabel,
            timeout: (attempt.remainingMs ?? timeout * 1_000) / 1_000,
            tailBytes,
            cwd: baseCwd,
            venv,
            signal,
            operation,
          }),
        cueToolRetryOptions(signal, onUpdate, { deadlineMs: timeout * 1_000 }),
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_jobs — manage and inspect jobs
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(pi, {
    name: "cue_jobs",
    label: "Cue Jobs",
    policy: CUE_JOBS_TOOL_POLICY,
    description:
      "Manage cue-shell jobs. action='list' lists jobs, action='status' inspects a job, chain, or cron, action='wait' waits for a job or chain, and action='stop' stops a job or removes a cron.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "Action: list, status, wait, stop. Default: list.",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Target ID: job J<n>; chain CH<n> for status/wait; cron C<n> for status/stop.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Filter for action='list': running, pending, done, failed, killed, all. Default: all.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum jobs to show for action='list'. Default: 20." }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Max wait time in seconds for action='wait'. Default: 300." }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit stdout/stderr to the last N bytes for action='status' or action='wait'. Default: 16384. Must be positive.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_jobs",
        [
          formatStringArg(args.action, { prefix: "action=", fallback: "list" }),
          formatStringArg(args.id, { prefix: "id=" }),
          formatStringArg(args.status, { prefix: "status=" }),
          formatNumberArg(args.limit, { prefix: "limit=" }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const action = normalizeCueEnum(params.action, "list", CUE_JOB_ACTIONS, "cue_jobs action");
      const id = normalizeOptionalCueString(params.id, "cue_jobs id");
      const statusFilter = normalizeCueEnum(
        params.status,
        "all",
        CUE_JOB_STATUS_FILTERS,
        "cue_jobs status",
      );
      const limit = normalizeCueLimit(params.limit, DEFAULT_LIST_LIMIT, "cue_jobs limit");
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "cue_jobs timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_jobs tail_bytes",
      );
      const cued = await getClient(ctx, clientOwner);

      if (action === "list") {
        let jobs = await cued.listJobs();
        if (statusFilter !== "all")
          jobs = jobs.filter((j) => j.status.toLowerCase() === statusFilter);
        const total = jobs.length;
        jobs = jobs.slice(0, limit);
        if (total === 0)
          return {
            content: [{ type: "text" as const, text: "No matching jobs." }],
            details: { count: 0, shown: 0, jobs: [] },
          };
        const lines = jobs.map(formatJobListLine);
        if (total > jobs.length) lines.push(`… ${total - jobs.length} more job(s)`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { count: total, shown: jobs.length, jobs },
        };
      }

      if (!id)
        return {
          content: [{ type: "text" as const, text: `action='${action}' requires id parameter.` }],
          details: { error: "missing_id" },
        };

      if (action === "stop") {
        const operation = cueToolOperation(ctx, toolCallId, "cue_jobs/stop");
        await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.stopJob(id, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [{ type: "text" as const, text: `Stopped ${id}.` }],
          details: { targetId: id },
        };
      }

      if (action === "status") {
        if (id.startsWith("CH")) {
          const jobs = jobsForChain(await cued.listJobs(), id);
          if (jobs.length === 0)
            return {
              content: [{ type: "text" as const, text: `${id} not found.` }],
              details: { found: false },
            };

          const lines = await renderCueChainStatus(cued, id, jobs, tailBytes);
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: {
              chainId: id,
              status: chainStatus(jobs),
              jobs,
            },
          };
        }

        if (id.startsWith("C")) {
          const cron = await cued.cronStatus(id);
          if (!cron)
            return {
              content: [{ type: "text" as const, text: `${id} not found.` }],
              details: { found: false },
            };
          return {
            content: [
              {
                type: "text" as const,
                text: `⏰ ${cron.id}  [${cron.status}]  ${cron.schedule} → ${cron.command}`,
              },
            ],
            details: {
              cronId: cron.id,
              status: cron.status,
              schedule: cron.schedule,
              command: cron.command,
            },
          };
        }

        const job = await cued.jobStatus(id);
        if (!job)
          return {
            content: [{ type: "text" as const, text: `${id} not found.` }],
            details: { found: false },
          };

        const parts = [`${statusLabel(job.status)} — ${job.pipeline}`];
        if (job.exit_code != null) parts.push(`Exit code: ${job.exit_code}`);
        appendPendingReason(job, parts);
        if (job.chain_id)
          parts.push(
            `Chain: ${job.chain_id} (leaf ${(job.chain_index ?? 0) + 1}/${job.chain_total ?? "?"})`,
          );

        await appendJobOutput(cued, job, parts, tailBytes);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {
            jobId: job.id,
            status: job.status,
            exitCode: job.exit_code,
            pipeline: job.pipeline,
            pendingReason: jobPendingReason(job) ?? null,
          },
        };
      }

      if (action === "wait") {
        const deadline = Date.now() + timeout * 1000;

        if (id.startsWith("CH")) {
          while (Date.now() < deadline) {
            const jobs = jobsForChain(await cued.listJobs(), id);
            if (jobs.length === 0)
              return {
                content: [{ type: "text" as const, text: `Chain ${id} not found.` }],
                details: { found: false },
              };
            const expectedCount = Math.max(...jobs.map((job) => job.chain_total ?? jobs.length));
            const hasTerminalFailure = jobs.some(
              (job) => job.status !== "Done" && isTerminalJob(job.status),
            );
            if (
              (jobs.length >= expectedCount || hasTerminalFailure) &&
              jobs.every((job) => isTerminalJob(job.status))
            ) {
              const status = chainStatus(jobs);
              const lines = await renderCueChainStatus(cued, id, jobs, tailBytes);
              const text = `Chain ${id} completed\n\n${lines.join("\n")}`;
              if (status === "Failed") throw new Error(text);
              if (status === "Killed") throw new Error(`Chain ${id} was killed`);
              if (status === "Cancelled") throw new Error(`Chain ${id} was cancelled`);
              return {
                content: [{ type: "text" as const, text }],
                details: {
                  chainId: id,
                  status,
                  jobs,
                },
              };
            }
            await new Promise((r) => setTimeout(r, 500));
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Timed out after ${timeout}s waiting for ${id}.`,
              },
            ],
            details: { timedOut: true, targetId: id },
          };
        }

        while (Date.now() < deadline) {
          const job = await cued.jobStatus(id);
          if (!job)
            return {
              content: [{ type: "text" as const, text: `Job ${id} not found.` }],
              details: { found: false },
            };

          if (
            job.status === "Done" ||
            job.status === "Failed" ||
            job.status === "Killed" ||
            job.status === "Cancelled"
          ) {
            const lines = [`${statusLabel(job.status)} — ${job.pipeline}`];
            if (job.exit_code != null) lines.push(`Exit code: ${job.exit_code}`);
            appendPendingReason(job, lines);
            await appendJobOutput(cued, job, lines, tailBytes);
            const text = `Job ${id} completed\n\n${lines.join("\n")}`;
            if (job.status === "Failed") throw new Error(text);
            if (job.status === "Killed") throw new Error(`Job ${id} was killed`);
            if (job.status === "Cancelled") throw new Error(`Job ${id} was cancelled`);
            return {
              content: [{ type: "text" as const, text }],
              details: {
                jobId: job.id,
                status: job.status,
                exitCode: job.exit_code,
                pendingReason: jobPendingReason(job) ?? null,
              },
            };
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Timed out after ${timeout}s waiting for ${id}.`,
            },
          ],
          details: { timedOut: true },
        };
      }
      throw new Error("Unhandled cue_jobs action");
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_resources — inspect resource providers and capacity
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(pi, {
    name: "cue_resources",
    label: "Cue Resources",
    policy: CUE_RESOURCES_TOOL_POLICY,
    description:
      "Inspect cue-shell resource scheduling state. action='providers' lists registered providers, routed resource keys, and active reservations; action='resources' shows current provider snapshots/units when providers support probing.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "Action: providers or resources. Default: providers.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_resources",
        [formatStringArg(args.action, { prefix: "action=", fallback: "providers" })],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const action = normalizeCueEnum(
        params.action,
        "providers",
        CUE_RESOURCE_ACTIONS,
        "cue_resources action",
      );
      const cued = await getClient(ctx, clientOwner);
      const command = action === "providers" ? ":providers" : ":resources";
      const text = await cued.evalText(command);
      const hint = cueResourceProviderHint(text);
      const rendered = hint ? `${text.trimEnd()}\n\n${hint}` : text;
      return {
        content: [{ type: "text" as const, text: rendered }],
        details: { action, command, ...(hint ? { hint } : {}) },
      };
    },
  });

  function cueResourceProviderHint(text: string): string | undefined {
    const normalized = text.trim().toLowerCase();
    if (
      !normalized ||
      /no .*resource .*providers|no .*providers|providers:\s*0|registered providers:\s*0/u.test(
        normalized,
      )
    ) {
      return [
        "Hint: no cue-shell resource provider is registered for this session.",
        '  next: run cue_resources({ action: "providers" }) to confirm provider routing, remove needs={...} from cue_exec when no gated resource is required, or start/register a cue-shell resource provider for keys such as gpu/gpu_mem before submitting resource-gated jobs.',
      ].join("\n");
    }
    return undefined;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  cue_schedule — unified schedule management
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(pi, {
    name: "cue_schedule",
    label: "Cue Schedule",
    policy: CUE_SCHEDULE_TOOL_POLICY,
    description:
      "Manage scheduled cue-shell jobs. " +
      "action='add': schedule a recurring or one-shot job (requires schedule + command). " +
      "action='list': list schedules. " +
      "action='pause'/'resume': control a schedule by id. " +
      "action='remove': delete a schedule by id (also available via cue_jobs action=stop).",
    parameters: Type.Object({
      action: Type.String({
        description: "Action: add, list, pause, resume, remove.",
      }),
      schedule: Type.Optional(
        Type.String({
          description:
            "Schedule (required for action='add'). Examples: 'every 5m', 'at 14:30', 'in 30s', 'daily', 'hourly', or raw cron '*/5 * * * *'.",
        }),
      ),
      command: Type.Optional(
        Type.String({
          description: "Command to run on schedule (required for action='add').",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description: "Schedule/cron ID (C<n>), required for pause/resume/remove.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Filter for action='list': scheduled, paused, completed, expired, failed, all. Default: all.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum schedules to show for action=list. Default: 20." }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_schedule",
        [
          formatStringArg(args.action, { prefix: "action=", fallback: "list" }),
          formatStringArg(args.id, { prefix: "id=" }),
          formatStringArg(args.schedule, {
            prefix: "schedule=",
            maxLength: TOOL_CALL_LABEL_MAX_LENGTH,
          }),
          formatStringArg(args.command, {
            prefix: "command=",
            maxLength: TOOL_CALL_DEFAULT_ARG_MAX_LENGTH,
          }),
          formatStringArg(args.status, { prefix: "status=" }),
          formatNumberArg(args.limit, { prefix: "limit=" }),
        ],
        theme,
      );
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const action = normalizeCueEnum(
        params.action,
        undefined,
        CUE_SCHEDULE_ACTIONS,
        "cue_schedule action",
      );
      const schedule = normalizeOptionalCueString(params.schedule, "cue_schedule schedule");
      const command = normalizeOptionalCueString(params.command, "cue_schedule command");
      const id = normalizeOptionalCueString(params.id, "cue_schedule id");
      const statusFilter = normalizeCueEnum(
        params.status,
        "all",
        CUE_SCHEDULE_STATUS_FILTERS,
        "cue_schedule status",
      );
      const limit = normalizeCueLimit(params.limit, DEFAULT_LIST_LIMIT, "cue_schedule limit");
      const cued = await getClient(ctx, clientOwner);

      // add
      if (action === "add") {
        if (!schedule || !command) {
          return {
            content: [
              {
                type: "text" as const,
                text: "action='add' requires schedule and command.",
              },
            ],
            details: {},
          };
        }
        const operation = cueToolOperation(ctx, toolCallId, "cue_schedule/add");
        const cronId = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.addCron(schedule, command, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Schedule: ${cronId}\nRemove with cue_schedule action=remove id=${cronId}.`,
            },
          ],
          details: {
            cronId,
            schedule,
            command,
          },
        };
      }

      // list
      if (action === "list") {
        let crons = await cued.listCrons();
        if (statusFilter !== "all")
          crons = crons.filter((c) => c.status.toLowerCase() === statusFilter);
        const total = crons.length;
        crons = crons.slice(0, limit);
        if (total === 0)
          return {
            content: [{ type: "text" as const, text: "No matching schedules." }],
            details: { count: 0, shown: 0, crons: [] },
          };
        const lines = crons.map((c) => `${c.id}  [${c.status}]  ${c.schedule}  →  ${c.command}`);
        if (total > crons.length) lines.push(`… ${total - crons.length} more schedule(s)`);
        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n"),
            },
          ],
          details: { count: total, shown: crons.length, crons },
        };
      }

      // pause / resume / remove
      if (!id) {
        return {
          content: [
            {
              type: "text" as const,
              text: `action='${action}' requires id parameter.`,
            },
          ],
          details: {},
        };
      }

      if (action === "pause") {
        const operation = cueToolOperation(ctx, toolCallId, "cue_schedule/pause");
        await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.pauseCron(id, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Paused ${id}. Resume with cue_schedule action=resume id=${id}.`,
            },
          ],
          details: { id, paused: true },
        };
      }
      if (action === "resume") {
        const operation = cueToolOperation(ctx, toolCallId, "cue_schedule/resume");
        await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.resumeCron(id, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Resumed ${id}.`,
            },
          ],
          details: { id, resumed: true },
        };
      }
      if (action === "remove") {
        const operation = cueToolOperation(ctx, toolCallId, "cue_schedule/remove");
        await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.removeCron(id, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Removed ${id}.`,
            },
          ],
          details: { id, removed: true },
        };
      }
      throw new Error("Unhandled cue_schedule action");
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_scope — inspect scopes, env, or config
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(pi, {
    name: "cue_scope",
    label: "Cue Scope",
    policy: CUE_SCOPE_TOOL_POLICY,
    description:
      "Inspect or mutate cue-shell session state. action='list' lists scopes, 'env' shows session env, 'config' shows config, 'env_set' sets KEY=VALUE, 'env_unset' removes KEY, 'path_prepend' prepends PATH, 'cd' changes session cwd, 'refresh' explicitly refreshes the session from host cwd/env, and 'status' shows bounded cwd/PATH status.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description:
            "Action: list, env, config, env_set, env_unset, path_prepend, cd, refresh, or status. Default: list.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum scopes to show for action='list'. Default: 20." }),
      ),
      includeEnv: Type.Optional(
        Type.Boolean({
          description: "For action='list', also include HEAD env output. Default: false.",
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "For action='env' or action='config', limit output to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
      key: Type.Optional(
        Type.String({
          description: "Environment variable name for action='env_set' or 'env_unset'.",
        }),
      ),
      value: Type.Optional(
        Type.String({ description: "Environment variable value for action='env_set'." }),
      ),
      path: Type.Optional(
        Type.String({ description: "Path for action='path_prepend' or action='cd'." }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_scope",
        [
          formatStringArg(args.action, { prefix: "action=", fallback: "list" }),
          formatNumberArg(args.limit, { prefix: "limit=" }),
          args.includeEnv === true ? "include-env" : undefined,
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
          formatStringArg(args.key, { prefix: "key=" }),
          formatStringArg(args.path, { prefix: "path=" }),
        ],
        theme,
      );
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      rejectRemovedCueParam(params, "env_tail_bytes", "tail_bytes", "cue_scope");
      const action = normalizeCueEnum(params.action, "list", CUE_SCOPE_ACTIONS, "cue_scope action");
      const limit = normalizeCueLimit(params.limit, DEFAULT_LIST_LIMIT, "cue_scope limit");
      const includeEnv = normalizeCueBoolean(params.includeEnv, false, "cue_scope includeEnv");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_scope tail_bytes",
      );
      const cued = await getClient(ctx, clientOwner);

      if (action === "env_set") {
        const key = normalizeCueEnvKey(params.key, "cue_scope key");
        const value = normalizeCueEnvValue(params.value, "cue_scope value");
        const operation = cueToolOperation(ctx, toolCallId, "cue_scope/env_set");
        const scope = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.setEnv({ [key]: value }, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Set ${key} for this cue session.\n${scope.summary}`,
            },
          ],
          details: { action, key, scope },
        };
      }

      if (action === "env_unset") {
        const key = normalizeCueEnvKey(params.key, "cue_scope key");
        const operation = cueToolOperation(ctx, toolCallId, "cue_scope/env_unset");
        const scope = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.unsetEnv([key], operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Unset ${key} for this cue session.\n${scope.summary}`,
            },
          ],
          details: { action, key, scope },
        };
      }

      if (action === "path_prepend") {
        const path = normalizeCueSessionPath(params.path, "cue_scope path");
        const envText = await cued.showEnv();
        const currentPath = parseCueEnvValue(envText, "PATH") ?? "";
        const nextPath = currentPath ? `${path}:${currentPath}` : path;
        const operation = cueToolOperation(ctx, toolCallId, "cue_scope/path_prepend");
        const scope = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.setEnv({ PATH: nextPath }, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Prepended ${path} to PATH for this cue session.\n${scope.summary}`,
            },
          ],
          details: { action, path, scope },
        };
      }

      if (action === "cd") {
        const path = normalizeCueSessionPath(params.path, "cue_scope path");
        const operation = cueToolOperation(ctx, toolCallId, "cue_scope/cd");
        const scope = await withCueIdempotentRetry(
          ctx,
          clientOwner,
          operation,
          (client) => client.changeDirectory(path, operation),
          cueToolRetryOptions(signal, onUpdate),
        );
        return {
          content: [{ type: "text" as const, text: `Changed cue session cwd.\n${scope.summary}` }],
          details: { action, path, scope },
        };
      }

      if (action === "refresh") {
        const session = { ...cueSessionOptionsFromContext(ctx), refresh: true };
        await cued.handshake(session);
        const envText = await cued.showEnv();
        const cwdLine = envText.split(/\r?\n/u).find((line) => line.startsWith("cwd=")) ?? "cwd=?";
        const pathValue = parseCueEnvValue(envText, "PATH") ?? "";
        const pathPreview = tailStr(pathValue, Math.min(tailBytes, DEFAULT_CUE_TAIL_BYTES));
        const lines = [
          "Refreshed cue session from host cwd/env.",
          cwdLine,
          `PATH=${pathPreview.text}`,
        ];
        if (pathPreview.truncated)
          lines.push("[PATH truncated — use action=status/env with a larger tail_bytes value]");
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            action,
            sessionId: session.sessionId,
            cwd: session.cwd,
            envKeys: Object.keys(session.env).length,
            pathChars: pathValue.length,
            shownPathChars: pathPreview.text.length,
            truncated: pathPreview.truncated,
          },
        };
      }

      if (action === "status") {
        const envText = await cued.showEnv();
        const cwdLine = envText.split(/\r?\n/u).find((line) => line.startsWith("cwd=")) ?? "cwd=?";
        const pathValue = parseCueEnvValue(envText, "PATH") ?? "";
        const pathPreview = tailStr(pathValue, Math.min(tailBytes, DEFAULT_CUE_TAIL_BYTES));
        const lines = [cwdLine, `PATH=${pathPreview.text}`];
        if (pathPreview.truncated)
          lines.push("[PATH truncated — use action=env with a larger bounded tail_bytes value]");
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            action,
            cwd: cwdLine.slice("cwd=".length),
            pathChars: pathValue.length,
            shownPathChars: pathPreview.text.length,
            truncated: pathPreview.truncated,
          },
        };
      }

      if (action === "env" || action === "config") {
        const raw = action === "env" ? await cued.showEnv() : await cued.showConfig();
        const safe = action === "env" ? redactCueEnvText(raw) : raw;
        const tailed = tailStr(safe, tailBytes);
        const lines = [tailed.text.trimEnd()];
        if (tailed.truncated)
          lines.push(`[${action} truncated — use a larger bounded tail_bytes value]`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            action,
            rawChars: raw.length,
            shownChars: tailed.text.length,
            truncated: tailed.truncated,
          },
        };
      }

      const all = await cued.listScopes();
      const visible = all.slice(0, limit);
      if (all.length === 0)
        return {
          content: [{ type: "text" as const, text: "No scopes." }],
          details: { count: 0, shown: 0, scopes: [] },
        };
      const lines = visible.map(
        (scope) =>
          `${scope.hash}  parent=${scope.parent ?? "-"}  cwd=${scope.cwd}  env=${scope.env_count}`,
      );
      if (all.length > visible.length) lines.push(`… ${all.length - visible.length} more scope(s)`);
      if (includeEnv) {
        const env = tailStr(redactCueEnvText(await cued.showEnv()), tailBytes);
        lines.push("", "--- HEAD env ---", env.text.trimEnd());
        if (env.truncated)
          lines.push("[HEAD env truncated — use a larger bounded tail_bytes value]");
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { count: all.length, shown: visible.length, scopes: visible },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_history — show history
  // ═══════════════════════════════════════════════════════════════════

  registerCueTool(pi, {
    name: "cue_history",
    label: "Cue History",
    policy: CUE_HISTORY_TOOL_POLICY,
    description:
      "Show recent cue-shell history. Pass an id to focus on one job/cron. Output is bounded by default.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: "Optional job ID (J<n>) or cron ID (C<n>) to focus on.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum recent history lines to show. Default: 80. Must be positive.",
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description: "Limit history text to the last N bytes. Default: 16384. Must be positive.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_history",
        [
          formatStringArg(args.id),
          formatNumberArg(args.limit, { prefix: "limit=" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const id = normalizeOptionalCueString(params.id, "cue_history id");
      const limit = normalizeCueLimit(params.limit, 80, "cue_history limit");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_history tail_bytes",
      );
      const cued = await getClient(ctx, clientOwner);
      const raw = await cued.showLog(id, limit, tailBytes);
      const tailed = tailStr(raw, tailBytes);
      const limited = limitLines(tailed.text, limit);
      const messages: string[] = [];
      if (tailed.truncated)
        messages.push("[history truncated by bytes — use a larger bounded tail_bytes value]");
      if (limited.truncated)
        messages.push("[history truncated by lines — use a larger bounded limit value]");
      return {
        content: [
          { type: "text" as const, text: [limited.text, ...messages].filter(Boolean).join("\n") },
        ],
        details: {
          id: id ?? null,
          rawChars: raw.length,
          shownChars: limited.text.length,
          truncated: tailed.truncated || limited.truncated,
        },
      };
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  pi.on?.("session_start", () => {
    if (!pi.getActiveTools || !pi.setActiveTools) return;
    const withoutBash = pi.getActiveTools().filter((name) => name !== "bash");
    pi.setActiveTools(withoutBash);
  });

  pi.on?.("session_shutdown", (_event, ctx) => {
    releaseClientOwner(clientOwner, ctx as PiCueToolContext | undefined);
  });
}

export default function piCueExtension(pi: ExtensionAPI) {
  if (!pi.registerTool) throw new Error("spark-cue extension requires registerTool support");
  registerPiCueTools({
    registerTool: (config) => pi.registerTool?.(config),
    on: pi.on
      ? (event, handler) => {
          pi.on?.(event, (payload, ctx) => handler(payload, ctx));
        }
      : undefined,
    getActiveTools: pi.getActiveTools ? () => pi.getActiveTools!() : undefined,
    setActiveTools: pi.setActiveTools ? (names) => pi.setActiveTools!(names) : undefined,
  });
}
