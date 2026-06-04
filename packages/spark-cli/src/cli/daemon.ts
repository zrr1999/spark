/** `spark daemon ...` command parsing and local daemon operations. */

import { join, resolve } from "node:path";

import {
  acquireSparkDaemonLock,
  createSparkDaemonSessionRunExecutor,
  createSparkDaemonSignals,
  createSparkDaemonWorkerContext,
  defaultSparkDaemonRuntimeDir,
  readSparkDaemonLock,
  runSparkDaemonWorkerIteration,
  runSparkDaemonWorkerLoop,
  SparkDaemonQueue,
  waitForSparkDaemonActiveTasks,
  type SparkDaemonQueueEntry,
  type SparkDaemonQueueState,
  type SparkDaemonTask,
} from "../host/index.ts";
import {
  consoleSparkCliOutput,
  parseSparkCliOptions,
  printSparkCliResult,
  readBooleanOption,
  readNumberOption,
  readStringOption,
  type SparkCliOutput,
} from "./shared.ts";

export type SparkDaemonCliAction = "help" | "status" | "enqueue" | "queue" | "run";
export type SparkDaemonCliQueueState = SparkDaemonQueueState | "all";

export interface SparkDaemonCliCommandBase {
  action: SparkDaemonCliAction;
  sparkHome?: string;
  json?: boolean;
}

export interface SparkDaemonHelpCommand extends SparkDaemonCliCommandBase {
  action: "help";
}

export interface SparkDaemonStatusCommand extends SparkDaemonCliCommandBase {
  action: "status";
}

export interface SparkDaemonEnqueueCommand extends SparkDaemonCliCommandBase {
  action: "enqueue";
  sessionId: string;
  prompt: string;
}

export interface SparkDaemonQueueCommand extends SparkDaemonCliCommandBase {
  action: "queue";
  state: SparkDaemonCliQueueState;
  limit?: number;
}

export interface SparkDaemonRunCommand extends SparkDaemonCliCommandBase {
  action: "run";
  cwd?: string;
  once?: boolean;
  pollIntervalMs?: number;
}

export type SparkDaemonCliCommand =
  | SparkDaemonHelpCommand
  | SparkDaemonStatusCommand
  | SparkDaemonEnqueueCommand
  | SparkDaemonQueueCommand
  | SparkDaemonRunCommand;

export type SparkDaemonCliResult =
  | { action: "help"; text: string }
  | SparkDaemonStatusResult
  | SparkDaemonEnqueueResult
  | SparkDaemonQueueResult
  | SparkDaemonRunResult;

export interface SparkDaemonStatusResult {
  action: "status";
  sparkHome?: string;
  lockPath: string;
  running: boolean;
  lock: Awaited<ReturnType<typeof readSparkDaemonLock>>;
  queue: Record<SparkDaemonQueueState, number>;
}

export interface SparkDaemonEnqueueResult {
  action: "enqueue";
  fileName: string;
  filePath: string;
  task: SparkDaemonTask;
}

export interface SparkDaemonQueueResult {
  action: "queue";
  state: SparkDaemonCliQueueState;
  entries?: SparkDaemonQueueEntry[];
  byState?: Partial<Record<SparkDaemonQueueState, SparkDaemonQueueEntry[]>>;
}

export interface SparkDaemonRunResult {
  action: "run";
  once: boolean;
  didWork?: boolean;
  lockPath: string;
  stopped?: boolean;
}

export function parseSparkDaemonCliArgs(argv: string[]): SparkDaemonCliCommand {
  if (argv.length === 0 || argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { action: "help" };
  }

  const [action, ...rest] = argv;
  const parsed = parseSparkCliOptions(rest);
  const sparkHome = readStringOption(parsed.options, "spark-home");
  const json = readBooleanOption(parsed.options, "json");

  switch (action) {
    case "status":
      return { action: "status", sparkHome, json };
    case "enqueue": {
      const sessionId = readStringOption(parsed.options, "session")?.trim();
      const prompt = readPrompt(parsed);
      if (!sessionId) throw new Error("spark daemon enqueue requires --session <id>");
      if (!prompt)
        throw new Error("spark daemon enqueue requires --prompt <text> or trailing text");
      return { action: "enqueue", sparkHome, json, sessionId, prompt };
    }
    case "queue": {
      const state = readQueueState(readStringOption(parsed.options, "state") ?? "inbox");
      const limit = readNumberOption(parsed.options, "limit");
      return { action: "queue", sparkHome, json, state, limit };
    }
    case "run": {
      const cwd = readStringOption(parsed.options, "cwd");
      const pollIntervalMs = readNumberOption(parsed.options, "poll-ms");
      return {
        action: "run",
        sparkHome,
        json,
        cwd,
        once: readBooleanOption(parsed.options, "once"),
        pollIntervalMs,
      };
    }
    default:
      throw new Error(`unknown spark daemon command: ${String(action)}`);
  }
}

export async function handleSparkDaemonCliCommand(
  command: SparkDaemonCliCommand,
): Promise<SparkDaemonCliResult> {
  switch (command.action) {
    case "help":
      return { action: "help", text: sparkDaemonHelpText() };
    case "status":
      return await daemonStatus(command);
    case "enqueue":
      return await daemonEnqueue(command);
    case "queue":
      return await daemonQueue(command);
    case "run":
      return await daemonRun(command);
  }
}

export async function runSparkDaemonCliCommand(
  command: SparkDaemonCliCommand,
  output: SparkCliOutput = consoleSparkCliOutput,
): Promise<void> {
  const result = await handleSparkDaemonCliCommand(command);
  if (result.action === "help") {
    output.write(result.text);
    return;
  }
  printSparkCliResult(output, result, { json: command.json });
}

export function sparkDaemonHelpText(): string {
  return `spark daemon - local daemon-only queue runner\n\nUsage:\n  spark daemon status [--json] [--spark-home <dir>]\n  spark daemon enqueue --session <id> --prompt <text> [--json] [--spark-home <dir>]\n  spark daemon queue [--state inbox|processed|failed|all] [--limit <n>] [--json] [--spark-home <dir>]\n  spark daemon run [--once] [--cwd <dir>] [--poll-ms <n>] [--spark-home <dir>]\n\nNo gateway/HTTP/service commands are provided.`;
}

async function daemonStatus(command: SparkDaemonStatusCommand): Promise<SparkDaemonStatusResult> {
  const queue = new SparkDaemonQueue({ sparkHome: command.sparkHome });
  const lockPath = join(defaultSparkDaemonRuntimeDir(command.sparkHome), "daemon.lock");
  const lock = await readSparkDaemonLock(lockPath);
  return {
    action: "status",
    sparkHome: command.sparkHome,
    lockPath,
    running: Boolean(lock),
    lock,
    queue: {
      inbox: (await queue.list("inbox")).length,
      processed: (await queue.list("processed")).length,
      failed: (await queue.list("failed")).length,
    },
  };
}

async function daemonEnqueue(
  command: SparkDaemonEnqueueCommand,
): Promise<SparkDaemonEnqueueResult> {
  const queue = new SparkDaemonQueue({ sparkHome: command.sparkHome });
  const entry = await queue.enqueue({
    type: "session.run",
    sessionId: command.sessionId,
    prompt: command.prompt,
    actor: "spark-cli",
  });
  return {
    action: "enqueue",
    fileName: entry.fileName,
    filePath: entry.filePath,
    task: entry.payload.task,
  };
}

async function daemonQueue(command: SparkDaemonQueueCommand): Promise<SparkDaemonQueueResult> {
  const queue = new SparkDaemonQueue({ sparkHome: command.sparkHome });
  if (command.state === "all") {
    return {
      action: "queue",
      state: "all",
      byState: {
        inbox: limitEntries(await queue.listEntries("inbox"), command.limit),
        processed: limitEntries(await queue.listEntries("processed"), command.limit),
        failed: limitEntries(await queue.listEntries("failed"), command.limit),
      },
    };
  }
  return {
    action: "queue",
    state: command.state,
    entries: limitEntries(await queue.listEntries(command.state), command.limit),
  };
}

async function daemonRun(command: SparkDaemonRunCommand): Promise<SparkDaemonRunResult> {
  const cwd = command.cwd ? resolve(command.cwd) : process.cwd();
  const lock = await acquireSparkDaemonLock({ sparkHome: command.sparkHome, cwd });
  try {
    const context = createSparkDaemonWorkerContext({
      sparkHome: command.sparkHome,
      executeTask: createSparkDaemonSessionRunExecutor({ cwd, sparkHome: command.sparkHome }),
    });
    if (command.once) {
      const didWork = await runSparkDaemonWorkerIteration({ context, label: "spark-daemon" });
      await waitForSparkDaemonActiveTasks(context.active);
      return { action: "run", once: true, didWork, lockPath: lock.path };
    }

    const signals = createSparkDaemonSignals();
    try {
      await runSparkDaemonWorkerLoop({
        context,
        label: "spark-daemon",
        pollIntervalMs: command.pollIntervalMs,
        isStopped: () => signals.stopped,
      });
      return { action: "run", once: false, lockPath: lock.path, stopped: true };
    } finally {
      signals.dispose();
    }
  } finally {
    await lock.release();
  }
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

function limitEntries<T>(entries: T[], limit: number | undefined): T[] {
  if (!limit || limit < 0) return entries;
  return entries.slice(0, Math.floor(limit));
}
