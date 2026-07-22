/** `spark daemon ...` command parsing and Spark daemon IPC client operations. */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ChannelNotifySendResult } from "@zendev-lab/spark-channels";
import {
  createId,
  parseSparkDaemonEvent,
  parseSparkInteractionResponse,
  parseSparkSessionView,
  sparkCommandKindForLocalRpcMethod,
  sparkProtocolJsonObjectSchema,
  type SparkCommand,
  type SparkAssignment,
  type SparkDaemonEvent,
  type SparkInvocationListResult,
  type SparkInvocationRetentionPreviewResult,
  type SparkInvocationRetryResult,
  type SparkInvocationStatus,
  type SparkInteractionRequest,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionRegistryRecord,
  type SparkSessionView,
  type SparkViewModelEvent,
  type SparkTurnCancelResult,
  type SparkTurnResult,
  type SparkTurnStatusResult,
  type SparkTurnStreamPage,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import { sparkDaemonCliStrings } from "@zendev-lab/spark-i18n/cli";
import { cappedExponentialCeiling, equalJitter } from "@zendev-lab/spark-retry";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  requestSparkDaemonLocalRpcWire,
  SparkDaemonLocalRpcError,
  SparkDaemonLocalRpcRemoteError,
  SparkDaemonLocalRpcUnavailableError,
} from "@zendev-lab/spark-system/daemon-local-rpc";
import {
  createSparkDaemonOrpcClient,
  invokeSparkDaemonOrpcLiveMethod,
  isSparkDaemonOrpcLiveMethod,
} from "@zendev-lab/spark-system/daemon-local-rpc-orpc";
import { SparkSessionStore, type SparkSessionInfo } from "@zendev-lab/spark-host/session-store";

import {
  exportSparkSessionRecord,
  formatSessionReplay,
  readSparkSessionExportFormat,
  type SparkSessionExportFormat,
} from "../host/session-navigation.ts";
import {
  SparkSessionMailStore,
  sessionMailStatus,
  type SparkSessionMailMessage,
} from "../host/session-mail-store.ts";
import {
  forkDaemonSession,
  listDaemonSessions,
  listLiveDaemonSessions,
  showDaemonSession,
  treeDaemonSession,
  type DaemonSessionForkResult,
  type DaemonSessionListResult,
  type DaemonSessionShowResult,
  type DaemonSessionTreeResult,
} from "./daemon-session.ts";
import {
  createDaemonManagedSessionsClient,
  renderManagedSession,
  type SparkDaemonManagedSessionsClient,
} from "./session-registry.ts";
import type { ChannelStatusSnapshot } from "./channel-status.ts";
import type { SparkNativeSlashCommandMap } from "../native-tui.ts";
import {
  consoleSparkCliOutput,
  parseSparkCliOptions,
  printSparkCliResult,
  readBooleanOption,
  readNumberOption,
  readStringOption,
  type SparkCliOutput,
} from "./shared.ts";

export type SparkDaemonCliAction =
  | "help"
  | "status"
  | "submit"
  | "invocation"
  | "start"
  | "sessions"
  | "channel"
  | "runs"
  | "events"
  | "service";
export type SparkDaemonRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "all";

const STRINGS = sparkDaemonCliStrings();
// Accepted invocations are durable and scheduler execution time pauses during
// human interaction. Keep reads unbounded by default; callers own cancellation
// through AbortSignal and may still provide an explicit timeout.
const DEFAULT_NATIVE_TURN_WAIT_TIMEOUT_MS = Number.POSITIVE_INFINITY;
const TURN_TRANSPORT_RETRY_BASE_MS = 100;
const TURN_TRANSPORT_RETRY_MAX_MS = 5_000;
const TURN_TRANSPORT_RECOVERY_INTERVAL = 4;
const HUMAN_INTERACTION_RESPONSE_MAX_ATTEMPTS = 4;
const HUMAN_INTERACTION_RESPONSE_RETRY_BASE_MS = 50;

export interface SparkDaemonClientPaths {
  runtimeDir: string;
  socketPath: string;
  pidFile: string;
  lockPath: string;
}

export interface SparkDaemonTurnTransportRetryEvent {
  operation: "submit" | "read";
  failureCount: number;
  error: string;
  nextRetryMs: number;
  recoveryAttempted: boolean;
  recoveryError?: string;
}

export interface SparkDaemonClientOptions {
  paths?: SparkDaemonClientPaths;
  startService?: (paths: SparkDaemonClientPaths) => unknown;
  daemonStatus?: (paths: SparkDaemonClientPaths) => Promise<SparkDaemonLocalStatus>;
  channelStatus?: (paths: SparkDaemonClientPaths) => Promise<ChannelStatusSnapshot>;
  channelReload?: (
    paths: SparkDaemonClientPaths,
    workspaceId: string,
  ) => Promise<ChannelStatusSnapshot>;
  turnSubmit?: (
    paths: SparkDaemonClientPaths,
    input: SparkDaemonTurnSubmitInput,
  ) => Promise<LocalTurnSubmitResult>;
  turnStatus?: (
    paths: SparkDaemonClientPaths,
    input: { invocationId: string },
  ) => Promise<LocalTurnStatusResult>;
  turnCancel?: (
    paths: SparkDaemonClientPaths,
    input: { invocationId: string; reason?: string },
  ) => Promise<LocalTurnCancelResult>;
  turnStream?: (
    paths: SparkDaemonClientPaths,
    input: { invocationId: string; after?: number; limit?: number },
  ) => Promise<LocalTurnStreamResult>;
  controlRequest?: (method: string, params: unknown) => Promise<unknown>;
  workspaceEnsureLocal?: (
    paths: SparkDaemonClientPaths,
    input: LocalWorkspaceEnsureLocalInput,
  ) => Promise<SparkDaemonWorkspace>;
  workspaceClientAttach?: (
    paths: SparkDaemonClientPaths,
    input: LocalWorkspaceClientAttachInput,
  ) => Promise<LocalWorkspaceClientResult>;
  workspaceClientHeartbeat?: (
    paths: SparkDaemonClientPaths,
    input: LocalWorkspaceClientHeartbeatInput,
  ) => Promise<LocalWorkspaceClientResult>;
  workspaceClientRelease?: (
    paths: SparkDaemonClientPaths,
    input: LocalWorkspaceClientReleaseInput,
  ) => Promise<LocalWorkspaceClientResult>;
  workspaceList?: (paths: SparkDaemonClientPaths) => Promise<LocalDaemonWorkspaceListResult>;
  sessionList?: (
    paths: SparkDaemonClientPaths,
    params?: { allWorkspaces?: boolean; history?: boolean },
  ) => Promise<LocalDaemonSessionListResult>;
  sessionExport?: (
    paths: SparkDaemonClientPaths,
    params: { sessionId: string; format: SparkSessionExportFormat; leafId?: string | null },
  ) => Promise<LocalDaemonSessionTextResult>;
  sessionReplay?: (
    paths: SparkDaemonClientPaths,
    params: { sessionId: string; leafId?: string | null },
  ) => Promise<LocalDaemonSessionTextResult>;
  runList?: (
    paths: SparkDaemonClientPaths,
    params?: { state?: SparkDaemonRunState; limit?: number },
  ) => Promise<LocalDaemonRunListResult>;
  runShow?: (
    paths: SparkDaemonClientPaths,
    params: { runId: string },
  ) => Promise<LocalDaemonRunShowResult>;
  eventsWatch?: (
    paths: SparkDaemonClientPaths,
    params?: { limit?: number },
  ) => Promise<LocalDaemonEventsWatchResult>;
  serviceCommand?: (argv: string[]) => Promise<number>;
  managedSessions?: SparkDaemonManagedSessionsClient;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Periodically re-run daemon service recovery after this many transport failures. */
  turnTransportRecoveryInterval?: number;
  /** Retry visibility hook; recurring failures otherwise fall back to stderr. */
  onTurnTransportRetry?: (event: SparkDaemonTurnTransportRetryEvent) => void;
  sparkHome?: string;
}

export interface SparkDaemonLocalStatus {
  observedAt: string;
  servers: Array<{
    url: string;
    workspaceCount: number;
    wsConnected: boolean;
    lastHeartbeatAt?: string;
    lastDisconnectReason?: string;
  }>;
  invocations: Record<"queued" | "running" | "succeeded" | "failed" | "cancelled", number>;
  invocationHealth?: { oldestQueuedAt?: string; oldestRunningAt?: string };
  channelDeliveries?: {
    pending: number;
    retrying: number;
    inFlight: number;
    delivered: number;
    uncertain: number;
    oldestPendingAt?: string;
    lastError?: string;
    lastErrorAt?: string;
  };
  lifecycle?: {
    state: "starting" | "running" | "draining" | "stopping";
    phase?:
      | "initializing"
      | "serving"
      | "draining-active-work"
      | "draining-channel-ingress"
      | "stopping";
    restartRequestedAt?: string;
    stopRequestedAt?: string;
    stopReason?: string;
    drain?: {
      observedAt: string;
      stage: "active-work" | "channel-ingress";
      scheduler: Array<{ invocationId: string }>;
      direct: Array<{ invocationId: string }>;
    };
  };
}

export interface SparkDaemonTurnSubmitInput {
  sessionId: string;
  prompt: string;
  idempotencyKey?: string;
  model?: string;
  reset?: boolean;
  assignment?: SparkAssignment;
  messageMetadata?: Record<string, unknown>;
}

export interface SparkDaemonTurnSubmitTask extends SparkDaemonTurnSubmitInput {
  type: "session.run";
  actor?: string;
  note?: string;
  input?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
}

export interface SparkDaemonClientStatus {
  running: boolean;
  [key: string]: unknown;
}

export type LocalTurnSubmitResult = SparkTurnSubmitResult;
export type LocalTurnStatusResult = SparkTurnStatusResult;
export type LocalTurnStreamResult = SparkTurnStreamPage;
export type LocalTurnCancelResult = SparkTurnCancelResult;
export type LocalTurnResult = SparkTurnResult;
export type LocalInvocationListResult = SparkInvocationListResult;
export type LocalInvocationRetryResult = SparkInvocationRetryResult;
export type LocalInvocationRetentionPreviewResult = SparkInvocationRetentionPreviewResult;

export interface LocalDaemonSessionListResult {
  sessions: SparkSessionInfo[];
  text: string;
  observedAt: string;
  allWorkspaces?: boolean;
  history?: boolean;
}

export interface LocalDaemonWorkspaceListResult {
  workspaces: SparkDaemonWorkspace[];
  observedAt: string;
}

export interface LocalDaemonSessionTextResult {
  sessionId: string;
  text: string;
  observedAt: string;
}

export interface LocalDaemonRunSummary {
  runKey: string;
  id: string;
  state: SparkDaemonRunState;
  sessionKey?: string;
  prompt?: string;
  enqueuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface LocalDaemonRunListResult {
  plane: "daemon";
  resource: "run";
  runs: LocalDaemonRunSummary[];
  text: string;
  observedAt: string;
}

export interface LocalDaemonRunShowResult {
  plane: "daemon";
  resource: "run";
  runKey: string;
  run?: LocalDaemonRunSummary;
  text: string;
  observedAt: string;
}

export interface LocalDaemonEventsWatchResult {
  plane: "daemon";
  resource: "events";
  events: SparkDaemonEvent[];
  text: string;
  observedAt: string;
}

export interface SparkDaemonWorkspace {
  id: string;
  serverWorkspaceId?: string;
  serverUrl: string;
  localWorkspaceKey: string;
  displayName: string;
  localPath: string;
  status: string;
  workspaceClients?: SparkWorkspaceClientProjection[];
  updatedAt?: string;
}

export interface SparkWorkspaceClientProjection {
  clientId: string;
  kind: SparkWorkspaceClientKind;
  status: "connected" | "disconnected";
  displayName?: string;
  attachedAt?: string;
  lastSeenAt?: string;
}

export type SparkWorkspaceClientKind = "interactive" | "headless" | "executor";

export interface LocalWorkspaceEnsureLocalInput {
  localPath: string;
  displayName?: string;
  localWorkspaceKey?: string;
}

export interface LocalWorkspaceClientAttachInput {
  workspaceId: string;
  clientId?: string;
  kind: SparkWorkspaceClientKind;
  displayName?: string;
  leaseTtlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface LocalWorkspaceClientHeartbeatInput {
  clientId: string;
  leaseTtlMs?: number;
}

export interface LocalWorkspaceClientReleaseInput {
  clientId: string;
}

export interface SparkWorkspaceClientLease {
  id: string;
  workspaceId: string;
  kind: SparkWorkspaceClientKind;
  status: "connected" | "disconnected";
  attachedAt: string;
  lastSeenAt: string;
}

export interface LocalWorkspaceClientResult {
  client: SparkWorkspaceClientLease;
  workspace: SparkDaemonWorkspace;
  observedAt: string;
}

export interface SparkWorkspaceClientHandle {
  client: SparkWorkspaceClientLease;
  workspace: SparkDaemonWorkspace;
  heartbeat(): Promise<LocalWorkspaceClientResult>;
  release(): Promise<LocalWorkspaceClientResult | null>;
}

export interface AttachSparkWorkspaceClientOptions {
  kind: SparkWorkspaceClientKind;
  clientId?: string;
  displayName?: string;
  localPath?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number | false;
  metadata?: Record<string, unknown>;
  /** Called when a lease-transfer consent request appears for this workspace. */
  onLeaseTransferPrompt?: (transfer: {
    transferId: string;
    workspaceDisplayName: string;
    targetServerUrl: string;
    previousServerUrl: string;
    expiresAt: string;
  }) => void | Promise<"accept" | "reject" | void>;
}

export interface SparkDaemonCliCommandBase {
  action: SparkDaemonCliAction;
  json?: boolean;
}

export interface SparkDaemonHelpCommand extends SparkDaemonCliCommandBase {
  action: "help";
}

export interface SparkDaemonStatusCommand extends SparkDaemonCliCommandBase {
  action: "status";
}

export interface SparkDaemonSubmitCommand extends SparkDaemonCliCommandBase {
  action: "submit";
  sessionId: string;
  prompt: string;
  idempotencyKey?: string;
  reset?: boolean;
  assignment?: SparkAssignment;
}

export interface SparkDaemonInvocationCommand extends SparkDaemonCliCommandBase {
  action: "invocation";
  subcommand: "list" | "status" | "result" | "stream" | "cancel" | "retry" | "retention";
  invocationId?: string;
  status?: SparkInvocationStatus;
  sessionId?: string;
  since?: string;
  before?: string;
  offset?: number;
  after?: number;
  limit?: number;
  reason?: string;
}

export interface SparkDaemonSessionsCommand extends SparkDaemonCliCommandBase {
  action: "sessions";
  subcommand:
    | "list"
    | "show"
    | "tree"
    | "fork"
    | "clone"
    | "export"
    | "replay"
    | "inbox"
    | "create"
    | "bind"
    | "unbind"
    | "archive";
  sessionId?: string;
  format?: SparkSessionExportFormat;
  leafId?: string | null;
  allWorkspaces?: boolean;
  history?: boolean;
  registry?: boolean;
  includeArchived?: boolean;
  newSessionId?: string;
  inboxAction?: "list" | "read" | "ack";
  messageId?: string;
  all?: boolean;
  workspaceId?: string;
  title?: string;
  role?: string;
  externalKey?: string;
}

export interface SparkDaemonChannelCommand extends SparkDaemonCliCommandBase {
  action: "channel";
  subcommand: "list" | "status" | "reload" | "notify";
  workspaceId: string;
  notifyAction?: "test" | "send";
  route?: string;
  adapter?: string;
  recipient?: string;
  text?: string;
  imageUrl?: string;
  imageType?: string;
}

export interface SparkDaemonRunsCommand extends SparkDaemonCliCommandBase {
  action: "runs";
  subcommand: "list" | "show" | "cancel";
  runId?: string;
  state?: SparkDaemonRunState;
  limit?: number;
}

export interface SparkDaemonEventsCommand extends SparkDaemonCliCommandBase {
  action: "events";
  subcommand: "watch";
  limit?: number;
}

export interface SparkDaemonStartCommand extends SparkDaemonCliCommandBase {
  action: "start";
}

export interface SparkDaemonServiceCommand extends SparkDaemonCliCommandBase {
  action: "service";
  argv: string[];
}

export type SparkDaemonCliCommand =
  | SparkDaemonHelpCommand
  | SparkDaemonStatusCommand
  | SparkDaemonSubmitCommand
  | SparkDaemonInvocationCommand
  | SparkDaemonSessionsCommand
  | SparkDaemonChannelCommand
  | SparkDaemonRunsCommand
  | SparkDaemonEventsCommand
  | SparkDaemonStartCommand
  | SparkDaemonServiceCommand;

export type SparkDaemonCliResult =
  | { action: "help"; text: string }
  | SparkDaemonStatusResult
  | SparkDaemonSubmitResult
  | SparkDaemonInvocationResult
  | SparkDaemonSessionsResult
  | SparkDaemonChannelResult
  | SparkDaemonRunsResult
  | SparkDaemonEventsResult
  | SparkDaemonStartResult;

export interface SparkDaemonStatusResult {
  action: "status";
  daemon: SparkDaemonClientStatus;
}

export interface SparkDaemonSubmitResult {
  action: "submit";
  result: LocalTurnSubmitResult;
}

export interface SparkDaemonInvocationResult {
  action: "invocation";
  result:
    | LocalInvocationListResult
    | LocalTurnStatusResult
    | LocalTurnResult
    | LocalTurnStreamResult
    | LocalTurnCancelResult
    | LocalInvocationRetryResult
    | LocalInvocationRetentionPreviewResult;
}

export interface SparkDaemonSessionsResult {
  action: "sessions";
  result:
    | LocalDaemonSessionListResult
    | LocalDaemonSessionTextResult
    | LocalDaemonSessionInboxListResult
    | LocalDaemonSessionMailMessageResult
    | DaemonSessionListResult
    | DaemonSessionShowResult
    | DaemonSessionTreeResult
    | DaemonSessionForkResult
    | ManagedSessionRegistryResult;
}

export interface ManagedSessionRegistryResult {
  plane: "daemon";
  resource: "session";
  subcommand: "create" | "bind" | "unbind" | "archive" | "list";
  sessions?: Array<Record<string, unknown>>;
  session?: Record<string, unknown>;
  text: string;
  observedAt: string;
}

export interface SparkDaemonChannelResult {
  action: "channel";
  result: ChannelStatusSnapshot | ChannelNotifySendResult;
}

export interface LocalDaemonSessionInboxListResult {
  subcommand: "inbox";
  sessionId: string;
  messages: Array<
    SparkSessionMailMessage & { status: "pending" | "read" | "acked"; preview: string }
  >;
  text: string;
  observedAt: string;
}

export interface LocalDaemonSessionMailMessageResult {
  subcommand: "inbox";
  inboxAction: "read" | "ack";
  sessionId: string;
  message: SparkSessionMailMessage & { status: "pending" | "read" | "acked" };
  text: string;
  observedAt: string;
}

export interface SparkDaemonRunsResult {
  action: "runs";
  result: LocalDaemonRunListResult | LocalDaemonRunShowResult | LocalTurnCancelResult;
}

export interface SparkDaemonEventsResult {
  action: "events";
  result: LocalDaemonEventsWatchResult;
}

export interface SparkDaemonStartResult {
  action: "start";
  daemon: SparkDaemonClientStatus;
}

export function parseSparkDaemonCliArgs(argv: string[]): SparkDaemonCliCommand {
  if (argv.length === 0) {
    return { action: "service", argv: [] };
  }

  const [action, ...rest] = argv;
  if (action === "help" || action === "--help" || action === "-h") {
    return { action: "help" };
  }

  const parsed = parseSparkCliOptions(rest);
  const json = readBooleanOption(parsed.options, "json");

  switch (action) {
    case "status":
      return { action: "status", json };
    case "submit": {
      const sessionId = readStringOption(parsed.options, "session")?.trim();
      const prompt = readPrompt(parsed);
      const idempotencyKey = readStringOption(parsed.options, "idempotency-key")?.trim();
      if (!sessionId) throw new Error(STRINGS.submitRequiresSession);
      if (!prompt) throw new Error(STRINGS.submitRequiresPrompt);
      return {
        action: "submit",
        json,
        sessionId,
        prompt,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        reset: readBooleanOption(parsed.options, "reset"),
      };
    }
    case "invocation": {
      const [subcommand = "list", positionalInvocationId] = parsed.positionals;
      if (subcommand === "list") {
        return {
          action: "invocation",
          subcommand,
          json,
          status: readInvocationStatus(readStringOption(parsed.options, "status")),
          sessionId: readStringOption(parsed.options, "session")?.trim(),
          since: readInvocationSinceOption(parsed.options),
          limit: readNumberOption(parsed.options, "limit"),
          offset: readNumberOption(parsed.options, "offset"),
        };
      }
      if (subcommand === "retention") {
        const before = readIsoDateTimeOption(parsed.options, "before");
        if (!before) throw new Error("spark daemon invocation retention requires --before <iso>");
        return {
          action: "invocation",
          subcommand,
          before,
          limit: readNumberOption(parsed.options, "limit"),
          json,
        };
      }
      if (
        subcommand !== "status" &&
        subcommand !== "result" &&
        subcommand !== "stream" &&
        subcommand !== "cancel" &&
        subcommand !== "retry"
      ) {
        throw new Error(`unknown spark daemon invocation command: ${subcommand}`);
      }
      const invocationId =
        readStringOption(parsed.options, "invocation")?.trim() || positionalInvocationId?.trim();
      if (!invocationId) {
        throw new Error(`spark daemon invocation ${subcommand} requires <invocation-id>`);
      }
      return {
        action: "invocation",
        subcommand,
        invocationId,
        json,
        ...(subcommand === "stream"
          ? {
              after: readNumberOption(parsed.options, "after"),
              limit: readNumberOption(parsed.options, "limit"),
            }
          : {}),
        ...(subcommand === "cancel"
          ? { reason: readStringOption(parsed.options, "reason")?.trim() }
          : {}),
      };
    }
    case "queue":
      throw new Error(STRINGS.unknownCommand("queue"));
    case "session":
    case "sessions":
      return parseSparkDaemonSessionsCommand(parsed, json);
    case "channel":
    case "channels": {
      const [subcommand = "status"] = parsed.positionals;
      if (subcommand === "list" || subcommand === "status" || subcommand === "reload") {
        const workspaceId = readStringOption(parsed.options, "workspace");
        if (!workspaceId?.trim()) {
          throw new Error(`spark daemon channel ${subcommand} requires --workspace <workspaceId>`);
        }
        return { action: "channel", subcommand, json, workspaceId: workspaceId.trim() };
      }
      if (subcommand === "notify") {
        const notifyActionRaw = readStringOption(parsed.options, "action") ?? "test";
        if (notifyActionRaw !== "test" && notifyActionRaw !== "send") {
          throw new Error("spark daemon channel notify --action must be test or send");
        }
        const workspaceId = readStringOption(parsed.options, "workspace");
        if (!workspaceId?.trim()) {
          throw new Error("spark daemon channel notify requires --workspace <workspaceId>");
        }
        return {
          action: "channel",
          subcommand: "notify",
          json,
          workspaceId: workspaceId.trim(),
          notifyAction: notifyActionRaw,
          ...(readStringOption(parsed.options, "route")
            ? { route: readStringOption(parsed.options, "route") }
            : {}),
          ...(readStringOption(parsed.options, "adapter")
            ? { adapter: readStringOption(parsed.options, "adapter") }
            : {}),
          ...(readStringOption(parsed.options, "recipient")
            ? { recipient: readStringOption(parsed.options, "recipient") }
            : {}),
          ...(readStringOption(parsed.options, "text")
            ? { text: readStringOption(parsed.options, "text") }
            : {}),
          ...(readStringOption(parsed.options, "image-url")
            ? { imageUrl: readStringOption(parsed.options, "image-url") }
            : {}),
          ...(readStringOption(parsed.options, "image-type")
            ? { imageType: readStringOption(parsed.options, "image-type") }
            : {}),
        };
      }
      throw new Error(`unknown spark daemon channel command: ${subcommand}`);
    }
    case "run":
    case "runs":
      return parseSparkDaemonRunsCommand(parsed, json);
    case "events":
      return parseSparkDaemonEventsCommand(parsed, json);
    case "start":
      return { action: "start", json };
    case "stop":
    case "install":
    case "doctor":
    case "login":
    case "workspace":
    case "ws":
    case "uplink":
      return { action: "service", argv };
    case "restart":
    case "logs":
      return { action: "service", argv: ["daemon", ...argv] };
    default:
      throw new Error(STRINGS.unknownCommand(String(action)));
  }
}

function readInvocationStatus(value: string | undefined): SparkInvocationStatus | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (
    normalized === "queued" ||
    normalized === "running" ||
    normalized === "succeeded" ||
    normalized === "failed" ||
    normalized === "cancelled"
  ) {
    return normalized;
  }
  throw new Error(
    "spark daemon invocation --status must be queued, running, succeeded, failed, or cancelled",
  );
}

function readInvocationSinceOption(
  options: ReturnType<typeof parseSparkCliOptions>["options"],
): string | undefined {
  const value = readStringOption(options, "since")?.trim();
  if (!value) return undefined;
  const relative = value.match(/^(\d+)(s|m|h|d)$/iu);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      relative[2]!.toLowerCase() as "s" | "m" | "h" | "d"
    ];
    const durationMs = amount * unitMs;
    if (amount < 1 || !Number.isSafeInteger(durationMs) || durationMs > 365 * 86_400_000) {
      throw new Error("spark daemon invocation --since duration must be between 1s and 365d");
    }
    return new Date(Date.now() - durationMs).toISOString();
  }
  return readIsoDateTimeOption(options, "since");
}

function readIsoDateTimeOption(
  options: ReturnType<typeof parseSparkCliOptions>["options"],
  name: string,
): string | undefined {
  const value = readStringOption(options, name)?.trim();
  if (!value) return undefined;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`spark daemon invocation --${name} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
}

function parseSparkDaemonSessionsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonSessionsCommand {
  const [subcommand = "list", maybeLeaf] = parsed.positionals;
  if (subcommand === "list") {
    const allWorkspaces = readBooleanOption(parsed.options, "all-workspaces");
    return {
      action: "sessions",
      subcommand,
      json,
      allWorkspaces,
      history: readBooleanOption(parsed.options, "history") || allWorkspaces,
      registry: readBooleanOption(parsed.options, "registry"),
      includeArchived: readBooleanOption(parsed.options, "include-archived"),
      workspaceId: readStringOption(parsed.options, "workspace")?.trim(),
    };
  }
  if (subcommand === "create") {
    const workspaceId = readStringOption(parsed.options, "workspace")?.trim() || maybeLeaf?.trim();
    if (!workspaceId) throw new Error("spark daemon session create requires --workspace <id>");
    return {
      action: "sessions",
      subcommand,
      json,
      workspaceId,
      title: readStringOption(parsed.options, "title")?.trim(),
      role: readStringOption(parsed.options, "role")?.trim(),
      sessionId: readStringOption(parsed.options, "id")?.trim(),
    };
  }
  if (subcommand === "bind" || subcommand === "unbind") {
    const sessionId = readStringOption(parsed.options, "session")?.trim() || maybeLeaf?.trim();
    const externalKey = readStringOption(parsed.options, "external-key")?.trim();
    if (!sessionId) throw new Error(`spark daemon session ${subcommand} requires <session-id>`);
    if (!externalKey)
      throw new Error(`spark daemon session ${subcommand} requires --external-key <key>`);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      externalKey,
    };
  }
  if (subcommand === "archive") {
    const sessionId = readStringOption(parsed.options, "session")?.trim() || maybeLeaf?.trim();
    if (!sessionId) throw new Error("spark daemon session archive requires <session-id>");
    return { action: "sessions", subcommand, json, sessionId };
  }
  if (subcommand === "inbox") {
    const [inboxActionOrMessageId, maybeMessageId] = parsed.positionals.slice(1);
    const inboxAction =
      inboxActionOrMessageId === "read" || inboxActionOrMessageId === "ack"
        ? inboxActionOrMessageId
        : "list";
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error("spark daemon session inbox requires --session <session-id>");
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      inboxAction,
      all: readBooleanOption(parsed.options, "all"),
      ...(inboxAction === "list"
        ? {}
        : {
            messageId:
              maybeMessageId?.trim() || readStringOption(parsed.options, "message")?.trim(),
          }),
    };
  }
  if (
    subcommand === "show" ||
    subcommand === "tree" ||
    subcommand === "fork" ||
    subcommand === "clone"
  ) {
    const sessionId = readStringOption(parsed.options, "session")?.trim() || maybeLeaf?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsReplayRequiresSession);
    const newSessionId = readStringOption(parsed.options, "id")?.trim();
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      ...(newSessionId ? { newSessionId } : {}),
    };
  }
  if (subcommand === "export") {
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsExportRequiresSession);
    const format = readSparkSessionExportFormat(
      readStringOption(parsed.options, "format") ?? "jsonl",
    );
    const leafId = readDaemonLeafArg(readStringOption(parsed.options, "leaf") ?? maybeLeaf);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      format,
      ...(leafId !== undefined ? { leafId } : {}),
    };
  }
  if (subcommand === "replay") {
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsReplayRequiresSession);
    const leafId = readDaemonLeafArg(readStringOption(parsed.options, "leaf") ?? maybeLeaf);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      ...(leafId !== undefined ? { leafId } : {}),
    };
  }
  throw new Error(STRINGS.unknownSessionsCommand(subcommand));
}

function parseSparkDaemonRunsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonRunsCommand {
  const [subcommand = "list", maybeRunId] = parsed.positionals;
  if (subcommand === "list") {
    const state = readRunState(readStringOption(parsed.options, "state") ?? "all");
    const limit = readNumberOption(parsed.options, "limit");
    return { action: "runs", subcommand, json, state, limit };
  }
  if (subcommand === "show" || subcommand === "cancel") {
    const runId = readStringOption(parsed.options, "run")?.trim() || maybeRunId?.trim();
    if (!runId) throw new Error(`${subcommand} requires --run <id> or a run id argument`);
    return { action: "runs", subcommand, json, runId };
  }
  throw new Error(`unknown daemon run command: ${subcommand}`);
}

function parseSparkDaemonEventsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonEventsCommand {
  const [subcommand = "watch"] = parsed.positionals;
  if (subcommand !== "watch") throw new Error(`unknown daemon events command: ${subcommand}`);
  return { action: "events", subcommand, json, limit: readNumberOption(parsed.options, "limit") };
}

export async function handleSparkDaemonCliCommand(
  command: SparkDaemonCliCommand,
  client: SparkDaemonClientOptions = {},
): Promise<SparkDaemonCliResult> {
  switch (command.action) {
    case "help":
      return { action: "help", text: sparkDaemonHelpText() };
    case "status":
      return { action: "status", daemon: await clientStatus(client) };
    case "submit":
      return {
        action: "submit",
        result: await clientSubmit(
          {
            sessionId: command.sessionId,
            prompt: command.prompt,
            idempotencyKey: command.idempotencyKey,
            reset: command.reset,
            ...(command.assignment ? { assignment: command.assignment } : {}),
          },
          client,
        ),
      };
    case "invocation":
      return { action: "invocation", result: await clientInvocation(command, client) };
    case "sessions":
      return { action: "sessions", result: await clientSessions(command, client) };
    case "channel":
      if (command.subcommand === "notify") {
        return {
          action: "channel",
          result: await clientChannelNotify(command, client),
        };
      }
      if (command.subcommand === "reload") {
        return { action: "channel", result: await clientChannelReload(command, client) };
      }
      return { action: "channel", result: await clientChannelStatus(command, client) };
    case "runs":
      return { action: "runs", result: await clientRuns(command, client) };
    case "events":
      return { action: "events", result: await clientEvents(command, client) };
    case "start":
      await clientEnsureRunning(client);
      return { action: "start", daemon: await clientStatus(client) };
    case "service":
      throw new Error(STRINGS.serviceCommandMustUseServiceRunner);
  }
}

export async function runSparkDaemonCliCommand(
  command: SparkDaemonCliCommand,
  output: SparkCliOutput = consoleSparkCliOutput,
  client: SparkDaemonClientOptions = {},
): Promise<number> {
  if (command.action === "service") {
    return await runSparkDaemonServiceCommand(command.argv, client);
  }

  const result = await handleSparkDaemonCliCommand(command, client);
  if (result.action === "help") {
    output.write(result.text);
    return 0;
  }
  if (result.action === "events" && command.json) {
    for (const event of result.result.events) output.write(`${JSON.stringify(event)}\n`);
    return 0;
  }
  if (
    (result.action === "sessions" || result.action === "events" || result.action === "channel") &&
    !command.json
  ) {
    output.write(result.result.text);
    return 0;
  }
  if (result.action === "runs" && !command.json && "text" in result.result) {
    output.write(result.result.text);
    return 0;
  }
  if (result.action === "invocation" && !command.json) {
    output.write(renderInvocationResult(result.result));
    return 0;
  }
  printSparkCliResult(output, result, { json: command.json });
  return 0;
}

function renderInvocationResult(result: SparkDaemonInvocationResult["result"]): string {
  if ("invocations" in result) {
    if (result.invocations.length === 0) return "No matching invocations.\n";
    return `${result.invocations
      .map(
        (invocation) =>
          `${invocation.invocationId} ${invocation.status} session=${invocation.sessionId ?? "-"} attempts=${invocation.attemptCount}${invocation.errorCode ? ` error=${invocation.errorCode}` : ""}`,
      )
      .join("\n")}\n`;
  }
  if ("retryOfInvocationId" in result) {
    return `${result.invocationId} queued retry-of=${result.retryOfInvocationId}\n`;
  }
  if ("dryRun" in result) {
    return `retention dry-run before=${result.before} invocations=${result.invocationIds.length} events=${result.eventCount} blocked=${result.blockedByDeliveryCount}\n`;
  }
  if ("assistantText" in result && result.assistantText) return `${result.assistantText}\n`;
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function sparkDaemonHelpText(): string {
  return STRINGS.helpText;
}

export interface SparkDaemonNativeResponderOptions {
  sessionId?: string;
  workspaceId?: string;
  cwd?: string;
  ensureSession?: () => Promise<void>;
  waitForCompletion?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onViewEvent?: (event: SparkViewModelEvent) => void;
  onInteractionRequest?: (
    request: SparkInteractionRequest,
    event: Extract<SparkDaemonEvent, { type: "daemon.interaction.request" }>,
    context: { signal?: AbortSignal },
  ) => void | Promise<void>;
}

interface SparkDaemonNativeResponderContext {
  submissionId?: string;
  signal?: AbortSignal;
  appendAssistantChunk?: (chunk: string) => void;
  finishAssistantMessage?: () => void;
}

export function createSparkDaemonNativeResponder(
  client: SparkDaemonClientOptions = {},
  options: SparkDaemonNativeResponderOptions = {},
): (input: string, context?: SparkDaemonNativeResponderContext) => Promise<string> {
  const sessionId = options.sessionId ?? `spark-cli-${Date.now().toString(36)}`;
  let sessionReady: Promise<void> | undefined;
  return async (input: string, context?: SparkDaemonNativeResponderContext) => {
    const prompt = input.trim();
    if (!prompt) return STRINGS.ignoredEmptyPrompt;
    if (options.ensureSession || options.workspaceId) {
      sessionReady ??= (
        options.ensureSession
          ? options.ensureSession()
          : ensureSparkDaemonWorkspaceSession(
              {
                sessionId,
                workspaceId: options.workspaceId!,
                cwd: options.cwd ?? process.cwd(),
              },
              client,
            )
      ).catch((error) => {
        sessionReady = undefined;
        throw error;
      });
      await sessionReady;
    }
    const live = createDaemonLiveAssistantRenderer(
      context,
      options.onViewEvent,
      options.onInteractionRequest,
    );
    const result = await clientSubmitStreaming(
      {
        sessionId,
        prompt,
        idempotencyKey: context?.submissionId,
        messageMetadata: {
          origin: { kind: "user", host: "tui", surface: "local" },
        },
      },
      client,
      {
        signal: context?.signal,
        timeoutMs: options.timeoutMs,
        onEvent: live.onEvent,
      },
    );
    if (options.waitForCompletion === false) {
      return STRINGS.queuedSession(sessionId, result.invocationId);
    }
    const finalText = await waitForSubmittedTurn(sessionId, result, client, {
      signal: context?.signal,
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs,
    });
    if (live.streamed) {
      context?.finishAssistantMessage?.();
      return "";
    }
    return finalText;
  };
}

function createDaemonLiveAssistantRenderer(
  context: SparkDaemonNativeResponderContext | undefined,
  onViewEvent: ((event: SparkViewModelEvent) => void) | undefined,
  onInteractionRequest:
    | ((
        request: SparkInteractionRequest,
        event: Extract<SparkDaemonEvent, { type: "daemon.interaction.request" }>,
        context: { signal?: AbortSignal },
      ) => void | Promise<void>)
    | undefined,
): {
  streamed: boolean;
  onEvent?: (event: SparkDaemonEvent) => void | Promise<void>;
} {
  if (!context?.appendAssistantChunk && !onViewEvent && !onInteractionRequest) {
    return { streamed: false };
  }
  let streamed = false;
  let lastText = "";
  return {
    get streamed() {
      return streamed;
    },
    async onEvent(event) {
      if (event.type === "daemon.view_event") onViewEvent?.(event.view);
      if (event.type === "daemon.interaction.request") {
        await onInteractionRequest?.(event.request, event, {
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      }
      const text = assistantTextFromDaemonViewEvent(event);
      if (text === undefined) return;
      const chunk = text.startsWith(lastText) ? text.slice(lastText.length) : text;
      lastText = text;
      if (!chunk) return;
      streamed = true;
      context?.appendAssistantChunk?.(chunk);
    },
  };
}

function assistantTextFromDaemonViewEvent(event: SparkDaemonEvent): string | undefined {
  if (event.type !== "daemon.view_event") return undefined;
  const view = event.view;
  if (!isRecord(view) || view.type !== "session.message" || !isRecord(view.message)) {
    return undefined;
  }
  const message = view.message;
  if (message.role !== "assistant" || message.status !== "streaming") return undefined;
  return typeof message.text === "string" ? message.text : undefined;
}

interface SubmittedTurnWaitOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

async function waitForSubmittedTurn(
  sessionId: string,
  submitted: LocalTurnSubmitResult,
  client: SparkDaemonClientOptions,
  options: SubmittedTurnWaitOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NATIVE_TURN_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const now = client.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const deadlineError = new TurnReadDeadlineError();
  while (now() < deadline) {
    throwIfAborted(options.signal);
    let status: LocalTurnStatusResult;
    try {
      status = await retryTurnTransportRead(
        () =>
          clientTurnStatus({ invocationId: submitted.invocationId }, client, {
            signal: options.signal,
            ensureRunning: false,
            timeoutMs: Math.max(1, deadline - now()),
          }),
        client,
        {
          signal: options.signal,
          deadline,
          deadlineError,
        },
      );
    } catch (error) {
      if (error === deadlineError) break;
      throw error;
    }
    if (status.status === "failed") {
      throw new Error(status.error?.message ?? `Invocation ${submitted.invocationId} failed`);
    }
    if (status.status === "cancelled") {
      throw new Error(status.cancelReason ?? `Invocation ${submitted.invocationId} was cancelled`);
    }
    if (status.status === "succeeded") {
      return STRINGS.completedSession(sessionId, submitted.invocationId);
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await delay(Math.min(pollIntervalMs, remainingMs), undefined, { signal: options.signal });
  }
  return STRINGS.queuedSession(sessionId, submitted.invocationId);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSparkDaemonNativeCommands(
  client: SparkDaemonClientOptions = {},
): SparkNativeSlashCommandMap {
  return {
    status: {
      description: STRINGS.nativeCommandDescriptions.status,
      metadata: {
        source: "extension",
        extensionId: "spark-daemon-native",
        plane: "daemon",
        resource: "status",
        verbs: ["show"],
        canonicalCliTarget: "spark daemon status",
      },
      handler: async () => formatNativeDaemonStatus(await clientStatus(client)),
    },
    start: {
      description: STRINGS.nativeCommandDescriptions.start,
      metadata: {
        source: "extension",
        extensionId: "spark-daemon-native",
        plane: "daemon",
        resource: "process",
        verbs: ["start"],
        canonicalCliTarget: "spark daemon start",
      },
      handler: async () => {
        await clientEnsureRunning(client);
        return formatNativeDaemonStatus(await clientStatus(client));
      },
    },
  };
}

export async function attachSparkWorkspaceClient(
  client: SparkDaemonClientOptions = {},
  options: AttachSparkWorkspaceClientOptions,
): Promise<SparkWorkspaceClientHandle> {
  await clientEnsureRunning(client);
  const workspace = await clientEnsureLocalWorkspace(
    { localPath: options.localPath ?? process.cwd() },
    client,
  );
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;
  const metadata =
    options.kind === "interactive"
      ? { surface: "tui", ...(options.metadata ?? {}) }
      : options.metadata;
  const attached = await clientWorkspaceClientAttach(
    {
      workspaceId: workspace.id,
      ...(options.clientId ? { clientId: options.clientId } : {}),
      kind: options.kind,
      displayName: options.displayName ?? defaultWorkspaceClientDisplayName(options.kind),
      leaseTtlMs,
      ...(metadata ? { metadata } : {}),
    },
    client,
  );
  let released = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let transferPollTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeat = async () =>
    await clientWorkspaceClientHeartbeat({ clientId: attached.client.id, leaseTtlMs }, client);
  const release = async () => {
    if (released) return null;
    released = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (transferPollTimer) clearInterval(transferPollTimer);
    return await clientWorkspaceClientRelease({ clientId: attached.client.id }, client);
  };

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  if (heartbeatIntervalMs !== false && heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      void heartbeat().catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  const promptedTransfers = new Set<string>();
  if (options.kind === "interactive" && options.onLeaseTransferPrompt) {
    const paths = resolveSparkDaemonClientPaths(client);
    const pollTransfer = async () => {
      try {
        const result = await localRpcRequest<{
          pending: Array<Record<string, unknown>>;
          observedAt: string;
        }>(paths, localRpcWireRequest("workspace.transfer.pending", { workspaceId: workspace.id }));
        for (const item of result.pending ?? []) {
          const transferId = typeof item.transferId === "string" ? item.transferId : null;
          if (!transferId || promptedTransfers.has(transferId)) continue;
          promptedTransfers.add(transferId);
          const decision = await options.onLeaseTransferPrompt?.({
            transferId,
            workspaceDisplayName:
              typeof item.workspaceDisplayName === "string"
                ? item.workspaceDisplayName
                : workspace.displayName,
            targetServerUrl: typeof item.targetServerUrl === "string" ? item.targetServerUrl : "",
            previousServerUrl:
              typeof item.previousServerUrl === "string" ? item.previousServerUrl : "",
            expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : "",
          });
          if (decision === "accept" || decision === "reject") {
            await localRpcRequest(
              paths,
              localRpcWireRequest("workspace.transfer.respond", {
                transferId,
                decision,
                source: "tui",
              }),
            );
          }
        }
      } catch {
        // Transfer polling is best-effort; lease TTL still protects occupancy.
      }
    };
    transferPollTimer = setInterval(() => {
      void pollTransfer();
    }, 2_000);
    transferPollTimer.unref?.();
    void pollTransfer();
  }

  return { client: attached.client, workspace: attached.workspace, heartbeat, release };
}

async function clientSessions(
  command: SparkDaemonSessionsCommand,
  client: SparkDaemonClientOptions,
): Promise<
  | LocalDaemonSessionListResult
  | LocalDaemonSessionTextResult
  | LocalDaemonSessionInboxListResult
  | LocalDaemonSessionMailMessageResult
  | DaemonSessionListResult
  | DaemonSessionShowResult
  | DaemonSessionTreeResult
  | DaemonSessionForkResult
  | ManagedSessionRegistryResult
> {
  const paths = resolveSparkDaemonClientPaths(client);
  const managedSessions = clientManagedSessions(client);
  if (command.subcommand === "create") {
    const session = await managedSessions.create({
      workspaceId: command.workspaceId!,
      title: command.title,
      role: command.role,
      sessionId: command.sessionId,
      cwd: process.cwd(),
    });
    return {
      plane: "daemon",
      resource: "session",
      subcommand: "create",
      session,
      text: renderManagedSession(session),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "bind") {
    const session = await managedSessions.bind(command.sessionId!, command.externalKey!);
    return {
      plane: "daemon",
      resource: "session",
      subcommand: "bind",
      session,
      text: renderManagedSession(session),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "unbind") {
    const session = await managedSessions.unbind(command.sessionId!, command.externalKey!);
    return {
      plane: "daemon",
      resource: "session",
      subcommand: "unbind",
      session,
      text: renderManagedSession(session),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "archive") {
    const session = await managedSessions.archive(command.sessionId!);
    return {
      plane: "daemon",
      resource: "session",
      subcommand: "archive",
      session,
      text: renderManagedSession(session),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "inbox") {
    const mailStore = createLocalSessionMailStore(client);
    const sessionId = command.sessionId!;
    if (command.inboxAction === "read" || command.inboxAction === "ack") {
      const messageId = command.messageId?.trim();
      if (!messageId)
        throw new Error(`spark daemon session inbox ${command.inboxAction} requires <message-id>`);
      const message =
        command.inboxAction === "read"
          ? await mailStore.read(sessionId, messageId)
          : await mailStore.ack(sessionId, messageId);
      const withStatus = { ...message, status: sessionMailStatus(message) };
      return {
        subcommand: "inbox",
        inboxAction: command.inboxAction,
        sessionId,
        message: withStatus,
        text: renderInboxMessage(command.inboxAction, withStatus),
        observedAt: observedAt(client),
      };
    }
    const messages = (await mailStore.list(sessionId, { includeAcked: command.all })).map(
      (message) => ({
        ...message,
        status: sessionMailStatus(message),
        preview: previewMailBody(message.body),
      }),
    );
    return {
      subcommand: "inbox",
      sessionId,
      messages,
      text: renderInboxList(sessionId, messages),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "list") {
    if (command.registry) {
      const sessions = await managedSessions.list({
        includeArchived: command.includeArchived,
        workspaceId: command.workspaceId,
      });
      return {
        plane: "daemon",
        resource: "session",
        subcommand: "list",
        sessions,
        text:
          sessions.length === 0
            ? "No managed Spark sessions in registry.\n"
            : sessions.map(renderManagedSession).join(""),
        observedAt: observedAt(client),
      };
    }
    if (command.history || command.allWorkspaces) {
      if (client.sessionList)
        return await client.sessionList(paths, {
          allWorkspaces: command.allWorkspaces,
          history: true,
        });
      return await listDaemonSessions(createLocalSessionStore(client), {
        allWorkspaces: command.allWorkspaces,
        history: true,
        observedAt: observedAt(client),
      });
    }
    const workspaces = await clientWorkspaceList(client);
    return listLiveDaemonSessions(workspaces.workspaces, { observedAt: workspaces.observedAt });
  }
  if (command.subcommand === "show") {
    return await showDaemonSession(createLocalSessionStore(client), command.sessionId!, {
      observedAt: observedAt(client),
    });
  }
  if (command.subcommand === "tree") {
    return await treeDaemonSession(createLocalSessionStore(client), command.sessionId!, {
      observedAt: observedAt(client),
    });
  }
  if (command.subcommand === "fork" || command.subcommand === "clone") {
    return await forkDaemonSession(createLocalSessionStore(client), command.sessionId!, {
      id: command.newSessionId,
      observedAt: observedAt(client),
    });
  }
  if (command.subcommand === "export") {
    const sessionId = command.sessionId!;
    const format = command.format ?? "jsonl";
    const leafId = command.leafId;
    const leafParams = leafId !== undefined ? { leafId } : {};
    if (client.sessionExport)
      return await client.sessionExport(paths, { sessionId, format, ...leafParams });
    const record = await createLocalSessionStore(client).loadByRef(sessionId);
    return {
      sessionId: record.header.id,
      text: exportSparkSessionRecord(record, { format, ...leafParams }),
      observedAt: observedAt(client),
    };
  }

  const sessionId = command.sessionId!;
  const leafId = command.leafId;
  const leafParams = leafId !== undefined ? { leafId } : {};
  if (client.sessionReplay) return await client.sessionReplay(paths, { sessionId, ...leafParams });
  const record = await createLocalSessionStore(client).loadByRef(sessionId);
  return {
    sessionId: record.header.id,
    text: formatSessionReplay(record, leafId),
    observedAt: observedAt(client),
  };
}

export async function clientGetManagedSession(
  sessionId: string,
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionRegistryRecord> {
  return await clientManagedSessions(client).get(sessionId);
}

export async function clientListManagedSessions(
  options: SparkSessionListRequest = {},
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionRegistryRecord[]> {
  return await clientManagedSessions(client).list(options);
}

export async function clientCreateManagedSession(
  input: SparkSessionCreateRequest,
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionRegistryRecord> {
  return await clientManagedSessions(client).create(input);
}

export async function clientGetManagedSessionSnapshot(
  sessionId: string,
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionView> {
  return parseSparkSessionView(
    await requestSparkDaemonControl("session.snapshot", { sessionId }, client),
  );
}

export async function ensureSparkDaemonWorkspaceSession(
  input: { sessionId: string; workspaceId: string; cwd: string },
  client: SparkDaemonClientOptions = {},
): Promise<void> {
  const managedSessions = clientManagedSessions(client);
  const sessions = await managedSessions.list({ includeArchived: true });
  const existing = sessions.find((session) => session.sessionId === input.sessionId);
  if (existing?.status === "archived") {
    throw new Error(`cannot submit to archived session: ${input.sessionId}`);
  }
  if (
    existing &&
    (existing.scope.kind === "daemon" || existing.scope.workspaceId !== input.workspaceId)
  ) {
    throw new Error(
      `session ${input.sessionId} belongs to ${
        existing?.scope.kind === "daemon"
          ? "the daemon scope"
          : `workspace ${existing?.scope.workspaceId}`
      }, not workspace ${input.workspaceId}`,
    );
  }
  if (existing) return;
  await managedSessions.create({
    sessionId: input.sessionId,
    scope: { kind: "workspace", workspaceId: input.workspaceId },
    workspaceId: input.workspaceId,
    cwd: input.cwd,
  });
}

function clientManagedSessions(client: SparkDaemonClientOptions): SparkDaemonManagedSessionsClient {
  if (client.managedSessions) return client.managedSessions;
  const paths = resolveSparkDaemonClientPaths(client);
  return createDaemonManagedSessionsClient({ paths: { runtimeDir: paths.runtimeDir } });
}

async function clientRuns(
  command: SparkDaemonRunsCommand,
  client: SparkDaemonClientOptions,
): Promise<LocalDaemonRunListResult | LocalDaemonRunShowResult | LocalTurnCancelResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (command.subcommand === "cancel") {
    return await clientCancelTurn(
      { invocationId: command.runId!, reason: "spark daemon run cancel" },
      client,
    );
  }
  if (command.subcommand === "show") {
    if (client.runShow) return await client.runShow(paths, { runId: command.runId! });
    const runs = await clientRuns(
      { action: "runs", subcommand: "list", json: true, state: "all", limit: 100 },
      client,
    );
    const runList = runs as LocalDaemonRunListResult;
    const run = runList.runs.find(
      (item) => item.id === command.runId || item.runKey === command.runId,
    );
    return {
      plane: "daemon",
      resource: "run",
      runKey: runKey(command.runId!),
      ...(run ? { run } : {}),
      text: run ? renderRunSummary(run) : `${runKey(command.runId!)} not found\n`,
      observedAt: observedAt(client),
    };
  }
  if (client.runList) {
    return await client.runList(paths, { state: command.state, limit: command.limit });
  }
  return {
    plane: "daemon",
    resource: "run",
    runs: [],
    text: "No Spark daemon run list provider is configured.\n",
    observedAt: observedAt(client),
  };
}

async function clientEvents(
  command: SparkDaemonEventsCommand,
  client: SparkDaemonClientOptions,
): Promise<LocalDaemonEventsWatchResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.eventsWatch) return await client.eventsWatch(paths, { limit: command.limit });
  return {
    plane: "daemon",
    resource: "events",
    events: [],
    text: "No Spark daemon events are available without a live daemon event stream.\n",
    observedAt: observedAt(client),
  };
}

function runKey(id: string): string {
  return id.startsWith("run:") ? id : `run:${id}`;
}

function renderRunSummary(run: LocalDaemonRunSummary): string {
  const session = run.sessionKey ? ` ${run.sessionKey}` : "";
  const prompt = run.prompt ? ` ${run.prompt}` : "";
  return `${run.runKey} ${run.state}${session}${prompt}\n`;
}

function createLocalSessionStore(client: SparkDaemonClientOptions): SparkSessionStore {
  return new SparkSessionStore({
    cwd: process.cwd(),
    ...(client.sparkHome ? { sparkHome: client.sparkHome } : {}),
  });
}

function createLocalSessionMailStore(client: SparkDaemonClientOptions): SparkSessionMailStore {
  return new SparkSessionMailStore({
    ...(client.sparkHome ? { sparkHome: client.sparkHome } : {}),
    now: client.now,
  });
}

function renderInboxList(
  sessionId: string,
  messages: Array<
    SparkSessionMailMessage & { status: "pending" | "read" | "acked"; preview: string }
  >,
): string {
  if (messages.length === 0) return `No pending Spark session mail for ${sessionId}.\n`;
  return (
    messages
      .map(
        (message) =>
          `${message.id} ${message.status} from=${message.fromSessionId} ${message.createdAt} ${message.preview}`,
      )
      .join("\n") + "\n"
  );
}

function renderInboxMessage(
  action: "read" | "ack",
  message: SparkSessionMailMessage & { status: "pending" | "read" | "acked" },
): string {
  return (
    [
      `${action === "ack" ? "acknowledged" : "read"} ${message.id}`,
      `to=${message.toSessionId}`,
      `from=${message.fromSessionId}`,
      `status=${message.status}`,
      `subject=${message.subject ?? ""}`,
      "",
      message.body,
    ].join("\n") + "\n"
  );
}

function previewMailBody(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
}

function observedAt(client: SparkDaemonClientOptions): string {
  return new Date(client.now?.() ?? Date.now()).toISOString();
}

type LocalRpcWireRequest = {
  id: string;
  method: string;
  params?: unknown;
  sparkCommand: SparkCommand;
};

function localRpcWireRequest(
  method: string,
  params?: unknown,
  id: string = localRequestId(),
): LocalRpcWireRequest {
  const kind = sparkCommandKindForLocalRpcMethod(method);
  if (!kind) throw new Error(`Unknown Spark daemon local RPC method: ${method}`);
  const payload = sparkProtocolJsonObjectSchema.safeParse(params ?? {});
  const commandPayload =
    method === "provider.auth.api-key.set" ||
    method === "provider.auth.login.respond" ||
    method === "human.interaction.respond"
      ? {}
      : payload.success
        ? payload.data
        : {};
  return {
    id,
    method,
    ...(params !== undefined ? { params } : {}),
    sparkCommand: {
      schemaVersion: "spark.command.v1",
      id,
      kind,
      route: localRpcCommandRoute(method, params),
      payload: commandPayload,
      transport: { kind: "local-rpc", method, requestId: id },
    },
  };
}

function localRpcCommandRoute(method: string, params: unknown): SparkCommand["route"] {
  if (!isRecord(params)) return {};
  if (method === "turn.submit" && typeof params.sessionId === "string") {
    return { sessionId: params.sessionId };
  }
  if (method === "turn.cancel" && typeof params.invocationId === "string") {
    return { invocationId: params.invocationId };
  }
  if (method === "human.interaction.respond") {
    return {
      ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
      ...(typeof params.invocationId === "string" ? { invocationId: params.invocationId } : {}),
    };
  }
  if (method === "workspace.ensure-local" && typeof params.localPath === "string") {
    return { workspaceLocalPath: params.localPath };
  }
  if (method === "workspace.client.attach" && typeof params.workspaceId === "string") {
    return { workspaceBindingId: params.workspaceId };
  }
  if (
    (method === "workspace.client.heartbeat" || method === "workspace.client.release") &&
    typeof params.clientId === "string"
  ) {
    return { clientId: params.clientId };
  }
  return {};
}

async function clientStatus(client: SparkDaemonClientOptions): Promise<SparkDaemonClientStatus> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.daemonStatus) {
    const status = await client.daemonStatus(paths);
    return { running: true, ...status, socketPath: paths.socketPath, pidFile: paths.pidFile };
  }
  const pid = readPidFile(paths.pidFile);
  const lock = readJsonFile(paths.lockPath);
  if (!pid || !isProcessAlive(pid)) {
    return { running: false, socketPath: paths.socketPath, pidFile: paths.pidFile, lock };
  }
  try {
    const status = await localRpcRequest<SparkDaemonLocalStatus>(
      paths,
      localRpcWireRequest("daemon.status"),
    );
    return {
      running: true,
      pid,
      socketPath: paths.socketPath,
      pidFile: paths.pidFile,
      lock,
      startedAt: fileMtime(paths.pidFile),
      ...status,
    };
  } catch (error) {
    return {
      running: false,
      unreachable: true,
      pid,
      socketPath: paths.socketPath,
      pidFile: paths.pidFile,
      lock,
      startedAt: fileMtime(paths.pidFile),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function clientChannelStatus(
  command: SparkDaemonChannelCommand,
  client: SparkDaemonClientOptions,
): Promise<ChannelStatusSnapshot> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.channelStatus) return await client.channelStatus(paths);
  return await localRpcRequest<ChannelStatusSnapshot>(
    paths,
    localRpcWireRequest("channel.status", { workspaceId: command.workspaceId }),
  );
}

async function clientChannelReload(
  command: SparkDaemonChannelCommand,
  client: SparkDaemonClientOptions,
): Promise<ChannelStatusSnapshot> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.channelReload) return await client.channelReload(paths, command.workspaceId);
  await clientEnsureRunning(client);
  return await localRpcRequest<ChannelStatusSnapshot>(
    paths,
    localRpcWireRequest("channel.reload", { workspaceId: command.workspaceId }),
  );
}

async function clientChannelNotify(
  command: SparkDaemonChannelCommand,
  client: SparkDaemonClientOptions,
): Promise<ChannelNotifySendResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  const params = {
    workspaceId: command.workspaceId,
    action: command.notifyAction ?? "test",
    ...(command.route ? { route: command.route } : {}),
    ...(command.adapter ? { adapter: command.adapter } : {}),
    ...(command.recipient ? { recipient: command.recipient } : {}),
    ...(command.text ? { text: command.text } : {}),
    ...(command.imageUrl
      ? {
          image: {
            url: command.imageUrl,
            ...(command.imageType ? { mediaType: command.imageType } : {}),
          },
        }
      : {}),
  };
  return await localRpcRequest<ChannelNotifySendResult>(
    paths,
    localRpcWireRequest("channel.notify", params),
  );
}

async function clientInvocation(
  command: SparkDaemonInvocationCommand,
  client: SparkDaemonClientOptions,
): Promise<SparkDaemonInvocationResult["result"]> {
  if (command.subcommand === "list") {
    return await requestSparkDaemonControl<LocalInvocationListResult>(
      "invocation.list",
      {
        ...(command.status ? { status: command.status } : {}),
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        ...(command.since ? { since: command.since } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.offset !== undefined ? { offset: command.offset } : {}),
      },
      client,
    );
  }
  if (command.subcommand === "retention") {
    return await requestSparkDaemonControl<LocalInvocationRetentionPreviewResult>(
      "invocation.retention.preview",
      {
        before: command.before,
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
      },
      client,
    );
  }
  const invocationId = command.invocationId!;
  if (command.subcommand === "status") {
    return await clientTurnStatus({ invocationId }, client);
  }
  if (command.subcommand === "result") {
    return await requestSparkDaemonControl<LocalTurnResult>(
      "turn.result",
      { invocationId },
      client,
    );
  }
  if (command.subcommand === "retry") {
    return await requestSparkDaemonControl<LocalInvocationRetryResult>(
      "invocation.retry",
      { invocationId },
      client,
    );
  }
  if (command.subcommand === "stream") {
    return await clientTurnStreamPage(
      {
        invocationId,
        after: command.after,
        limit: command.limit,
      },
      client,
    );
  }
  return await clientCancelTurn({ invocationId, reason: command.reason }, client);
}

async function clientSubmit(
  input: SparkDaemonTurnSubmitInput,
  client: SparkDaemonClientOptions,
  options: { signal?: AbortSignal } = {},
): Promise<LocalTurnSubmitResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  throwIfAborted(options.signal);
  await clientEnsureRunning(client);
  const admissionId = localRequestId();
  const admissionInput = {
    ...input,
    idempotencyKey: input.idempotencyKey ?? `turn.submit:${admissionId}`,
  };
  const wireRequest = localRpcWireRequest("turn.submit", admissionInput, admissionId);
  let failureCount = 0;
  while (true) {
    throwIfAborted(options.signal);
    try {
      return client.turnSubmit
        ? await client.turnSubmit(paths, admissionInput)
        : await localRpcRequest<LocalTurnSubmitResult>(paths, wireRequest, {
            signal: options.signal,
          });
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      if (!isRetryableTurnTransportError(error)) throw error;
      failureCount += 1;
      const delayMs = turnTransportRetryDelayMs(failureCount, client.random ?? Math.random);
      const recovery = await recoverTurnTransportIfDue(error, failureCount, client, options.signal);
      reportTurnTransportRetry(client, {
        operation: "submit",
        failureCount,
        error: turnTransportErrorMessage(error),
        nextRetryMs: delayMs,
        ...recovery,
      });
      await waitBeforeTurnTransportRetry(delayMs, client, options.signal);
    }
  }
}

function isRetryableTurnTransportError(error: unknown): boolean {
  if (error instanceof SparkDaemonLocalRpcRemoteError) {
    return isDaemonStartingRemoteError(error);
  }
  if (error instanceof SparkDaemonLocalRpcUnavailableError) {
    return !/does not support|unknown local RPC method/iu.test(error.message);
  }
  return (
    error instanceof SparkDaemonLocalRpcError &&
    /connection closed before a response/iu.test(error.message)
  );
}

function isDaemonStartingRemoteError(error: SparkDaemonLocalRpcRemoteError): boolean {
  const payload = isRecord(error.payload) ? error.payload : undefined;
  return (
    payload?.code === "daemon_starting" ||
    /daemon is still starting; retry after readiness/iu.test(
      typeof payload?.message === "string" ? payload.message : error.message,
    )
  );
}

function turnTransportRetryDelayMs(failureCount: number, random: () => number): number {
  const ceiling = cappedExponentialCeiling(
    failureCount,
    TURN_TRANSPORT_RETRY_BASE_MS,
    TURN_TRANSPORT_RETRY_MAX_MS,
    { exponentCap: 16 },
  );
  return equalJitter(ceiling, random);
}

async function recoverTurnTransportIfDue(
  error: unknown,
  failureCount: number,
  client: SparkDaemonClientOptions,
  signal: AbortSignal | undefined,
): Promise<{ recoveryAttempted: boolean; recoveryError?: string }> {
  const configuredInterval = client.turnTransportRecoveryInterval;
  const interval =
    typeof configuredInterval === "number" && Number.isFinite(configuredInterval)
      ? Math.max(1, Math.floor(configuredInterval))
      : TURN_TRANSPORT_RECOVERY_INTERVAL;
  if (!isDaemonUnavailableTransportError(error) || failureCount % interval !== 0) {
    return { recoveryAttempted: false };
  }

  throwIfAborted(signal);
  try {
    await clientEnsureRunning(client);
    throwIfAborted(signal);
    return { recoveryAttempted: true };
  } catch (recoveryError) {
    if (signal?.aborted) throwIfAborted(signal);
    return {
      recoveryAttempted: true,
      recoveryError: turnTransportErrorMessage(recoveryError),
    };
  }
}

function isDaemonUnavailableTransportError(error: unknown): boolean {
  return (
    error instanceof SparkDaemonLocalRpcUnavailableError ||
    (error instanceof SparkDaemonLocalRpcError &&
      !(error instanceof SparkDaemonLocalRpcRemoteError) &&
      /connection closed before a response/iu.test(error.message))
  );
}

function reportTurnTransportRetry(
  client: SparkDaemonClientOptions,
  event: SparkDaemonTurnTransportRetryEvent,
): void {
  if (client.onTurnTransportRetry) {
    try {
      client.onTurnTransportRetry(event);
      return;
    } catch (error) {
      console.error("[spark] turn transport retry observer failed", error);
    }
  }
  // A one-off transient close need not be noisy. Recurring failures are
  // surfaced at powers of two and every service recovery attempt.
  if (
    !event.recoveryAttempted &&
    event.failureCount !== 1 &&
    (event.failureCount & (event.failureCount - 1)) !== 0
  ) {
    return;
  }
  console.error(
    `[spark] ${event.operation} transport retry ${event.failureCount}; retrying in ${event.nextRetryMs}ms: ${event.error}${event.recoveryError ? `; recovery failed: ${event.recoveryError}` : ""}`,
  );
}

function turnTransportErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitBeforeTurnTransportRetry(
  ms: number,
  client: SparkDaemonClientOptions,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (!client.sleep) {
    await delay(ms, undefined, { signal });
    return;
  }
  if (!signal) {
    await client.sleep(ms);
    return;
  }

  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await Promise.race([client.sleep(ms, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

class TurnReadDeadlineError extends Error {}

async function retryTurnTransportRead<T>(
  read: () => Promise<T>,
  client: SparkDaemonClientOptions,
  options: {
    signal?: AbortSignal;
    deadline: number;
    deadlineError: TurnReadDeadlineError;
  },
): Promise<T> {
  const now = client.now ?? Date.now;
  let failureCount = 0;
  while (true) {
    throwIfAborted(options.signal);
    if (now() >= options.deadline) throw options.deadlineError;
    try {
      return await read();
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      if (!isRetryableTurnTransportError(error)) throw error;
      failureCount += 1;
      const remainingMs = options.deadline - now();
      if (remainingMs <= 0) throw options.deadlineError;
      const delayMs = Math.min(
        turnTransportRetryDelayMs(failureCount, client.random ?? Math.random),
        remainingMs,
      );
      const recovery = await recoverTurnTransportIfDue(error, failureCount, client, options.signal);
      reportTurnTransportRetry(client, {
        operation: "read",
        failureCount,
        error: turnTransportErrorMessage(error),
        nextRetryMs: delayMs,
        ...recovery,
      });
      await waitBeforeTurnTransportRetry(delayMs, client, options.signal);
    }
  }
}

/** Shared daemon-owned model/auth control request used by native TUI adapters. */
export async function requestSparkDaemonControl<T>(
  method: string,
  params: unknown,
  client: SparkDaemonClientOptions = {},
): Promise<T> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  if (client.controlRequest) return (await client.controlRequest(method, params)) as T;
  if (isSparkDaemonOrpcLiveMethod(method)) {
    try {
      return await requestSparkDaemonControlViaOrpc<T>(method, params, paths);
    } catch {
      // Fall back to the legacy line-delimited socket when oRPC is unavailable.
    }
  }
  return await localRpcRequest<T>(paths, localRpcWireRequest(method, params));
}

async function requestSparkDaemonControlViaOrpc<T>(
  method: string,
  params: unknown,
  paths: Pick<ReturnType<typeof resolveSparkPaths>, "runtimeDir">,
): Promise<T> {
  if (!isSparkDaemonOrpcLiveMethod(method)) {
    throw new Error(`oRPC live method not wired in TUI client: ${method}`);
  }
  const handle = await createSparkDaemonOrpcClient({ paths });
  try {
    return (await invokeSparkDaemonOrpcLiveMethod(handle.client, method, params ?? {})) as T;
  } finally {
    handle.close();
  }
}

export interface SparkDaemonHumanInteractionRespondInput {
  interactionRequestId: string;
  sessionId?: string;
  invocationId?: string;
  humanResponseId?: string;
  status: "answered" | "cancelled";
  answers?: Record<string, unknown>;
  responseArtifactRefs?: string[];
}

export interface SparkDaemonHumanInteractionRespondResult {
  outcome:
    | "accepted"
    | "replayed"
    | "already_resolved"
    | "orphaned"
    | "unknown_request"
    | "transient";
  retryable: boolean;
  returnedToTool: boolean;
  message: string;
  winnerResponseId?: string;
}

/** Deliver a native TUI answer to the daemon-owned interaction continuation. */
export async function clientRespondHumanInteraction(
  input: SparkDaemonHumanInteractionRespondInput,
  client: SparkDaemonClientOptions = {},
  options: { signal?: AbortSignal } = {},
): Promise<SparkDaemonHumanInteractionRespondResult> {
  const humanResponseId = input.humanResponseId ?? createId("hres");
  const params = {
    interactionRequestId: input.interactionRequestId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    humanResponseId,
    status: input.status,
    answers: input.answers ?? {},
    responseArtifactRefs: input.responseArtifactRefs ?? [],
  };
  for (let attempt = 1; attempt <= HUMAN_INTERACTION_RESPONSE_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      const result = await requestSparkDaemonControl<SparkDaemonHumanInteractionRespondResult>(
        "human.interaction.respond",
        params,
        client,
      );
      if (result.outcome !== "transient" || attempt === HUMAN_INTERACTION_RESPONSE_MAX_ATTEMPTS) {
        return result;
      }
    } catch (error) {
      if (
        options.signal?.aborted ||
        attempt === HUMAN_INTERACTION_RESPONSE_MAX_ATTEMPTS ||
        !isRetryableHumanInteractionResponseError(error)
      ) {
        if (options.signal?.aborted) throwIfAborted(options.signal);
        throw error;
      }
    }
    await waitBeforeTurnTransportRetry(
      HUMAN_INTERACTION_RESPONSE_RETRY_BASE_MS * 2 ** (attempt - 1),
      client,
      options.signal,
    );
  }
  throw new Error("Spark daemon human interaction response retry exhausted unexpectedly.");
}

export interface SparkDaemonHumanInteractionRequestHandlerOptions {
  currentSessionId: string;
  client?: SparkDaemonClientOptions;
  signal?: AbortSignal;
  reopenDelayMs?: number;
  interaction(request: SparkInteractionRequest): Promise<unknown>;
  notify(message: string, level: "success" | "warning"): void;
}

/** Keep a daemon-owned Ask visible until its answer reaches the owning wait. */
export async function handleSparkDaemonHumanInteractionRequest(
  request: SparkInteractionRequest,
  event: Extract<SparkDaemonEvent, { type: "daemon.interaction.request" }>,
  options: SparkDaemonHumanInteractionRequestHandlerOptions,
): Promise<void> {
  const client = options.client ?? {};
  const humanResponseId = createId("hres");
  while (!options.signal?.aborted) {
    const response = parseSparkInteractionResponse(await options.interaction(request));
    if (
      request.kind !== "askFlow" ||
      response.kind !== "askFlow" ||
      response.status === "pending" ||
      response.status === "blocked" ||
      response.status === "error"
    ) {
      return;
    }

    let delivered: SparkDaemonHumanInteractionRespondResult | undefined;
    let failure: unknown;
    try {
      delivered = await clientRespondHumanInteraction(
        {
          interactionRequestId: request.requestId,
          sessionId: event.sessionId ?? options.currentSessionId,
          ...(event.invocationId ? { invocationId: event.invocationId } : {}),
          humanResponseId,
          status: response.status === "answered" ? "answered" : "cancelled",
          answers: response.answers,
        },
        client,
        { signal: options.signal },
      );
    } catch (error) {
      failure = error;
    }

    if (options.signal?.aborted) return;
    if (delivered && isTerminalHumanInteractionDelivery(delivered.outcome)) {
      options.notify(
        delivered.message || `Ask response: ${delivered.outcome}`,
        delivered.outcome === "accepted" || delivered.outcome === "replayed"
          ? "success"
          : "warning",
      );
      return;
    }

    const reason =
      delivered?.message ?? (failure === undefined ? "" : turnTransportErrorMessage(failure));
    options.notify(
      `Ask response was not delivered; keeping it open for retry${reason ? `: ${reason}` : "."}`,
      "warning",
    );
    try {
      await waitBeforeTurnTransportRetry(options.reopenDelayMs ?? 250, client, options.signal);
    } catch (error) {
      if (options.signal?.aborted) return;
      throw error;
    }
  }
}

function isTerminalHumanInteractionDelivery(
  outcome: SparkDaemonHumanInteractionRespondResult["outcome"],
): boolean {
  return (
    outcome === "accepted" ||
    outcome === "replayed" ||
    outcome === "already_resolved" ||
    outcome === "orphaned"
  );
}

function isRetryableHumanInteractionResponseError(error: unknown): boolean {
  if (isRetryableTurnTransportError(error)) return true;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "human_interaction_not_found" ||
    /No pending daemon-owned human interaction matched/iu.test(message)
  );
}

export async function clientTurnStatus(
  input: { invocationId: string },
  client: SparkDaemonClientOptions,
  options: { signal?: AbortSignal; ensureRunning?: boolean; timeoutMs?: number } = {},
): Promise<LocalTurnStatusResult> {
  throwIfAborted(options.signal);
  const paths = resolveSparkDaemonClientPaths(client);
  if (options.ensureRunning !== false) await clientEnsureRunning(client);
  throwIfAborted(options.signal);
  if (client.turnStatus) return await client.turnStatus(paths, input);
  return await localRpcRequest<LocalTurnStatusResult>(
    paths,
    localRpcWireRequest("turn.status", input),
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
}

export async function clientTurnStreamPage(
  input: { invocationId: string; after?: number; limit?: number },
  client: SparkDaemonClientOptions,
  options: { signal?: AbortSignal; ensureRunning?: boolean; timeoutMs?: number } = {},
): Promise<LocalTurnStreamResult> {
  throwIfAborted(options.signal);
  const paths = resolveSparkDaemonClientPaths(client);
  if (options.ensureRunning !== false) await clientEnsureRunning(client);
  throwIfAborted(options.signal);
  if (client.turnStream) return await client.turnStream(paths, input);
  return await localRpcRequest<LocalTurnStreamResult>(
    paths,
    localRpcWireRequest("turn.stream", input),
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
}

export async function clientCancelTurn(
  input: { invocationId: string; reason?: string },
  client: SparkDaemonClientOptions,
): Promise<LocalTurnCancelResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  if (client.turnCancel) return await client.turnCancel(paths, input);
  return await localRpcRequest<LocalTurnCancelResult>(
    paths,
    localRpcWireRequest("turn.cancel", input),
  );
}

async function clientSubmitStreaming(
  input: SparkDaemonTurnSubmitInput,
  client: SparkDaemonClientOptions,
  handlers: {
    onEvent?: (event: SparkDaemonEvent) => void | Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<LocalTurnSubmitResult> {
  throwIfAborted(handlers.signal);
  await clientEnsureRunning(client);
  const submitted = await clientSubmit(input, client, { signal: handlers.signal });
  if (handlers.onEvent) await pollInvocationEvents(submitted.invocationId, client, handlers);
  return submitted;
}

async function pollInvocationEvents(
  invocationId: string,
  client: SparkDaemonClientOptions,
  handlers: {
    onEvent?: (event: SparkDaemonEvent) => void | Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<void> {
  let cursor = 0;
  const now = client.now ?? Date.now;
  const deadline = now() + (handlers.timeoutMs ?? DEFAULT_NATIVE_TURN_WAIT_TIMEOUT_MS);
  const deadlineError = new TurnReadDeadlineError();
  const streamTimeoutError = () =>
    new Error(`Timed out while streaming invocation ${invocationId}`);
  while (true) {
    throwIfAborted(handlers.signal);
    try {
      if (now() >= deadline) throw deadlineError;
      const page = await retryTurnTransportRead(
        () =>
          clientTurnStreamPage({ invocationId, after: cursor, limit: 100 }, client, {
            signal: handlers.signal,
            ensureRunning: false,
            timeoutMs: Math.max(1, deadline - now()),
          }),
        client,
        { signal: handlers.signal, deadline, deadlineError },
      );
      for (const event of page.events) {
        let parsed: SparkDaemonEvent;
        try {
          parsed = parseSparkDaemonEvent(event.payload);
        } catch {
          // Invocation event storage can also contain non-daemon diagnostic payloads.
          continue;
        }
        await handlers.onEvent?.(parsed);
      }
      cursor = page.nextCursor;
      if (now() >= deadline) throw deadlineError;
      const status = await retryTurnTransportRead(
        () =>
          clientTurnStatus({ invocationId }, client, {
            signal: handlers.signal,
            ensureRunning: false,
            timeoutMs: Math.max(1, deadline - now()),
          }),
        client,
        { signal: handlers.signal, deadline, deadlineError },
      );
      if (
        (status.status === "succeeded" ||
          status.status === "failed" ||
          status.status === "cancelled") &&
        !page.hasMore &&
        cursor >= status.eventCursor
      ) {
        return;
      }
      if (!page.hasMore) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) throw deadlineError;
        await delay(Math.min(25, remainingMs), undefined, { signal: handlers.signal });
      }
    } catch (error) {
      if (handlers.signal?.aborted) throwIfAborted(handlers.signal);
      if (error === deadlineError) throw streamTimeoutError();
      throw error;
    }
  }
}

export async function clientListDaemonWorkspaces(
  client: SparkDaemonClientOptions = {},
): Promise<LocalDaemonWorkspaceListResult> {
  return await clientWorkspaceList(client);
}

async function clientWorkspaceList(
  client: SparkDaemonClientOptions,
): Promise<LocalDaemonWorkspaceListResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  if (client.workspaceList) return await client.workspaceList(paths);
  return await localRpcRequest<LocalDaemonWorkspaceListResult>(
    paths,
    localRpcWireRequest("workspace.list"),
  );
}

async function clientEnsureLocalWorkspace(
  input: LocalWorkspaceEnsureLocalInput,
  client: SparkDaemonClientOptions,
): Promise<SparkDaemonWorkspace> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  if (client.workspaceEnsureLocal) return await client.workspaceEnsureLocal(paths, input);
  return await localRpcRequest<SparkDaemonWorkspace>(
    paths,
    localRpcWireRequest("workspace.ensure-local", input),
  );
}

async function clientWorkspaceClientAttach(
  input: LocalWorkspaceClientAttachInput,
  client: SparkDaemonClientOptions,
): Promise<LocalWorkspaceClientResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.workspaceClientAttach) return await client.workspaceClientAttach(paths, input);
  return await localRpcRequest<LocalWorkspaceClientResult>(
    paths,
    localRpcWireRequest("workspace.client.attach", input),
  );
}

async function clientWorkspaceClientHeartbeat(
  input: LocalWorkspaceClientHeartbeatInput,
  client: SparkDaemonClientOptions,
): Promise<LocalWorkspaceClientResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.workspaceClientHeartbeat) return await client.workspaceClientHeartbeat(paths, input);
  return await localRpcRequest<LocalWorkspaceClientResult>(
    paths,
    localRpcWireRequest("workspace.client.heartbeat", input),
  );
}

async function clientWorkspaceClientRelease(
  input: LocalWorkspaceClientReleaseInput,
  client: SparkDaemonClientOptions,
): Promise<LocalWorkspaceClientResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.workspaceClientRelease) return await client.workspaceClientRelease(paths, input);
  return await localRpcRequest<LocalWorkspaceClientResult>(
    paths,
    localRpcWireRequest("workspace.client.release", input),
  );
}

function defaultWorkspaceClientDisplayName(kind: SparkWorkspaceClientKind): string {
  switch (kind) {
    case "interactive":
      return STRINGS.displayName.interactive;
    case "headless":
      return STRINGS.displayName.headless;
    case "executor":
      return STRINGS.displayName.executor;
  }
}

async function clientEnsureRunning(client: SparkDaemonClientOptions): Promise<void> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (
    client.startService ||
    client.daemonStatus ||
    client.turnSubmit ||
    client.turnCancel ||
    client.workspaceList ||
    client.workspaceEnsureLocal ||
    client.workspaceClientAttach
  ) {
    client.startService?.(paths);
    await client.daemonStatus?.(paths);
    return;
  }
  const pid = readPidFile(paths.pidFile);
  if (pid && isProcessAlive(pid)) {
    try {
      await localRpcRequest(paths, localRpcWireRequest("daemon.status"));
      return;
    } catch {
      // Restart unreachable process below.
    }
  }
  const service = sparkDaemonServiceCliCommand();
  // Keep channel/SDK diagnostics: stdio:"ignore" sent everything to /dev/null and
  // made Infoflow autoRegister / inbound frames impossible to observe.
  const logDir = join(dirname(paths.runtimeDir), "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const stdout = openSync(join(logDir, "service.stdout.log"), "a", 0o600);
  const stderr = openSync(join(logDir, "service.stderr.log"), "a", 0o600);
  try {
    const child = spawn(service.command, [...service.args, "start"], {
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: process.env,
    });
    child.unref();
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  await waitForDaemonRpc(paths, client);
}

async function runSparkDaemonServiceCommand(
  argv: string[],
  client: SparkDaemonClientOptions,
): Promise<number> {
  if (client.serviceCommand) return await client.serviceCommand(argv);
  const service = sparkDaemonServiceCliCommand();
  return await runForeground(service.command, [...service.args, ...argv]);
}

async function runForeground(command: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited from signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

function sparkDaemonServiceCliCommand(): { command: string; args: string[] } {
  const daemonAppDir = fileURLToPath(new URL("../../../spark-daemon", import.meta.url));
  const distCli = join(daemonAppDir, "dist", "cli.js");
  if (existsSync(distCli)) {
    return { command: process.execPath, args: [distCli] };
  }

  if (existsSync(join(daemonAppDir, "package.json"))) {
    const build = spawnSync("pnpm", ["--dir", daemonAppDir, "run", "build"], {
      env: process.env,
      stdio: "inherit",
    });
    if (build.status !== 0) {
      throw new Error(STRINGS.buildServiceFailed);
    }
    if (existsSync(distCli)) {
      return { command: process.execPath, args: [distCli] };
    }
  }

  return { command: "spark", args: ["daemon"] };
}

async function waitForDaemonRpc(
  paths: SparkDaemonClientPaths,
  client: SparkDaemonClientOptions,
): Promise<void> {
  const now = client.now ?? Date.now;
  const sleep =
    client.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 2_000;
  let lastError: unknown;
  while (now() <= deadline) {
    try {
      await localRpcRequest(paths, localRpcWireRequest("daemon.status"));
      return;
    } catch (error) {
      lastError = error;
      await sleep(50);
    }
  }
  throw new Error(
    STRINGS.notReachable(lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

async function localRpcRequest<T>(
  paths: SparkDaemonClientPaths,
  request: LocalRpcWireRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  try {
    const timeoutMs =
      options.timeoutMs === undefined ? undefined : Math.max(1, Math.floor(options.timeoutMs));
    return await requestSparkDaemonLocalRpcWire<T>(request, {
      socketPath: paths.socketPath,
      signal: options.signal,
      ...(timeoutMs === undefined
        ? {}
        : {
            connectTimeoutMs: Math.min(1_000, timeoutMs),
            responseTimeoutMs: Math.min(30_000, timeoutMs),
          }),
    });
  } catch (error) {
    if (error instanceof SparkDaemonLocalRpcRemoteError) {
      if (isDaemonStartingRemoteError(error)) throw error;
      const message =
        isRecord(error.payload) && typeof error.payload.message === "string"
          ? error.payload.message
          : STRINGS.localRpcFailed;
      throw new Error(message);
    }
    throw error;
  }
}

function resolveSparkDaemonClientPaths(
  client: SparkDaemonClientOptions = {},
): SparkDaemonClientPaths {
  if (client.paths) return client.paths;
  const runtimeDir = resolveSparkPaths({ app: "daemon" }).runtimeDir;
  return {
    runtimeDir,
    socketPath: join(runtimeDir, "daemon.sock"),
    pidFile: join(runtimeDir, "daemon.pid"),
    lockPath: join(runtimeDir, "daemon.lock"),
  };
}

function readPrompt(parsed: ReturnType<typeof parseSparkCliOptions>): string | undefined {
  const fromOption = readStringOption(parsed.options, "prompt");
  const text = fromOption ?? parsed.positionals.join(" ");
  return text.trim() || undefined;
}

function readDaemonLeafArg(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === "all") return undefined;
  return raw === "root" ? null : raw;
}

function readRunState(raw: string): SparkDaemonRunState {
  if (
    raw === "queued" ||
    raw === "running" ||
    raw === "succeeded" ||
    raw === "failed" ||
    raw === "cancelled" ||
    raw === "all"
  ) {
    return raw;
  }
  throw new Error(`invalid daemon run state: ${raw}`);
}

function formatNativeDaemonStatus(status: SparkDaemonClientStatus): string {
  const lifecycle = status.lifecycle;
  const lifecycleStatus =
    typeof lifecycle === "object" && lifecycle !== null
      ? (lifecycle as NonNullable<SparkDaemonLocalStatus["lifecycle"]>)
      : undefined;
  const daemonState =
    status.running &&
    (lifecycleStatus?.state === "draining" || lifecycleStatus?.state === "stopping")
      ? lifecycleStatus.state
      : status.running
        ? "running"
        : "stopped";
  const lines = [`daemon: ${daemonState}`];
  if (typeof status.pid === "number") lines.push(`pid: ${status.pid}`);
  if (typeof status.socketPath === "string") lines.push(`socket: ${status.socketPath}`);
  if (typeof status.error === "string") lines.push(`error: ${status.error}`);
  if (lifecycleStatus?.drain) {
    lines.push(`drain-stage: ${lifecycleStatus.drain.stage}`);
    lines.push(
      `drain-blockers: scheduler=${lifecycleStatus.drain.scheduler.length} direct=${lifecycleStatus.drain.direct.length}`,
    );
  }
  if (lifecycleStatus?.stopReason) lines.push(`stop-reason: ${lifecycleStatus.stopReason}`);
  const invocations = status.invocations;
  if (isInvocationCounts(invocations)) {
    lines.push(
      `invocations: queued=${invocations.queued} running=${invocations.running} succeeded=${invocations.succeeded} failed=${invocations.failed} cancelled=${invocations.cancelled}`,
    );
  }
  const channelDeliveries = status.channelDeliveries;
  if (isChannelDeliveryCounts(channelDeliveries)) {
    lines.push(
      `channel-deliveries: pending=${channelDeliveries.pending} retrying=${channelDeliveries.retrying} in-flight=${channelDeliveries.inFlight} delivered=${channelDeliveries.delivered} uncertain=${channelDeliveries.uncertain}`,
    );
    if (typeof channelDeliveries.lastError === "string") {
      lines.push(`channel-delivery-error: ${channelDeliveries.lastError}`);
    }
  }
  const servers = Array.isArray(status.servers) ? status.servers : [];
  for (const server of servers) {
    if (!isNativeDaemonServer(server)) continue;
    const connected = server.wsConnected ? "connected" : "disconnected";
    lines.push(`server: ${server.url} workspaces=${server.workspaceCount} ws=${connected}`);
  }
  return lines.join("\n");
}

function isChannelDeliveryCounts(
  value: unknown,
): value is NonNullable<SparkDaemonLocalStatus["channelDeliveries"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { pending?: unknown }).pending === "number" &&
    typeof (value as { retrying?: unknown }).retrying === "number" &&
    typeof (value as { inFlight?: unknown }).inFlight === "number" &&
    typeof (value as { delivered?: unknown }).delivered === "number" &&
    typeof (value as { uncertain?: unknown }).uncertain === "number"
  );
}

function isInvocationCounts(value: unknown): value is SparkDaemonLocalStatus["invocations"] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { queued?: unknown }).queued === "number" &&
    typeof (value as { running?: unknown }).running === "number" &&
    typeof (value as { succeeded?: unknown }).succeeded === "number" &&
    typeof (value as { failed?: unknown }).failed === "number" &&
    typeof (value as { cancelled?: unknown }).cancelled === "number"
  );
}

function isNativeDaemonServer(value: unknown): value is {
  url: string;
  workspaceCount: number;
  wsConnected: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { url?: unknown }).url === "string" &&
    typeof (value as { workspaceCount?: unknown }).workspaceCount === "number" &&
    typeof (value as { wsConnected?: unknown }).wsConnected === "boolean"
  );
}

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function fileMtime(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function localRequestId(): string {
  return `spark_cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
