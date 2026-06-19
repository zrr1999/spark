import {
  createSparkDaemonNativeResponder,
  handleSparkDaemonCliCommand,
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
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

export async function runSparkCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = parseSparkCliCommand(argv);
  switch (command.kind) {
    case "help":
      printHelp();
      return;
    case "daemon":
      await runSparkDaemonCliCommand(command.command);
      return;
    case "print": {
      const result = await handleSparkDaemonCliCommand({
        action: "submit",
        json: true,
        sessionId: `spark-print-${Date.now().toString(36)}`,
        prompt: command.prompt,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "tui": {
      await runNativeSparkTui({
        initialMessage: command.initialMessage,
        responder: createSparkDaemonNativeResponder(),
      });
      return;
    }
  }
}

function printHelp(): void {
  console.log(
    `spark - Spark daemon client\n\nUsage:\n  spark [initial message]\n  spark --print <prompt>\n  spark daemon status [--json]\n  spark daemon start [--json]\n  spark daemon submit --session <id> --prompt <text> [--json]\n  spark daemon queue [--state inbox|processed|failed|all] [--json]\n  spark --help\n\nRuns terminal UI rendering by default, but all prompts are submitted to the Spark daemon over local IPC.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSparkCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
