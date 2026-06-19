/** `spark daemon ...` command parsing and Spark daemon IPC client operations. */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  consoleSparkCliOutput,
  parseSparkCliOptions,
  printSparkCliResult,
  readBooleanOption,
  readNumberOption,
  readStringOption,
  type SparkCliOutput,
} from "./shared.ts";

export type SparkDaemonCliAction = "help" | "status" | "submit" | "queue" | "start";
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
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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

export interface LocalDaemonQueueResult {
  state: SparkDaemonCliQueueState;
  entries?: Array<{
    fileName: string;
    filePath: string;
    payload: {
      enqueuedAt: string;
      task: { type: "session.run"; sessionId: string; prompt: string; reset?: boolean };
    };
  }>;
  byState?: Partial<
    Record<"inbox" | "processed" | "failed", NonNullable<LocalDaemonQueueResult["entries"]>>
  >;
  observedAt: string;
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

export interface SparkDaemonStartCommand extends SparkDaemonCliCommandBase {
  action: "start";
}

export type SparkDaemonCliCommand =
  | SparkDaemonHelpCommand
  | SparkDaemonStatusCommand
  | SparkDaemonSubmitCommand
  | SparkDaemonQueueCommand
  | SparkDaemonStartCommand;

export type SparkDaemonCliResult =
  | { action: "help"; text: string }
  | SparkDaemonStatusResult
  | SparkDaemonSubmitResult
  | SparkDaemonQueueResult
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

export interface SparkDaemonStartResult {
  action: "start";
  daemon: SparkDaemonClientStatus;
}

export function parseSparkDaemonCliArgs(argv: string[]): SparkDaemonCliCommand {
  if (argv.length === 0 || argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { action: "help" };
  }

  const [action, ...rest] = argv;
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
    case "start":
      return { action: "start", json };
    default:
      throw new Error(`unknown spark daemon command: ${String(action)}`);
  }
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
    case "start":
      await clientEnsureRunning(client);
      return { action: "start", daemon: await clientStatus(client) };
  }
}

export async function runSparkDaemonCliCommand(
  command: SparkDaemonCliCommand,
  output: SparkCliOutput = consoleSparkCliOutput,
  client: SparkDaemonClientOptions = {},
): Promise<void> {
  const result = await handleSparkDaemonCliCommand(command, client);
  if (result.action === "help") {
    output.write(result.text);
    return;
  }
  printSparkCliResult(output, result, { json: command.json });
}

export function sparkDaemonHelpText(): string {
  return `spark daemon - Spark daemon IPC client\n\nUsage:\n  spark daemon status [--json]\n  spark daemon start [--json]\n  spark daemon submit --session <id> --prompt <text> [--reset] [--json]\n  spark daemon queue [--state inbox|processed|failed|all] [--limit <n>] [--json]\n\nSpark CLI never runs an independent queue worker; it starts/wakes the Spark daemon and talks over local IPC.`;
}

export function createSparkDaemonNativeResponder(
  client: SparkDaemonClientOptions = {},
): (input: string) => Promise<string> {
  return async (input: string) => {
    const prompt = input.trim();
    if (!prompt) return "ignored empty prompt";
    const result = await clientSubmit(
      { sessionId: `spark-cli-${Date.now().toString(36)}`, prompt },
      client,
    );
    return `queued for Spark daemon: ${result.fileName}`;
  };
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

async function clientEnsureRunning(client: SparkDaemonClientOptions): Promise<void> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.startService || client.daemonStatus || client.turnSubmit) {
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
  const child = spawn("spark-daemon", ["start"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  await waitForDaemonRpc(paths, client);
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

function readQueueState(raw: string): SparkDaemonCliQueueState {
  if (raw === "inbox" || raw === "processed" || raw === "failed" || raw === "all") return raw;
  throw new Error(`invalid daemon queue state: ${raw}`);
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
