/** `spark daemon ...` command parsing and Spark daemon IPC client operations. */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  exportSparkSessionRecord,
  formatSessionList,
  formatSessionReplay,
  readSparkSessionExportFormat,
  type SparkSessionExportFormat,
} from "../host/session-navigation.ts";
import { SparkSessionStore, type SparkSessionInfo } from "../host/session-store.ts";
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
  | "service";
export type SparkDaemonCliQueueState = "inbox" | "processed" | "failed" | "all";

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
  daemonQueue?: (
    paths: SparkDaemonClientPaths,
    params: { state?: SparkDaemonCliQueueState; limit?: number },
  ) => Promise<LocalDaemonQueueResult>;
  turnSubmit?: (
    paths: SparkDaemonClientPaths,
    input: { sessionId: string; prompt: string; reset?: boolean },
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
  sessionList?: (paths: SparkDaemonClientPaths) => Promise<LocalDaemonSessionListResult>;
  sessionExport?: (
    paths: SparkDaemonClientPaths,
    params: { sessionId: string; format: SparkSessionExportFormat; leafId?: string | null },
  ) => Promise<LocalDaemonSessionTextResult>;
  sessionReplay?: (
    paths: SparkDaemonClientPaths,
    params: { sessionId: string; leafId?: string | null },
  ) => Promise<LocalDaemonSessionTextResult>;
  serviceCommand?: (argv: string[]) => Promise<number>;
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

export interface SparkDaemonClientStatus {
  running: boolean;
  [key: string]: unknown;
}

export interface LocalTurnSubmitResult {
  fileName: string;
  filePath: string;
  task: { type: "session.run"; sessionId: string; prompt: string; reset?: boolean };
  observedAt: string;
}

export interface LocalDaemonSessionListResult {
  sessions: SparkSessionInfo[];
  text: string;
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
      task: { type: "session.run"; sessionId: string; prompt: string; reset?: boolean };
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

export interface SparkDaemonWorkspace {
  id: string;
  serverUrl: string;
  localWorkspaceKey: string;
  displayName: string;
  localPath: string;
  status: string;
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
}

export interface SparkDaemonQueueCommand extends SparkDaemonCliCommandBase {
  action: "queue";
  state: SparkDaemonCliQueueState;
  limit?: number;
}

export interface SparkDaemonSessionsCommand extends SparkDaemonCliCommandBase {
  action: "sessions";
  subcommand: "list" | "export" | "replay";
  sessionId?: string;
  format?: SparkSessionExportFormat;
  leafId?: string | null;
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
  | SparkDaemonStartCommand
  | SparkDaemonServiceCommand;

export type SparkDaemonCliResult =
  | { action: "help"; text: string }
  | SparkDaemonStatusResult
  | SparkDaemonSubmitResult
  | SparkDaemonQueueResult
  | SparkDaemonSessionsResult
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
  result: LocalDaemonSessionListResult | LocalDaemonSessionTextResult;
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
      if (!sessionId) throw new Error("spark daemon submit requires --session <id>");
      if (!prompt) throw new Error("spark daemon submit requires --prompt <text> or trailing text");
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
      throw new Error(`unknown spark daemon command: ${String(action)}`);
  }
}

function parseSparkDaemonSessionsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonSessionsCommand {
  const [subcommand = "list", maybeLeaf] = parsed.positionals;
  if (subcommand === "list") return { action: "sessions", subcommand, json };
  if (subcommand === "export") {
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error("spark daemon sessions export requires --session <id|path>");
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
    if (!sessionId) throw new Error("spark daemon sessions replay requires --session <id|path>");
    const leafId = readDaemonLeafArg(readStringOption(parsed.options, "leaf") ?? maybeLeaf);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      ...(leafId !== undefined ? { leafId } : {}),
    };
  }
  throw new Error(`unknown spark daemon sessions command: ${subcommand}`);
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
          { sessionId: command.sessionId, prompt: command.prompt, reset: command.reset },
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
    case "start":
      await clientEnsureRunning(client);
      return { action: "start", daemon: await clientStatus(client) };
    case "service":
      throw new Error("spark daemon service commands must be run through runSparkDaemonCliCommand");
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
  if (result.action === "sessions" && !command.json) {
    output.write(result.result.text);
    return 0;
  }
  printSparkCliResult(output, result, { json: command.json });
  return 0;
}

export function sparkDaemonHelpText(): string {
  return `spark daemon - Spark daemon control surface\n\nUsage:\n  spark daemon [--workspace <name>]\n  spark daemon status [--json]\n  spark daemon start [--json]\n  spark daemon stop [--yes]\n  spark daemon restart [--yes]\n  spark daemon logs [--follow] [--lines <n>]\n  spark daemon submit --session <id> --prompt <text> [--reset] [--json]\n  spark daemon queue [--state inbox|processed|failed|all] [--limit <n>] [--json]\n  spark daemon sessions [list] [--json]\n  spark daemon sessions export --session <id|path> [--format jsonl|json|text] [--leaf <entry-id|root>] [--json]\n  spark daemon sessions replay --session <id|path> [--leaf <entry-id|root>] [--json]\n  spark daemon workspace register [path] --server-url <url> --token <token|-> --name <name>\n  spark daemon workspace ls [--json] [--all] [--full]\n  spark daemon workspace show [name] [--json]\n  spark daemon workspace stop <name> [--yes]\n\nSpark CLI never runs an independent queue worker; it starts/wakes the Spark daemon and talks over local IPC.`;
}

export interface SparkDaemonNativeResponderOptions {
  sessionId?: string;
}

export function createSparkDaemonNativeResponder(
  client: SparkDaemonClientOptions = {},
  options: SparkDaemonNativeResponderOptions = {},
): (input: string) => Promise<string> {
  const sessionId = options.sessionId ?? `spark-cli-${Date.now().toString(36)}`;
  return async (input: string) => {
    const prompt = input.trim();
    if (!prompt) return "ignored empty prompt";
    const result = await clientSubmit({ sessionId, prompt }, client);
    return `queued for Spark daemon session ${sessionId}: ${result.fileName}`;
  };
}

export function createSparkDaemonNativeCommands(
  client: SparkDaemonClientOptions = {},
): SparkNativeSlashCommandMap {
  return {
    status: {
      description: "show Spark daemon status",
      handler: async () => formatNativeDaemonStatus(await clientStatus(client)),
    },
    queue: {
      description: "show Spark daemon queue; optional state: inbox, processed, failed, all",
      handler: async (args) => {
        const state = readNativeQueueState(args);
        return formatNativeDaemonQueue(await clientQueue({ state, limit: 10 }, client));
      },
    },
    start: {
      description: "start or wake the Spark daemon, then show status",
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
): Promise<LocalDaemonSessionListResult | LocalDaemonSessionTextResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (command.subcommand === "list") {
    if (client.sessionList) return await client.sessionList(paths);
    const sessions = await createLocalSessionStore(client).list();
    return { sessions, text: formatSessionList(sessions), observedAt: observedAt(client) };
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

function createLocalSessionStore(client: SparkDaemonClientOptions): SparkSessionStore {
  return new SparkSessionStore({
    cwd: process.cwd(),
    ...(client.sparkHome ? { sparkHome: client.sparkHome } : {}),
  });
}

function observedAt(client: SparkDaemonClientOptions): string {
  return new Date(client.now?.() ?? Date.now()).toISOString();
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
    const status = await localRpcRequest<SparkDaemonLocalStatus>(paths, {
      id: localRequestId(),
      method: "daemon.status",
    });
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

async function clientQueue(
  params: { state?: SparkDaemonCliQueueState; limit?: number },
  client: SparkDaemonClientOptions,
): Promise<LocalDaemonQueueResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.daemonQueue) return await client.daemonQueue(paths, params);
  return await localRpcRequest<LocalDaemonQueueResult>(paths, {
    id: localRequestId(),
    method: "daemon.queue",
    params,
  });
}

async function clientSubmit(
  input: { sessionId: string; prompt: string; reset?: boolean },
  client: SparkDaemonClientOptions,
): Promise<LocalTurnSubmitResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  if (client.turnSubmit) return await client.turnSubmit(paths, input);
  return await localRpcRequest<LocalTurnSubmitResult>(paths, {
    id: localRequestId(),
    method: "turn.submit",
    params: input,
  });
}

async function clientEnsureLocalWorkspace(
  input: LocalWorkspaceEnsureLocalInput,
  client: SparkDaemonClientOptions,
): Promise<SparkDaemonWorkspace> {
  const paths = resolveSparkDaemonClientPaths(client);
  await clientEnsureRunning(client);
  if (client.workspaceEnsureLocal) return await client.workspaceEnsureLocal(paths, input);
  return await localRpcRequest<SparkDaemonWorkspace>(paths, {
    id: localRequestId(),
    method: "workspace.ensure-local",
    params: input,
  });
}

async function clientWorkspaceClientAttach(
  input: LocalWorkspaceClientAttachInput,
  client: SparkDaemonClientOptions,
): Promise<LocalWorkspaceClientResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.workspaceClientAttach) return await client.workspaceClientAttach(paths, input);
  return await localRpcRequest<LocalWorkspaceClientResult>(paths, {
    id: localRequestId(),
    method: "workspace.client.attach",
    params: input,
  });
}

async function clientWorkspaceClientHeartbeat(
  input: LocalWorkspaceClientHeartbeatInput,
  client: SparkDaemonClientOptions,
): Promise<LocalWorkspaceClientResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.workspaceClientHeartbeat) return await client.workspaceClientHeartbeat(paths, input);
  return await localRpcRequest<LocalWorkspaceClientResult>(paths, {
    id: localRequestId(),
    method: "workspace.client.heartbeat",
    params: input,
  });
}

async function clientWorkspaceClientRelease(
  input: LocalWorkspaceClientReleaseInput,
  client: SparkDaemonClientOptions,
): Promise<LocalWorkspaceClientResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.workspaceClientRelease) return await client.workspaceClientRelease(paths, input);
  return await localRpcRequest<LocalWorkspaceClientResult>(paths, {
    id: localRequestId(),
    method: "workspace.client.release",
    params: input,
  });
}

function defaultWorkspaceClientDisplayName(kind: SparkWorkspaceClientKind): string {
  switch (kind) {
    case "interactive":
      return "Spark TUI";
    case "headless":
      return "Spark headless submit";
    case "executor":
      return "Spark background executor";
  }
}

async function clientEnsureRunning(client: SparkDaemonClientOptions): Promise<void> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (
    client.startService ||
    client.daemonStatus ||
    client.turnSubmit ||
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
      await localRpcRequest(paths, { id: localRequestId(), method: "daemon.status" });
      return;
    } catch {
      // Restart unreachable process below.
    }
  }
  const service = sparkDaemonServiceCliCommand();
  const child = spawn(service.command, [...service.args, "start"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
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
      throw new Error("Failed to build Spark daemon service CLI.");
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
      await localRpcRequest(paths, { id: localRequestId(), method: "daemon.status" });
      return;
    } catch (error) {
      lastError = error;
      await sleep(50);
    }
  }
  throw new Error(
    `Spark daemon did not become reachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function localRpcRequest<T>(
  paths: SparkDaemonClientPaths,
  request: Record<string, unknown>,
): Promise<T> {
  return await new Promise<T>((resolvePromise, reject) => {
    const socket = createConnection(paths.socketPath);
    let buffer = "";
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(1_000, () => fail(new Error(`Timed out connecting to ${paths.socketPath}`)));
    socket.once("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          id?: unknown;
          ok?: boolean;
          result?: T;
          error?: { message?: string };
        };
        if (response.ok !== true) {
          reject(new Error(response.error?.message ?? "Spark daemon local RPC failed"));
          return;
        }
        resolvePromise(response.result as T);
      } catch (error) {
        reject(error);
      }
    });
  });
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
  throw new Error(`invalid daemon queue state: ${raw}`);
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
