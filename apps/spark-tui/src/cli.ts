import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  attachSparkWorkspaceClient,
  createSparkDaemonNativeCommands,
  createSparkDaemonNativeResponder,
  handleSparkDaemonCliCommand,
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
  type SparkDaemonClientOptions,
  type SparkDaemonCliCommand,
} from "./cli/daemon.ts";
import { runNativeSparkTui } from "./native-tui.ts";

export interface SparkCliArgs {
  initialMessage?: string;
  help: boolean;
}

export type SparkCliCommand =
  | { kind: "help" }
  | { kind: "print"; prompt: string }
  | { kind: "tui"; initialMessage?: string }
  | { kind: "daemon"; command: SparkDaemonCliCommand };

export interface RunSparkCliOptions {
  daemonClient?: SparkDaemonClientOptions;
  runTui?: typeof runNativeSparkTui;
}

export function parseSparkCliArgs(argv: string[]): SparkCliArgs {
  if (argv.some((arg) => arg === "-h" || arg === "--help")) return { help: true };
  const initialMessage = argv.join(" ").trim();
  return { help: false, initialMessage: initialMessage || undefined };
}

export function parseSparkCliCommand(argv: string[]): SparkCliCommand {
  if (argv.length === 0) return { kind: "tui" };
  if (argv.some((arg) => arg === "-h" || arg === "--help") && argv[0] !== "daemon") {
    return { kind: "help" };
  }
  if (argv[0] === "daemon")
    return { kind: "daemon", command: parseSparkDaemonCliArgs(argv.slice(1)) };
  if (argv[0] === "-p" || argv[0] === "--print") {
    const prompt = argv.slice(1).join(" ").trim();
    if (!prompt) throw new Error("spark --print requires a prompt");
    return { kind: "print", prompt };
  }
  const initialMessage = argv.join(" ").trim();
  return { kind: "tui", initialMessage: initialMessage || undefined };
}

export async function runSparkCli(
  argv: string[] = process.argv.slice(2),
  options: RunSparkCliOptions = {},
): Promise<number> {
  const command = parseSparkCliCommand(argv);
  const daemonClient = options.daemonClient ?? {};
  switch (command.kind) {
    case "help":
      printHelp();
      return 0;
    case "daemon":
      return await runSparkDaemonCliCommand(command.command, undefined, daemonClient);
    case "print": {
      const lease = await attachSparkWorkspaceClient(daemonClient, {
        kind: "headless",
        displayName: "Spark headless submit",
        heartbeatIntervalMs: false,
      });
      try {
        const result = await handleSparkDaemonCliCommand(
          {
            action: "submit",
            json: true,
            sessionId: `spark-print-${Date.now().toString(36)}`,
            prompt: command.prompt,
          },
          daemonClient,
        );
        console.log(JSON.stringify(result, null, 2));
        return 0;
      } finally {
        await lease.release();
      }
    }
    case "tui": {
      const lease = await attachSparkWorkspaceClient(daemonClient, {
        kind: "interactive",
        displayName: "Spark TUI",
      });
      try {
        const runTui = options.runTui ?? runNativeSparkTui;
        await runTui({
          initialMessage: command.initialMessage,
          responder: createSparkDaemonNativeResponder(daemonClient),
          slashCommands: createSparkDaemonNativeCommands(daemonClient),
        });
        return 0;
      } finally {
        await lease.release();
      }
    }
  }
}

function printHelp(): void {
  console.log(
    `spark-tui - Spark terminal UI\n\nUsage:\n  spark-tui [initial message]\n  spark-tui --print <prompt>\n  spark-tui --help\n\nRuns terminal UI rendering by default, but all prompts are submitted to the Spark daemon over local IPC. Use the root "spark daemon ..." dispatcher path for daemon administration.`,
  );
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
  runSparkCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}
