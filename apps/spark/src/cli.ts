import {
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
  type SparkDaemonCliCommand,
} from "./cli/daemon.ts";
import { createSparkCliHostServices } from "./host/bootstrap.ts";
import { runNativeSparkTui } from "./native-tui.ts";

export interface SparkCliArgs {
  initialMessage?: string;
  help: boolean;
}

export type SparkCliCommand =
  | { kind: "help" }
  | { kind: "tui"; initialMessage?: string }
  | { kind: "daemon"; command: SparkDaemonCliCommand };

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
  const initialMessage = argv.join(" ").trim();
  return { kind: "tui", initialMessage: initialMessage || undefined };
}

export async function runSparkCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = parseSparkCliCommand(argv);
  switch (command.kind) {
    case "help":
      printHelp();
      return;
    case "daemon":
      await runSparkDaemonCliCommand(command.command);
      return;
    case "tui": {
      const services = await createSparkCliHostServices({ cwd: process.cwd(), hasUI: true });
      await runNativeSparkTui({ initialMessage: command.initialMessage, services });
      return;
    }
  }
}

function printHelp(): void {
  console.log(
    `spark - Spark-first native TUI host\n\nUsage:\n  spark [initial message]\n  spark daemon status [--json]\n  spark daemon enqueue --session <id> --prompt <text> [--json]\n  spark daemon queue [--state inbox|processed|failed|all] [--json]\n  spark daemon run [--once]\n  spark --help\n\nRuns a Spark-owned terminal UI by default. Daemon commands are local-only: no gateway/HTTP/service surface is provided.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSparkCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
