import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sparkCliDispatcherStrings } from "@zendev-lab/spark-i18n/cli";

export const SPARK_CLI_VERSION = "0.1.0";

const dispatcherStrings = sparkCliDispatcherStrings();

export type SparkDispatcherTarget = "tui" | "daemon" | "server" | "cockpit";

export type SparkDispatcherCommand =
  | { kind: "dispatch"; target: SparkDispatcherTarget; argv: string[] }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

type SparkDispatcherOutput = Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
type SparkDispatcherInput = { isTTY?: boolean };

export interface SparkDispatcherIo {
  stdin?: SparkDispatcherInput;
  stdout?: SparkDispatcherOutput;
  stderr?: SparkDispatcherOutput;
}

export interface SparkDispatcherLauncher {
  run(target: SparkDispatcherTarget, argv: string[], options: SpawnOptions): Promise<number>;
}

export function parseSparkDispatcherArgs(argv: string[]): SparkDispatcherCommand {
  const [first, ...rest] = argv;
  if (!first) return { kind: "dispatch", target: "tui", argv: [] };
  if (first === "help" || first === "--help" || first === "-h") return { kind: "help" };
  if (first === "version" || first === "--version" || first === "-v") return { kind: "version" };
  if (first === "tui") return { kind: "dispatch", target: "tui", argv: rest };
  if (first === "daemon") return { kind: "dispatch", target: "daemon", argv: rest };
  if (first === "server") return { kind: "dispatch", target: "server", argv: rest };
  if (first === "cockpit") return { kind: "dispatch", target: "cockpit", argv: rest };
  if (first === "sessions" || first === "session") {
    return { kind: "dispatch", target: "tui", argv };
  }
  if (isSparkTuiCompatibilityCommand(first)) return { kind: "dispatch", target: "tui", argv };
  return {
    kind: "error",
    message: dispatcherStrings.unknownSubcommand(first, argv),
  };
}

export async function runSparkDispatcher(
  argv: string[] = process.argv.slice(2),
  io: SparkDispatcherIo = {},
  launcher: SparkDispatcherLauncher = defaultLauncher,
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const command = parseSparkDispatcherArgs(argv);
  switch (command.kind) {
    case "help":
      stdout.write(helpText());
      return 0;
    case "version":
      stdout.write(`${SPARK_CLI_VERSION}\n`);
      return 0;
    case "error":
      stderr.write(`${command.message}\n`);
      return 2;
    case "dispatch":
      if (
        command.target === "tui" &&
        !isSparkTuiHeadlessCompatibilityCommand(command.argv) &&
        !isInteractiveTerminal(io)
      ) {
        stderr.write(`${dispatcherStrings.tuiRequiresTty}\n`);
        return 2;
      }
      return await launcher.run(command.target, command.argv, { stdio: "inherit" });
  }
}

export function helpText(): string {
  return dispatcherStrings.helpText;
}

function isSparkTuiCompatibilityCommand(first: string): boolean {
  return (
    first === "--print" ||
    first === "-p" ||
    first === "--mode" ||
    first === "--list-models" ||
    isSparkTuiResourceCommand(first)
  );
}

function isSparkTuiResourceCommand(first: string): boolean {
  return (
    first === "install" ||
    first === "remove" ||
    first === "uninstall" ||
    first === "update" ||
    first === "list" ||
    first === "config"
  );
}

function isSparkTuiHeadlessCompatibilityCommand(argv: readonly string[]): boolean {
  if (
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv.includes("--print") ||
    argv.includes("-p") ||
    argv.includes("--list-models")
  ) {
    return true;
  }
  const first = argv[0];
  if (first && isSparkTuiResourceCommand(first)) return true;
  if (first === "sessions" || first === "session") return true;
  return argv.some((arg, index) => arg === "--mode" && argv[index + 1] === "rpc");
}

function isInteractiveTerminal(io: SparkDispatcherIo): boolean {
  return Boolean(
    (io.stdin?.isTTY ?? process.stdin.isTTY) && (io.stdout?.isTTY ?? process.stdout.isTTY),
  );
}

const defaultLauncher: SparkDispatcherLauncher = {
  run(target, argv, options) {
    return new Promise((resolve) => {
      const command = resolveTargetCommand(target);
      const child = spawn(command.command, [...command.args, ...argv], options);
      child.on("error", (error: NodeJS.ErrnoException) => {
        const detail = error.code === "ENOENT" ? "executable was not found on PATH" : error.message;
        process.stderr.write(`${dispatcherStrings.dispatchFailure(command.label, detail)}\n`);
        resolve(error.code === "ENOENT" ? 127 : 1);
      });
      child.on("close", (code, signal) => {
        if (signal) {
          process.stderr.write(`${dispatcherStrings.signalExit(command.label, signal)}\n`);
          resolve(1);
          return;
        }
        resolve(code ?? 1);
      });
    });
  },
};

export function resolveTargetCommand(target: SparkDispatcherTarget): {
  command: string;
  args: string[];
  label: string;
} {
  const local = localTargetCommand(target);
  if (local && existsSync(local)) {
    return {
      command: local,
      args: target === "server" ? ["server"] : target === "daemon" ? ["daemon"] : [],
      label: targetLabel(target),
    };
  }
  switch (target) {
    case "tui":
      return { command: "spark-tui", args: [], label: targetLabel(target) };
    case "daemon":
      // Route the public daemon execution-plane API through spark-tui's CLI
      // adapter. The adapter delegates legacy daemon service commands
      // (status/start/stop/logs/workspace) while also owning canonical
      // session/run/events plane resources.
      return { command: "spark-tui", args: ["daemon"], label: targetLabel(target) };
    case "server":
      return { command: "spark-tui", args: ["server"], label: targetLabel(target) };
    case "cockpit":
      return { command: "spark-cockpit", args: [], label: targetLabel(target) };
  }
}

function targetLabel(target: SparkDispatcherTarget): string {
  return dispatcherStrings.targetLabel(target);
}

function localTargetCommand(target: SparkDispatcherTarget): string | undefined {
  switch (target) {
    case "tui":
      return fileURLToPath(new URL("../../spark-tui/bin/spark-tui", import.meta.url));
    case "daemon":
      return fileURLToPath(new URL("../../spark-tui/bin/spark-tui", import.meta.url));
    case "server":
      return fileURLToPath(new URL("../../spark-tui/bin/spark-tui", import.meta.url));
    case "cockpit":
      return fileURLToPath(new URL("../../spark-cockpit/bin/spark-cockpit", import.meta.url));
  }
}

function isDirectRun(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runSparkDispatcher()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}
