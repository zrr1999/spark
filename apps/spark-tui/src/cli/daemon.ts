/** `spark daemon ...` command parsing and Spark daemon IPC client operations. */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ChannelNotifySendResult } from "@zendev-lab/spark-channels";
import {
  parseSparkDaemonEvent,
  sparkCommandKindForLocalRpcMethod,
  sparkProtocolJsonObjectSchema,
  type SparkCommand,
  type SparkAssignment,
  type SparkDaemonEvent,
} from "@zendev-lab/spark-protocol";
import { sparkDaemonCliStrings } from "@zendev-lab/spark-i18n/cli";
import {
  requestSparkDaemonLocalRpcWire,
  SparkDaemonLocalRpcRemoteError,
} from "@zendev-lab/spark-system/daemon-local-rpc";

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
import { SparkSessionStore, type SparkSessionInfo } from "../host/session-store.ts";
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
  | "queue"
  | "start"
  | "sessions"
  | "channel"
  | "runs"
  | "events"
  | "service";
export type SparkDaemonCliQueueState = "inbox" | "processed" | "failed" | "all";

const STRINGS = sparkDaemonCliStrings();

export interface SparkDaemonClientPaths {
  runtimeDir: string;
  socketPath: string;
  pidFile: string;
  lockPath: string;
}

export interface SparkDaemonClientOptions {
  paths?: SparkDaemonClientPaths;
  startService?: (paths: SparkDaemonClientPaths) => unknown;
  daemonStatus?: (paths: SparkDaemonClientPaths) => Promise<SparkDaemonLocalStatus>;
  channelStatus?: (paths: SparkDaemonClientPaths) => Promise<ChannelStatusSnapshot>;
  daemonQueue?: (
    paths: SparkDaemonClientPaths,
    params: { state?: SparkDaemonCliQueueState; limit?: number },
  ) => Promise<LocalDaemonQueueResult>;
  turnSubmit?: (
    paths: SparkDaemonClientPaths,
    input: SparkDaemonTurnSubmitInput,
  ) => Promise<LocalTurnSubmitResult>;
  turnCancel?: (
    paths: SparkDaemonClientPaths,
    input: { invocationId: string; reason?: string },
  ) => Promise<LocalTurnCancelResult>;
  turnStream?: (
    paths: SparkDaemonClientPaths,
    input: SparkDaemonTurnSubmitInput,
    handlers: { onEvent?: (event: SparkDaemonEvent) => void; signal?: AbortSignal },
  ) => Promise<LocalTurnSubmitResult>;
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
    params?: { state?: SparkDaemonCliQueueState; limit?: number },
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
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
  queue: Record<"inbox" | "processed" | "failed", number>;
}

export interface SparkDaemonTurnSubmitInput {
  sessionId: string;
  prompt: string;
  model?: string;
  reset?: boolean;
  assignment?: SparkAssignment;
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

export interface LocalTurnSubmitResult {
  fileName: string;
  filePath: string;
  task: SparkDaemonTurnSubmitTask;
  observedAt: string;
}

export interface LocalTurnCancelResult {
  invocationId: string;
  cancelled: boolean;
  message: string;
  observedAt: string;
}

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

export interface LocalDaemonQueueResult {
  state: SparkDaemonCliQueueState;
  entries?: Array<{
    fileName: string;
    filePath: string;
    payload: {
      enqueuedAt: string;
      task: SparkDaemonTurnSubmitTask;
      processedAt?: string;
      result?: unknown;
      failedAt?: string;
      error?: string;
    };
  }>;
  byState?: Partial<
    Record<"inbox" | "processed" | "failed", NonNullable<LocalDaemonQueueResult["entries"]>>
  >;
  observedAt: string;
}

export interface LocalDaemonRunSummary {
  runKey: string;
  id: string;
  state: SparkDaemonCliQueueState;
  sessionKey?: string;
  prompt?: string;
  enqueuedAt?: string;
  processedAt?: string;
  failedAt?: string;
  fileName?: string;
  filePath?: string;
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
  reset?: boolean;
  assignment?: SparkAssignment;
}

export interface SparkDaemonQueueCommand extends SparkDaemonCliCommandBase {
  action: "queue";
  state: SparkDaemonCliQueueState;
  limit?: number;
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
    | "mailto"
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
  toSessionId?: string;
  fromSessionId?: string;
  subject?: string;
  message?: string;
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
  subcommand: "list" | "status" | "notify";
  workspaceId: string;
  notifyAction?: "test" | "send";
  route?: string;
  adapter?: string;
  recipient?: string;
  text?: string;
}

export interface SparkDaemonRunsCommand extends SparkDaemonCliCommandBase {
  action: "runs";
  subcommand: "list" | "show" | "cancel";
  runId?: string;
  state?: SparkDaemonCliQueueState;
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
  | SparkDaemonQueueCommand
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
  | SparkDaemonQueueResult
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

export interface SparkDaemonQueueResult {
  action: "queue";
  result: LocalDaemonQueueResult;
}

export interface SparkDaemonSessionsResult {
  action: "sessions";
  result:
    | LocalDaemonSessionListResult
    | LocalDaemonSessionTextResult
    | LocalDaemonSessionMailtoResult
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

export interface LocalDaemonSessionMailtoResult {
  subcommand: "mailto";
  message: SparkSessionMailMessage;
  filePath: string;
  text: string;
  observedAt: string;
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
      if (!sessionId) throw new Error(STRINGS.submitRequiresSession);
      if (!prompt) throw new Error(STRINGS.submitRequiresPrompt);
      return {
        action: "submit",
        json,
        sessionId,
        prompt,
        reset: readBooleanOption(parsed.options, "reset"),
      };
    }
    case "queue": {
      const state = readQueueState(readStringOption(parsed.options, "state") ?? "inbox");
      const limit = readNumberOption(parsed.options, "limit");
      return { action: "queue", json, state, limit };
    }
    case "session":
    case "sessions":
      return parseSparkDaemonSessionsCommand(parsed, json);
    case "channel":
    case "channels": {
      const [subcommand = "status"] = parsed.positionals;
      if (subcommand === "list" || subcommand === "status") {
        const workspaceId = readStringOption(parsed.options, "workspace");
        if (!workspaceId?.trim()) {
          throw new Error("spark daemon channel status requires --workspace <workspaceId>");
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
      return { action: "service", argv };
    case "restart":
    case "logs":
      return { action: "service", argv: ["daemon", ...argv] };
    default:
      throw new Error(STRINGS.unknownCommand(String(action)));
  }
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
  if (subcommand === "mailto") {
    const toSessionId = readStringOption(parsed.options, "to")?.trim();
    const message =
      readStringOption(parsed.options, "message")?.trim() ||
      parsed.positionals.slice(1).join(" ").trim();
    if (!toSessionId) throw new Error("spark daemon session mailto requires --to <session-id>");
    if (!message)
      throw new Error("spark daemon session mailto requires --message <text> or trailing text");
    return {
      action: "sessions",
      subcommand,
      json,
      toSessionId,
      message,
      fromSessionId: readStringOption(parsed.options, "from")?.trim(),
      subject: readStringOption(parsed.options, "subject")?.trim(),
    };
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
    const state = readQueueState(readStringOption(parsed.options, "state") ?? "all");
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
            reset: command.reset,
            ...(command.assignment ? { assignment: command.assignment } : {}),
          },
          client,
        ),
      };
    case "queue":
      return {
        action: "queue",
        result: await clientQueue({ state: command.state, limit: command.limit }, client),
      };
    case "sessions":
      return { action: "sessions", result: await clientSessions(command, client) };
    case "channel":
      if (command.subcommand === "notify") {
        return {
          action: "channel",
          result: await clientChannelNotify(command, client),
        };
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
  printSparkCliResult(output, result, { json: command.json });
  return 0;
}

export function sparkDaemonHelpText(): string {
  return STRINGS.helpText;
}

export interface SparkDaemonNativeResponderOptions {
  sessionId?: string;
  waitForCompletion?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface SparkDaemonNativeResponderContext {
  signal?: AbortSignal;
  appendAssistantChunk?: (chunk: string) => void;
  finishAssistantMessage?: () => void;
}

export function createSparkDaemonNativeResponder(
  client: SparkDaemonClientOptions = {},
  options: SparkDaemonNativeResponderOptions = {},
): (input: string, context?: SparkDaemonNativeResponderContext) => Promise<string> {
  const sessionId = options.sessionId ?? `spark-cli-${Date.now().toString(36)}`;
  return async (input: string, context?: SparkDaemonNativeResponderContext) => {
    const prompt = input.trim();
    if (!prompt) return STRINGS.ignoredEmptyPrompt;
    const live = createDaemonLiveAssistantRenderer(context);
    const result = await clientSubmitStreaming({ sessionId, prompt }, client, {
      signal: context?.signal,
      onEvent: live.onEvent,
    });
    if (options.waitForCompletion === false) {
      return STRINGS.queuedSession(sessionId, result.fileName);
    }
    const finalText = await waitForSubmittedTurn(result, client, {
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
): {
  streamed: boolean;
  onEvent?: (event: SparkDaemonEvent) => void;
} {
  if (!context?.appendAssistantChunk) return { streamed: false };
  let streamed = false;
  let lastText = "";
  return {
    get streamed() {
      return streamed;
    },
    onEvent(event) {
      const text = assistantTextFromDaemonViewEvent(event);
      if (text === undefined) return;
      const chunk = text.startsWith(lastText) ? text.slice(lastText.length) : text;
      lastText = text;
      if (!chunk) return;
      streamed = true;
      context.appendAssistantChunk?.(chunk);
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
  submitted: LocalTurnSubmitResult,
  client: SparkDaemonClientOptions,
  options: SubmittedTurnWaitOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    const queue = await clientQueue({ state: "all", limit: 100 }, client);
    const entry = findQueueEntry(queue, submitted.fileName);
    if (entry?.payload.failedAt) {
      throw new Error(entry.payload.error ?? STRINGS.failedFile(submitted.fileName));
    }
    if (entry?.payload.processedAt) {
      return renderProcessedTurnResponse(entry.payload.result, submitted);
    }
    await delay(pollIntervalMs, undefined, { signal: options.signal });
  }
  return STRINGS.queuedSession(submitted.task.sessionId, submitted.fileName);
}

function findQueueEntry(
  queue: LocalDaemonQueueResult,
  fileName: string,
): NonNullable<LocalDaemonQueueResult["entries"]>[number] | undefined {
  const entries = [
    ...(queue.entries ?? []),
    ...Object.values(queue.byState ?? {}).flatMap((items) => items ?? []),
  ];
  return entries.find((entry) => entry.fileName === fileName);
}

function renderProcessedTurnResponse(result: unknown, submitted: LocalTurnSubmitResult): string {
  if (isRecord(result)) {
    const assistantText = result.assistantText;
    if (typeof assistantText === "string" && assistantText.trim()) return assistantText;
    const stderr = result.stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr;
  }
  return STRINGS.completedSession(submitted.task.sessionId, submitted.fileName);
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
    queue: {
      description: STRINGS.nativeCommandDescriptions.queue,
      metadata: {
        source: "extension",
        extensionId: "spark-daemon-native",
        plane: "daemon",
        resource: "queue",
        verbs: ["list"],
        canonicalCliTarget: "spark daemon queue",
      },
      handler: async (args) => {
        const state = readNativeQueueState(args);
        return formatNativeDaemonQueue(await clientQueue({ state, limit: 10 }, client));
      },
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
  const attached = await clientWorkspaceClientAttach(
    {
      workspaceId: workspace.id,
      ...(options.clientId ? { clientId: options.clientId } : {}),
      kind: options.kind,
      displayName: options.displayName ?? defaultWorkspaceClientDisplayName(options.kind),
      leaseTtlMs,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    },
    client,
  );
  let released = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeat = async () =>
    await clientWorkspaceClientHeartbeat({ clientId: attached.client.id, leaseTtlMs }, client);
  const release = async () => {
    if (released) return null;
    released = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    return await clientWorkspaceClientRelease({ clientId: attached.client.id }, client);
  };

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  if (heartbeatIntervalMs !== false && heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      void heartbeat().catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  return { client: attached.client, workspace: attached.workspace, heartbeat, release };
}

async function clientSessions(
  command: SparkDaemonSessionsCommand,
  client: SparkDaemonClientOptions,
): Promise<
  | LocalDaemonSessionListResult
  | LocalDaemonSessionTextResult
  | LocalDaemonSessionMailtoResult
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
  if (command.subcommand === "mailto") {
    const sessionStore = createLocalSessionStore(client);
    await assertKnownLocalSession(sessionStore, command.toSessionId!);
    const mailStore = createLocalSessionMailStore(client);
    const sent = await mailStore.send({
      toSessionId: command.toSessionId!,
      fromSessionId: command.fromSessionId,
      subject: command.subject,
      body: command.message!,
      source: "cli",
    });
    return {
      subcommand: "mailto",
      message: sent.message,
      filePath: sent.path,
      text: renderMailtoResult(sent.message, sent.path),
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
) {
  return await clientManagedSessions(client).get(sessionId);
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
  const queue = await clientQueue({ state: command.state ?? "all", limit: command.limit }, client);
  const runs = runsFromQueue(queue);
  return {
    plane: "daemon",
    resource: "run",
    runs,
    text: runs.length ? runs.map(renderRunSummary).join("") : "No Spark daemon runs found.\n",
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

function runsFromQueue(queue: LocalDaemonQueueResult): LocalDaemonRunSummary[] {
  const entries: Array<{
    state: SparkDaemonCliQueueState;
    entry: NonNullable<LocalDaemonQueueResult["entries"]>[number];
  }> = [];
  if (queue.state !== "all") {
    for (const entry of queue.entries ?? []) entries.push({ state: queue.state, entry });
  }
  for (const [state, items] of Object.entries(queue.byState ?? {})) {
    for (const entry of items ?? []) {
      entries.push({ state: state as SparkDaemonCliQueueState, entry });
    }
  }
  if (queue.state === "all" && queue.entries) {
    for (const entry of queue.entries) entries.push({ state: inferRunState(entry), entry });
  }
  return entries.map(({ state, entry }) => ({
    runKey: runKey(entry.fileName),
    id: entry.fileName,
    state,
    sessionKey: sessionKeyFromRun(entry.payload.task.sessionId),
    prompt: entry.payload.task.prompt,
    enqueuedAt: entry.payload.enqueuedAt,
    ...(entry.payload.processedAt ? { processedAt: entry.payload.processedAt } : {}),
    ...(entry.payload.failedAt ? { failedAt: entry.payload.failedAt } : {}),
    fileName: entry.fileName,
    filePath: entry.filePath,
  }));
}

function inferRunState(
  entry: NonNullable<LocalDaemonQueueResult["entries"]>[number],
): SparkDaemonCliQueueState {
  if (entry.payload.failedAt) return "failed";
  if (entry.payload.processedAt) return "processed";
  return "inbox";
}

function runKey(id: string): string {
  return id.startsWith("run:") ? id : `run:${id}`;
}

function sessionKeyFromRun(id: string): string {
  return id.startsWith("session:") ? id : `session:${id}`;
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

async function assertKnownLocalSession(store: SparkSessionStore, sessionId: string): Promise<void> {
  const normalized = normalizeSessionKey(sessionId);
  const sessions = await store.listAllPersistentSessions();
  if (
    sessions.some(
      (session) =>
        session.id === sessionId ||
        session.id === normalized ||
        `session:${session.id}` === sessionId,
    )
  ) {
    return;
  }
  throw new Error(`Spark session not found: ${sessionId}`);
}

function normalizeSessionKey(sessionId: string): string {
  return sessionId.startsWith("session:") ? sessionId.slice("session:".length) : sessionId;
}

function renderMailtoResult(message: SparkSessionMailMessage, filePath: string): string {
  return `sent ${message.id} to ${message.toSessionId} (${filePath})\n`;
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
    method === "provider.auth.api-key.set" || method === "provider.auth.login.respond"
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
  };
  return await localRpcRequest<ChannelNotifySendResult>(
    paths,
    localRpcWireRequest("channel.notify", params),
  );
}

async function clientQueue(
  params: { state?: SparkDaemonCliQueueState; limit?: number },
  client: SparkDaemonClientOptions,
): Promise<LocalDaemonQueueResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.daemonQueue) return await client.daemonQueue(paths, params);
  return await localRpcRequest<LocalDaemonQueueResult>(
    paths,
    localRpcWireRequest("daemon.queue", params),
  );
}

async function clientSubmit(
  input: SparkDaemonTurnSubmitInput,
  client: SparkDaemonClientOptions,
): Promise<LocalTurnSubmitResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  if (client.turnSubmit) return await client.turnSubmit(paths, input);
  return await localRpcRequest<LocalTurnSubmitResult>(
    paths,
    localRpcWireRequest("turn.submit", input),
  );
}

/** Shared daemon-owned model/auth control request used by native TUI adapters. */
export async function requestSparkDaemonControl<T>(
  method: string,
  params: unknown,
  client: SparkDaemonClientOptions = {},
): Promise<T> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  return await localRpcRequest<T>(paths, localRpcWireRequest(method, params));
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
  handlers: { onEvent?: (event: SparkDaemonEvent) => void; signal?: AbortSignal } = {},
): Promise<LocalTurnSubmitResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  if (client.turnStream) return await client.turnStream(paths, input, handlers);
  if (handlers.onEvent) return await localRpcTurnStream(paths, input, handlers);
  return await clientSubmit(input, client);
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
): Promise<T> {
  try {
    return await requestSparkDaemonLocalRpcWire<T>(request, {
      socketPath: paths.socketPath,
    });
  } catch (error) {
    if (error instanceof SparkDaemonLocalRpcRemoteError) {
      const message =
        isRecord(error.payload) && typeof error.payload.message === "string"
          ? error.payload.message
          : STRINGS.localRpcFailed;
      throw new Error(message);
    }
    throw error;
  }
}

async function localRpcTurnStream(
  paths: SparkDaemonClientPaths,
  input: SparkDaemonTurnSubmitInput,
  handlers: { onEvent?: (event: SparkDaemonEvent) => void; signal?: AbortSignal } = {},
): Promise<LocalTurnSubmitResult> {
  const requestId = localRequestId();
  return await new Promise<LocalTurnSubmitResult>((resolvePromise, reject) => {
    const socket = createConnection(paths.socketPath);
    let buffer = "";
    let submitted: LocalTurnSubmitResult | undefined;
    let settled = false;
    const cleanup = () => {
      handlers.signal?.removeEventListener("abort", abort);
      socket.removeListener("error", fail);
    };
    const resolveOnce = () => {
      if (settled || !submitted) return;
      settled = true;
      cleanup();
      socket.end();
      resolvePromise(submitted);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const abort = () => fail(new Error("aborted"));
    handlers.signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(1_000, () => fail(new Error(`Timed out connecting to ${paths.socketPath}`)));
    socket.once("error", fail);
    socket.on("connect", () => {
      socket.setTimeout(5 * 60_000, () =>
        fail(new Error(`Timed out waiting for daemon stream from ${paths.socketPath}`)),
      );
      socket.write(`${JSON.stringify(localRpcWireRequest("turn.stream", input, requestId))}\n`);
    });
    socket.on("close", () => {
      if (submitted) resolveOnce();
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = parseLocalRpcStreamMessage(line, requestId);
          if (message.result) submitted = message.result;
          if (message.event) {
            handlers.onEvent?.(message.event);
            if (isTerminalStreamEvent(message.event)) resolveOnce();
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
}

function parseLocalRpcStreamMessage(
  line: string,
  requestId: string,
): { result?: LocalTurnSubmitResult; event?: SparkDaemonEvent } {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || value.id !== requestId || value.ok !== true) {
    const error = isRecord(value) && isRecord(value.error) ? value.error.message : undefined;
    throw new Error(typeof error === "string" ? error : STRINGS.invalidStreamResponse);
  }
  return {
    ...(isRecord(value.result) ? { result: value.result as unknown as LocalTurnSubmitResult } : {}),
    ...(isRecord(value.event) ? { event: parseSparkDaemonEvent(value.event) } : {}),
  };
}

function isTerminalStreamEvent(event: SparkDaemonEvent): boolean {
  return (
    event.type === "daemon.task.lifecycle" &&
    (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled")
  );
}

function resolveSparkDaemonClientPaths(
  client: SparkDaemonClientOptions = {},
): SparkDaemonClientPaths {
  if (client.paths) return client.paths;
  const home = process.env.HOME || homedir();
  const cwd = process.cwd();
  const stateHome = resolve(cwd, process.env.XDG_STATE_HOME ?? join(home, ".local", "state"));
  const stateDir = resolve(
    cwd,
    process.env.SPARK_DAEMON_STATE_DIR ?? join(stateHome, "spark", "daemon"),
  );
  const runtimeDir = resolve(
    cwd,
    process.env.SPARK_DAEMON_RUNTIME_DIR ??
      (process.env.XDG_RUNTIME_DIR
        ? join(process.env.XDG_RUNTIME_DIR, "spark", "daemon")
        : join(stateDir, "run")),
  );
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

function readQueueState(raw: string): SparkDaemonCliQueueState {
  if (raw === "inbox" || raw === "processed" || raw === "failed" || raw === "all") return raw;
  throw new Error(STRINGS.invalidQueueState(raw));
}

function readNativeQueueState(args: string): SparkDaemonCliQueueState {
  const [raw = "inbox"] = args.trim().split(/\s+/u).filter(Boolean);
  return readQueueState(raw);
}

function formatNativeDaemonStatus(status: SparkDaemonClientStatus): string {
  const lines = [`daemon: ${status.running ? "running" : "stopped"}`];
  if (typeof status.pid === "number") lines.push(`pid: ${status.pid}`);
  if (typeof status.socketPath === "string") lines.push(`socket: ${status.socketPath}`);
  if (typeof status.error === "string") lines.push(`error: ${status.error}`);
  const queue = status.queue;
  if (isQueueCounts(queue)) {
    lines.push(`queue: inbox=${queue.inbox} processed=${queue.processed} failed=${queue.failed}`);
  }
  const servers = Array.isArray(status.servers) ? status.servers : [];
  for (const server of servers) {
    if (!isNativeDaemonServer(server)) continue;
    const connected = server.wsConnected ? "connected" : "disconnected";
    lines.push(`server: ${server.url} workspaces=${server.workspaceCount} ws=${connected}`);
  }
  return lines.join("\n");
}

function formatNativeDaemonQueue(result: LocalDaemonQueueResult): string {
  const entries = flattenDaemonQueueEntries(result);
  const lines = [`queue:${result.state} entries=${entries.length}`];
  for (const entry of entries.slice(0, 10)) {
    const suffix = queueEntryResultSuffix(entry.payload);
    lines.push(
      `${entry.fileName} • ${entry.payload.task.sessionId} • ${entry.payload.task.prompt}${suffix}`,
    );
  }
  if (entries.length === 0) lines.push("queue is empty");
  return lines.join("\n");
}

function queueEntryResultSuffix(
  payload: NonNullable<LocalDaemonQueueResult["entries"]>[number]["payload"],
): string {
  if (typeof payload.error === "string" && payload.error.trim()) {
    return ` • error=${truncateNativeQueueValue(payload.error)}`;
  }
  if (Object.hasOwn(payload, "result")) {
    return ` • result=${truncateNativeQueueValue(payload.result)}`;
  }
  if (typeof payload.processedAt === "string") return " • processed";
  return "";
}

function truncateNativeQueueValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) || String(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function flattenDaemonQueueEntries(
  result: LocalDaemonQueueResult,
): NonNullable<LocalDaemonQueueResult["entries"]> {
  if (result.entries) return result.entries;
  if (!result.byState) return [];
  return Object.values(result.byState).flatMap((entries) => entries ?? []);
}

function isQueueCounts(value: unknown): value is Record<"inbox" | "processed" | "failed", number> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { inbox?: unknown }).inbox === "number" &&
    typeof (value as { processed?: unknown }).processed === "number" &&
    typeof (value as { failed?: unknown }).failed === "number"
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
