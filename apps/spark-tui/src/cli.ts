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
import {
  createSparkNativeRuntimeSlashCommands,
  createSparkNativeUiTransport,
  runNativeSparkTui,
  type SparkNativeSlashCommandMap,
} from "./native-tui.ts";
import {
  createSparkCliHostServices,
  formatSparkModelSelection,
  registerSparkSessionsCommand,
  type SparkActiveSelection,
  type SparkCliHostServices,
  type SparkCliHostServicesOptions,
  type SparkModelPickerState,
} from "./host/index.ts";
import {
  createSparkModelPickerFromCustomUi,
  type SparkModelSelectorCustomUi,
} from "./tui/model-selector.ts";

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
  createHostServices?: (options?: SparkCliHostServicesOptions) => Promise<SparkCliHostServices>;
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
        const createHostServices = options.createHostServices ?? createSparkCliHostServices;
        let pendingNativeUiTransport: ReturnType<typeof createSparkNativeUiTransport> | undefined;
        const services = await createHostServices({
          hasUI: true,
          modelPicker: (state, ctx) =>
            pendingNativeUiTransport
              ? createSparkModelPickerFromCustomUi(
                  pendingNativeUiTransport as SparkModelSelectorCustomUi,
                )(state, ctx)
              : undefined,
        });
        registerSparkSessionsCommand(services.runtime, {
          store: services.sessionStore,
          getNavigationState: () => undefined,
        });
        registerSparkNativeModelCommand(services);
        const runTui = options.runTui ?? runNativeSparkTui;
        await runTui({
          initialMessage: command.initialMessage,
          responder: createSparkDaemonNativeResponder(daemonClient),
          slashCommands: createSparkNativeSlashCommands(services, daemonClient),
          autocompleteBasePath: services.cwd,
          keybindings: services.keybindings,
          messageRenderers: new Map(
            services.runtime
              .listMessageRenderers()
              .map(({ customType, renderer }) => [customType, renderer]),
          ),
          configureApp: async (app, session) => {
            pendingNativeUiTransport = createSparkNativeUiTransport(app, session);
            services.runtime.setUiTransport(pendingNativeUiTransport);
            await services.runtime.emit("session_start", { source: "native-tui" });
          },
        });
        return 0;
      } finally {
        await lease.release();
      }
    }
  }
}

const NATIVE_SLASH_COMMAND_EXCLUSIONS = [
  "help",
  "clear",
  "stop",
  "retry",
  "cockpit",
  "workflows",
  "runs",
  "tasks",
  "artifacts",
  "evidence",
  "reviews",
  "graft",
  "exit",
  "quit",
] as const;

function registerSparkNativeModelCommand(services: SparkCliHostServices): void {
  if (services.runtime.getCommand("model")) return;
  services.runtime.registerCommand("model", {
    description: "Switch or inspect the active Spark model",
    argumentHint: "[provider/model|model-id]",
    getArgumentCompletions: (prefix) => modelArgumentCompletions(services, prefix),
    async handler(args, ctx) {
      const selection = await handleSparkNativeModelCommand(services, args);
      ctx.ui?.notify?.(formatSparkModelSelection(selection), "info");
    },
  });
}

async function handleSparkNativeModelCommand(
  services: SparkCliHostServices,
  args: string,
): Promise<SparkActiveSelection> {
  const query = args.trim();
  if (query) return await services.modelSelector.select(resolveSparkModelArgument(services, query));
  const picked = await services.modelSelector.openPicker({ hasUI: true });
  const active = picked ?? services.modelSelector.getActive();
  if (!active) throw new Error("No Spark provider/model is registered yet.");
  return active;
}

function resolveSparkModelArgument(
  services: SparkCliHostServices,
  query: string,
): SparkActiveSelection {
  const slash = query.indexOf("/");
  if (slash > 0) {
    return { providerName: query.slice(0, slash), modelId: query.slice(slash + 1) };
  }
  const active = services.modelSelector.getActive();
  if (
    active &&
    services.providerRegistry.listModelsFor(active.providerName).some((model) => model.id === query)
  ) {
    return { providerName: active.providerName, modelId: query };
  }
  const matches = services.providerRegistry
    .listProviders()
    .filter((provider) => provider.models.some((model) => model.id === query));
  if (matches.length === 1) return { providerName: matches[0]!.name, modelId: query };
  if (matches.length > 1) throw new Error(`Ambiguous model id "${query}"; use provider/model.`);
  throw new Error(`Unknown Spark model: ${query}`);
}

function modelArgumentCompletions(
  services: SparkCliHostServices,
  prefix: string,
): Array<{ value: string; label: string; description?: string }> {
  const normalized = prefix.trim().toLowerCase();
  return modelCompletionItems(services.modelSelector.getPickerState())
    .filter((item) =>
      [item.value, item.label, item.description ?? ""].some((text) =>
        text.toLowerCase().includes(normalized),
      ),
    )
    .slice(0, 25);
}

function modelCompletionItems(
  state: SparkModelPickerState,
): Array<{ value: string; label: string; description?: string }> {
  return state.items.flatMap((item) => {
    const full = `${item.providerName}/${item.modelId}`;
    const label = `${full}${item.active ? " (active)" : ""}`;
    const entries = [{ value: full, label, description: item.description }];
    const duplicateId = state.items.some(
      (other) => other !== item && other.modelId === item.modelId,
    );
    if (!duplicateId)
      entries.push({ value: item.modelId, label: item.modelLabel, description: full });
    return entries;
  });
}

function createSparkNativeSlashCommands(
  services: SparkCliHostServices,
  daemonClient: SparkDaemonClientOptions,
): SparkNativeSlashCommandMap {
  registerSparkNativeModelCommand(services);
  const daemonCommands = createSparkDaemonNativeCommands(daemonClient);
  const commandSessionId = `spark-native-command-${Date.now().toString(36)}`;
  const runtimeCommands = createSparkNativeRuntimeSlashCommands(services.runtime, {
    exclude: [...NATIVE_SLASH_COMMAND_EXCLUSIONS, ...Object.keys(daemonCommands)],
    sendUserMessage: async (content) => {
      const prompt = content.trim();
      if (!prompt) return;
      await handleSparkDaemonCliCommand(
        {
          action: "submit",
          json: true,
          sessionId: commandSessionId,
          prompt,
        },
        daemonClient,
      );
    },
  });
  return { ...runtimeCommands, ...daemonCommands };
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
