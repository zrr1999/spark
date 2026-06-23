import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SPARK_CLI_VERSION = "0.1.0";

export type SparkDispatcherTarget = "tui" | "daemon";

export type SparkDispatcherCommand =
  | { kind: "dispatch"; target: SparkDispatcherTarget; argv: string[] }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export interface SparkDispatcherIo {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
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
  if (first === "--print" || first === "-p") {
    return { kind: "dispatch", target: "tui", argv };
  }
  return {
    kind: "error",
    message: `Unknown spark subcommand: ${first}\nRun "spark --help" for available subcommands. Use "spark tui ${argv.join(" ")}" to send text to the interactive TUI.`,
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
      return await launcher.run(command.target, command.argv, { stdio: "inherit" });
  }
}

export function helpText(): string {
  return `spark - Spark command dispatcher\n\nUsage:\n  spark\n  spark tui [initial message]\n  spark --print <prompt>\n  spark daemon <command> [args...]\n  spark --help\n  spark --version\n\nDispatches to Spark surfaces:\n  spark tui      interactive terminal UI\n  spark daemon   daemon administration\n\nUnknown subcommands fail loudly instead of being interpreted as prompts. Use "spark tui ..." for interactive TUI input.\n`;
}

const defaultLauncher: SparkDispatcherLauncher = {
  run(target, argv, options) {
    return new Promise((resolve) => {
      const command = resolveTargetCommand(target);
      const child = spawn(command.command, [...command.args, ...argv], options);
      child.on("error", (error: NodeJS.ErrnoException) => {
        const detail = error.code === "ENOENT" ? "executable was not found on PATH" : error.message;
        process.stderr.write(`Unable to dispatch to ${command.label}: ${detail}\n`);
        resolve(error.code === "ENOENT" ? 127 : 1);
      });
      child.on("close", (code, signal) => {
        if (signal) {
          process.stderr.write(`${command.label} exited due to signal ${signal}\n`);
          resolve(1);
          return;
        }
        resolve(code ?? 1);
      });
    });
  },
};

function resolveTargetCommand(target: SparkDispatcherTarget): {
  command: string;
  args: string[];
  label: string;
} {
  const local = localTargetCommand(target);
  if (local && existsSync(local)) {
    return { command: local, args: [], label: targetLabel(target) };
  }
  switch (target) {
    case "tui":
      return { command: "spark-tui", args: [], label: targetLabel(target) };
    case "daemon":
      // Package-bin fallback for installed layouts where the daemon package is
      // resolved by the package manager. The public/operator surface remains
      // the parent `spark daemon ...` command group.
      return { command: "spark-daemon", args: [], label: targetLabel(target) };
  }
}

function targetLabel(target: SparkDispatcherTarget): string {
  return target === "daemon" ? "spark daemon" : "spark tui";
}

function localTargetCommand(target: SparkDispatcherTarget): string | undefined {
  switch (target) {
    case "tui":
      return fileURLToPath(new URL("../../spark-tui/bin/spark-tui", import.meta.url));
    case "daemon":
      return fileURLToPath(new URL("../../spark-daemon/dist/cli.js", import.meta.url));
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
