import { createInterface } from "node:readline/promises";
import { ensureSparkPathDirs, resolveSparkPaths } from "@zendev-lab/spark-system";
import { sparkDaemonCliStrings } from "@zendev-lab/spark-i18n/cli";
import { readSparkDaemonConfig } from "./config.js";
import {
  listSparkDaemonServerProfiles,
  sparkDaemonConfigForServerProfile,
} from "./server-profiles.js";
import {
  requestDaemonRestart,
  requestDaemonStop,
  requestDaemonStatus,
  requestTurnSubmit,
  requestWorkspaceAttach,
  requestWorkspaceList,
  requestWorkspaceRegister,
  requestWorkspaceRelocate,
  requestWorkspaceStop,
} from "./local-rpc.js";
import { hasRunnableSparkDaemonCredentialsForServer } from "./registration.js";
import { readRunningPid, startSparkDaemonService, stopSparkDaemonService } from "./service.js";

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdin?: NodeJS.ReadStream;
  startService?: typeof startSparkDaemonService;
  stopService?: typeof stopSparkDaemonService;
  daemonStatusFromService?: typeof requestDaemonStatus;
  daemonStopFromService?: typeof requestDaemonStop;
  daemonRestartFromService?: typeof requestDaemonRestart;
  turnSubmitToService?: typeof requestTurnSubmit;
  listWorkspacesFromService?: typeof requestWorkspaceList;
  registerWorkspaceInService?: typeof requestWorkspaceRegister;
  relocateWorkspaceInService?: typeof requestWorkspaceRelocate;
  attachWorkspaceInService?: typeof requestWorkspaceAttach;
  stopWorkspaceInService?: typeof requestWorkspaceStop;
  openExternal?: (url: string) => boolean;
  deviceAuthorizationSleep?: (delayMs: number) => Promise<void>;
}

export const defaultIo: CliIo = { stdout: process.stdout, stderr: process.stderr };
export const STRINGS = sparkDaemonCliStrings();

export class SparkDaemonUnavailableError extends Error {
  constructor(cause: unknown, options: { running?: boolean } = {}) {
    const prefix =
      options.running === false
        ? "Spark daemon could not be started"
        : "Spark daemon is running but cannot be reached";
    super(
      `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}. Run spark daemon status.`,
    );
  }
}

export class WorkspacePathValidationError extends Error {}

export function prepareSparkDaemonState(paths: ReturnType<typeof resolveSparkPaths>): void {
  ensureSparkPathDirs(paths);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startSparkDaemonProcess(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
): ReturnType<typeof startSparkDaemonService> {
  return (io.startService ?? startSparkDaemonService)(paths);
}

export function syncSparkDaemonIfConfigured(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
): void {
  const config = readSparkDaemonConfig(paths);
  const connectedProfile = listSparkDaemonServerProfiles(paths).some((profile) =>
    hasRunnableSparkDaemonCredentialsForServer(
      sparkDaemonConfigForServerProfile(config, profile),
      profile.serverUrl,
    ),
  );
  if (!connectedProfile) {
    io.stdout.write(
      "  sync     local only; run spark daemon login --server-url <url> to connect this machine to Spark Cockpit.\n",
    );
    return;
  }

  if (readRunningPid(paths) !== null) {
    io.stdout.write("  sync     Spark daemon is running.\n");
    return;
  }

  const service = startSparkDaemonProcess(paths, io);
  io.stdout.write(`  sync     ${service.detail}\n`);
}

export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

export function helpRequested(args: string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h" || arg === "help");
}

export function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith("--")) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }
    values.push(arg);
  }
  return values;
}

export async function confirmAction(
  io: CliIo,
  flags: Record<string, string>,
  question: string,
): Promise<boolean> {
  if (flags.yes === "true" || flags.y === "true") {
    return true;
  }

  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    io.stderr.write(`${question} Pass --yes to confirm in non-interactive environments.\n`);
    return false;
  }

  const prompt = createInterface({ input: stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} Type 'yes' to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

export function printDaemonHelp(io: CliIo): void {
  io.stdout.write(`Usage: spark daemon <command>

Commands:
  status [--json]
  start
  stop
  restart [--yes] [--wait]
  logs [--follow] [--lines <n>]
  submit --session <id> --prompt <text> [--idempotency-key <key>] [--json]

Example:
  spark daemon status --json
`);
}

export function printHelp(io: CliIo): void {
  io.stdout.write(`Usage: spark daemon <command>

Commands:
  spark daemon
  spark daemon --workspace <id>
  login --server-url <url> [--no-open] [--allow-insecure-http]
  workspace register [path] --server-url <url> --token <workspace-registration-token|-> --name <name> [--profile <path-or-git-url>] [--allow-insecure-http]
  workspace relocate --to-server-url <https-origin> [--from-server-url <origin>] [--yes] [--json]
  workspace ls [--json] [--all] [--full]
  workspace show [id] [--workspace <id>] [--json]
  workspace stop <id> [--workspace <id>] [--yes]
  uplink park --server-url <origin>
  uplink unpark --server-url <origin>
  uplink prefer --workspace <id> --server-url <origin>
  uplink status [--json]
  ws
  status
  start
  stop
  restart [--yes] [--wait]
  logs

Workspace registration may print a one-time browser key. Mint additional keys on the
Cockpit host with spark cockpit workspace access create --workspace <id>.
Workspace markers use id; name is display-only.

Example:
  spark daemon login --server-url http://127.0.0.1:5173
  spark daemon workspace register . --server-url http://127.0.0.1:5173 --token <workspace-token> --name <ws>
  spark daemon uplink park --server-url https://prod.example/
  spark daemon uplink prefer --workspace rtwb_… --server-url http://127.0.0.1:5173/
`);
}

export function printWorkspaceHelp(io: CliIo): void {
  io.stdout.write(`Usage: spark daemon workspace <command>

Commands:
  register [path] --server-url <url> --token <workspace-registration-token|-> --name <name> [--profile <path-or-git-url>] [--allow-insecure-http]
  relocate --to-server-url <https-origin> [--from-server-url <origin>] [--yes] [--json]
  ls [--json] [--all] [--full]
  show [id] [--workspace <id>] [--json]
  stop <id> [--workspace <id>] [--yes]

Registration may print a one-time browser key for /{slug}/login.
Mint additional keys on the Cockpit host (workspace id is the marker):
  spark cockpit workspace access create|list|revoke --workspace <id>
Name is display-only; prefer --workspace <id> for commands.

Example:
  spark daemon workspace ls --json
`);
}

export function printLoginHelp(io: CliIo): void {
  io.stdout.write(`Usage: spark daemon login --server-url <url> [--no-open] [--allow-insecure-http]

Authorize this daemon machine in Spark Cockpit. The stored machine credential is
only for connectivity and refresh. Every workspace registration still consumes
a fresh one-time workspace registration token.
Non-loopback Cockpit URLs require HTTPS unless --allow-insecure-http is supplied.
`);
}

export function printUplinkHelp(io: CliIo): void {
  io.stdout.write(`Usage: spark daemon uplink <command>

Commands:
  park --server-url <origin>
  unpark --server-url <origin>
  prefer --workspace <id> --server-url <origin> [--force]
    Rebind a workspace onto another origin. If interactive sessions occupy it,
    prompt them and auto-authorize after 30s unless --force skips consent.
  status [--json]

Park stops dialing an origin without deleting credentials. Prefer rebinds one
workspace onto another already-registered origin (temporary borrow). Never uses
relocate/preflight.
`);
}

export async function readStdinLine(io: CliIo, name: string): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  const prompt = createInterface({ input: stdin, crlfDelay: Infinity });
  try {
    const { value: line, done } = await prompt[Symbol.asyncIterator]().next();
    if (done) {
      throw new Error(`Missing ${name} on stdin.`);
    }
    const value = line.trim();
    if (!value) {
      throw new Error(`Empty ${name} from stdin.`);
    }
    return value;
  } finally {
    prompt.close();
  }
}

export async function promptSecret(io: CliIo, label: string): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    throw new Error(`Missing ${label}.`);
  }

  const setRawMode = (stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void })
    .setRawMode;
  if (typeof setRawMode !== "function") {
    return promptRequired(io, label);
  }

  process.stdout.write(`${label}: `);
  return await new Promise<string>((resolvePromise, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      setRawMode.call(stdin, false);
      process.stdout.write("\n");
    };
    const finish = () => {
      cleanup();
      if (!value.trim()) {
        reject(new Error(`${capitalize(label)} is required.`));
        return;
      }
      resolvePromise(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error(`${capitalize(label)} entry cancelled.`));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += char;
        process.stdout.write("*");
      }
    };

    setRawMode.call(stdin, true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

export async function promptRequired(io: CliIo, label: string): Promise<string> {
  return promptWithDefault(io, label, undefined);
}

export async function promptWithDefault(
  io: CliIo,
  label: string,
  defaultValue: string | undefined,
): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    throw new Error(`Missing ${label}.`);
  }

  const prompt = createInterface({ input: stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await prompt.question(`${label}${suffix}: `);
    const value = answer.trim() || defaultValue;
    if (!value) {
      throw new Error(`${capitalize(label)} is required.`);
    }
    return value;
  } finally {
    prompt.close();
  }
}

export function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function resolveInvocationCwd(): string {
  return process.env.SPARK_DAEMON_CWD ?? process.env.INIT_CWD ?? process.cwd();
}
