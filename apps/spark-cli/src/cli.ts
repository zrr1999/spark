import { spawn, type SpawnOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SPARK_CLI_VERSION = "0.1.0";

export type SparkDispatcherCommand =
  | { kind: "dispatch"; executable: "spark-tui" | "spark-daemon"; argv: string[] }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export interface SparkDispatcherIo {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

export interface SparkDispatcherRunner {
  run(executable: string, argv: string[], options: SpawnOptions): Promise<number>;
}

export function parseSparkDispatcherArgs(argv: string[]): SparkDispatcherCommand {
  const [first, ...rest] = argv;
  if (!first) return { kind: "dispatch", executable: "spark-tui", argv: [] };
  if (first === "help" || first === "--help" || first === "-h") return { kind: "help" };
  if (first === "version" || first === "--version" || first === "-v") return { kind: "version" };
  if (first === "tui") return { kind: "dispatch", executable: "spark-tui", argv: rest };
  if (first === "daemon") return { kind: "dispatch", executable: "spark-daemon", argv: rest };
  if (first === "--print" || first === "-p") {
    return { kind: "dispatch", executable: "spark-tui", argv };
  }
  return {
    kind: "error",
    message: `Unknown spark subcommand: ${first}\nRun "spark --help" for available subcommands. Use "spark tui ${argv.join(" ")}" to send text to the interactive TUI.`,
  };
}

export async function runSparkDispatcher(
  argv: string[] = process.argv.slice(2),
  io: SparkDispatcherIo = {},
  runner: SparkDispatcherRunner = defaultRunner,
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
      return await runner.run(command.executable, command.argv, { stdio: "inherit" });
  }
}

export function helpText(): string {
  return `spark - Spark command dispatcher\n\nUsage:\n  spark\n  spark tui [initial message]\n  spark --print <prompt>\n  spark daemon <command> [args...]\n  spark --help\n  spark --version\n\nDispatches to dedicated executables:\n  spark tui      -> spark-tui\n  spark daemon   -> spark-daemon\n\nUnknown subcommands fail loudly instead of being interpreted as prompts. Use "spark tui ..." for interactive TUI input.\n`;
}

const defaultRunner: SparkDispatcherRunner = {
  run(executable, argv, options) {
    return new Promise((resolve) => {
      const child = spawn(executable, argv, options);
      child.on("error", (error: NodeJS.ErrnoException) => {
        const detail = error.code === "ENOENT" ? "executable was not found on PATH" : error.message;
        process.stderr.write(`Unable to dispatch to ${executable}: ${detail}\n`);
        resolve(error.code === "ENOENT" ? 127 : 1);
      });
      child.on("close", (code, signal) => {
        if (signal) {
          process.stderr.write(`${executable} exited due to signal ${signal}\n`);
          resolve(1);
          return;
        }
        resolve(code ?? 1);
      });
    });
  },
};

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
