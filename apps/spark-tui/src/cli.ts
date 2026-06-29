import { realpathSync } from "node:fs";
import { stdin as processStdin } from "node:process";
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
  createSparkPiParitySlashCommands,
  PI_PARITY_COMMAND_NAMES,
} from "./cli/pi-parity-commands.ts";
import { createSparkPromptTemplateSlashCommands } from "./cli/prompt-template-commands.ts";
import {
  formatSparkResourceResult,
  runSparkResourceCommand,
  type SparkResourceKind,
} from "./cli/resource-manager.ts";
import {
  createSparkCliHostServices,
  formatSparkModelSelection,
  loadSparkConfig,
  registerSparkSessionsCommand,
  resolveSparkModelSelectionById,
  type SparkActiveSelection,
  type SparkCliHostServices,
  type SparkCliHostServicesOptions,
  type SparkConfig,
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

export type SparkCliMode = "text" | "json" | "rpc";

export interface SparkCliRuntimeOptions {
  mode?: SparkCliMode;
  provider?: string;
  model?: string;
  session?: string;
  sessionId?: string;
  sessionDir?: string;
  noSession?: boolean;
  name?: string;
  extensions?: string[];
  noExtensions?: boolean;
  skills?: string[];
  noSkills?: boolean;
  promptTemplates?: string[];
  noPromptTemplates?: boolean;
  themes?: string[];
  noThemes?: boolean;
  noContextFiles?: boolean;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  excludeTools?: string[];
  projectTrustOverride?: boolean;
  fileArgs?: string[];
}

export type SparkCliCommand =
  | { kind: "help" }
  | { kind: "print"; prompt: string; mode?: "text" | "json"; options?: SparkCliRuntimeOptions }
  | { kind: "rpc"; options?: SparkCliRuntimeOptions }
  | { kind: "list-models"; query?: string; options?: SparkCliRuntimeOptions }
  | {
      kind: "resources";
      action: "install" | "remove" | "update" | "list" | "config";
      source?: string;
      resourceKind?: SparkResourceKind;
      local?: boolean;
      json?: boolean;
    }
  | { kind: "tui"; initialMessage?: string; options?: SparkCliRuntimeOptions }
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

  const resource = parseSparkResourceCliCommand(argv);
  if (resource) return resource;

  const parsed = parseSparkPiCompatibleOptions(argv);
  const options = compactRuntimeOptions(parsed.options);
  if (parsed.listModels !== undefined) {
    return {
      kind: "list-models",
      ...(parsed.listModels ? { query: parsed.listModels } : {}),
      ...(options ? { options } : {}),
    };
  }
  if (parsed.options.mode === "rpc") return { kind: "rpc", ...(options ? { options } : {}) };
  if (parsed.print) {
    const prompt = parsed.messages.join(" ").trim();
    if (!prompt) throw new Error("spark --print requires a prompt");
    return {
      kind: "print",
      prompt,
      ...(parsed.options.mode === "json" || parsed.options.mode === "text"
        ? { mode: parsed.options.mode }
        : {}),
      ...(options ? { options } : {}),
    };
  }
  const initialMessage = parsed.messages.join(" ").trim();
  return {
    kind: "tui",
    ...(initialMessage ? { initialMessage } : {}),
    ...(options ? { options } : {}),
  };
}

interface ParsedSparkPiOptions {
  print: boolean;
  listModels?: string;
  messages: string[];
  options: SparkCliRuntimeOptions;
}

function parseSparkResourceCliCommand(argv: string[]): SparkCliCommand | undefined {
  const [actionToken, ...rest] = argv;
  if (
    actionToken !== "install" &&
    actionToken !== "remove" &&
    actionToken !== "uninstall" &&
    actionToken !== "update" &&
    actionToken !== "list" &&
    actionToken !== "config"
  ) {
    return undefined;
  }
  let resourceKind: SparkResourceKind | undefined;
  let json = false;
  let local = false;
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--provider") {
      resourceKind = "provider";
      continue;
    }
    if (arg === "--skill") {
      resourceKind = "skill";
      continue;
    }
    if (arg === "--prompt-template") {
      resourceKind = "prompt-template";
      continue;
    }
    if (arg === "--theme") {
      resourceKind = "theme";
      continue;
    }
    if (arg === "--extension") {
      resourceKind = "extension";
      continue;
    }
    if (arg === "--local" || arg === "-l") {
      local = true;
      continue;
    }
    positionals.push(arg);
  }
  const action = actionToken === "uninstall" ? "remove" : actionToken;
  return {
    kind: "resources",
    action,
    ...(positionals[0] ? { source: positionals[0] } : {}),
    ...(resourceKind ? { resourceKind } : {}),
    ...(local ? { local } : {}),
    ...(json ? { json } : {}),
  };
}

function parseSparkPiCompatibleOptions(argv: string[]): ParsedSparkPiOptions {
  const messages: string[] = [];
  const options: SparkCliRuntimeOptions = {};
  let print = false;
  let listModels: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--mode":
        options.mode = readMode(argv[++index]);
        break;
      case "--provider":
        options.provider = readRequired(argv, ++index, arg);
        break;
      case "--model":
        options.model = readRequired(argv, ++index, arg);
        break;
      case "--session":
        options.session = readRequired(argv, ++index, arg);
        break;
      case "--session-id":
        options.sessionId = readRequired(argv, ++index, arg);
        break;
      case "--session-dir":
        options.sessionDir = readRequired(argv, ++index, arg);
        break;
      case "--no-session":
        options.noSession = true;
        break;
      case "--name":
      case "-n":
        options.name = readRequired(argv, ++index, arg);
        break;
      case "--extension":
      case "-e":
        (options.extensions ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-extensions":
      case "-ne":
        options.noExtensions = true;
        break;
      case "--skill":
        (options.skills ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-skills":
      case "-ns":
        options.noSkills = true;
        break;
      case "--prompt-template":
        (options.promptTemplates ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-prompt-templates":
      case "-np":
        options.noPromptTemplates = true;
        break;
      case "--theme":
        (options.themes ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-themes":
        options.noThemes = true;
        break;
      case "--no-context-files":
      case "-nc":
        options.noContextFiles = true;
        break;
      case "--thinking":
        options.thinking = readThinkingLevel(argv[++index]);
        break;
      case "--tools":
      case "-t":
        options.tools = splitCsv(readRequired(argv, ++index, arg));
        break;
      case "--exclude-tools":
      case "-xt":
        options.excludeTools = splitCsv(readRequired(argv, ++index, arg));
        break;
      case "--approve":
      case "-a":
        options.projectTrustOverride = true;
        break;
      case "--no-approve":
      case "-na":
        options.projectTrustOverride = false;
        break;
      case "--print":
      case "-p":
        print = true;
        break;
      case "--list-models": {
        const next = argv[index + 1];
        if (next && !next.startsWith("-") && !next.startsWith("@")) {
          listModels = next;
          index += 1;
        } else {
          listModels = "";
        }
        break;
      }
      default:
        if (arg.startsWith("@")) {
          (options.fileArgs ??= []).push(arg.slice(1));
        } else if (arg.startsWith("-")) {
          throw new Error(`Unknown spark option: ${arg}`);
        } else {
          messages.push(arg);
        }
    }
  }
  return { print, messages, options, ...(listModels !== undefined ? { listModels } : {}) };
}

function compactRuntimeOptions(
  options: SparkCliRuntimeOptions,
): SparkCliRuntimeOptions | undefined {
  return Object.values(options).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  )
    ? options
    : undefined;
}

function readRequired(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readMode(value: string | undefined): SparkCliMode {
  if (value === "text" || value === "json" || value === "rpc") return value;
  throw new Error(`--mode must be text, json, or rpc`);
}

function readThinkingLevel(
  value: string | undefined,
): NonNullable<SparkCliRuntimeOptions["thinking"]> {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error("--thinking must be off, minimal, low, medium, high, or xhigh");
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
    case "resources": {
      const result = await runSparkResourceCommand(command.action, command.source, {
        kind: command.resourceKind,
        local: command.local,
      });
      console.log(
        command.json ? JSON.stringify(result, null, 2) : formatSparkResourceResult(result),
      );
      return 0;
    }
    case "list-models": {
      const createHostServices = options.createHostServices ?? createSparkCliHostServices;
      const services = await createHostServices(
        await hostServiceOptionsFromRuntime(command.options),
      );
      console.log(formatSparkModelList(services, command.query));
      return 0;
    }
    case "rpc":
      await runSparkRpcMode(daemonClient, command.options);
      return 0;
    case "print": {
      const sessionId =
        command.options?.sessionId ??
        command.options?.session ??
        `spark-print-${Date.now().toString(36)}`;
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
            sessionId,
            prompt: command.prompt,
            reset: command.options?.noSession,
          },
          daemonClient,
        );
        if (command.mode === "json") printSparkJsonEventStream(command.prompt, sessionId, result);
        else console.log(JSON.stringify(result, null, 2));
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
          ...(await hostServiceOptionsFromRuntime(command.options)),
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
          theme: services.theme,
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
    argumentHint: "[model-id]",
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
  if (!active) throw new Error("No Spark model is registered yet.");
  return active;
}

function resolveSparkModelArgument(
  services: SparkCliHostServices,
  query: string,
): SparkActiveSelection {
  return resolveSparkModelSelectionById(services.providerRegistry, query);
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
  return state.items.map((item) => ({
    value: item.value,
    label: `${item.modelLabel}${item.active ? " (active)" : ""}`,
    description: item.description,
  }));
}

function createSparkNativeSlashCommands(
  services: SparkCliHostServices,
  daemonClient: SparkDaemonClientOptions,
): SparkNativeSlashCommandMap {
  registerSparkNativeModelCommand(services);
  const daemonCommands = createSparkDaemonNativeCommands(daemonClient);
  const piParityCommands = createSparkPiParitySlashCommands(services);
  const commandSessionId = `spark-native-command-${Date.now().toString(36)}`;
  const runtimeCommands = createSparkNativeRuntimeSlashCommands(services.runtime, {
    exclude: [
      ...NATIVE_SLASH_COMMAND_EXCLUSIONS,
      ...Object.keys(daemonCommands),
      ...PI_PARITY_COMMAND_NAMES,
    ],
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
  const promptTemplateCommands = createSparkPromptTemplateSlashCommands(services, {
    reservedNames: [
      ...NATIVE_SLASH_COMMAND_EXCLUSIONS,
      ...Object.keys(runtimeCommands),
      ...Object.keys(daemonCommands),
      ...Object.keys(piParityCommands),
    ],
  });
  return { ...runtimeCommands, ...daemonCommands, ...piParityCommands, ...promptTemplateCommands };
}

async function hostServiceOptionsFromRuntime(
  options: SparkCliRuntimeOptions | undefined,
): Promise<SparkCliHostServicesOptions> {
  if (!options) return {};
  const config = await configFromRuntimeOptions(options);
  return {
    ...(config ? { config } : {}),
    ...(options.sessionDir ? { sparkHome: options.sessionDir } : {}),
    ...(options.noPromptTemplates ? { noPromptTemplates: true } : {}),
  };
}

async function configFromRuntimeOptions(
  options: SparkCliRuntimeOptions,
): Promise<SparkConfig | undefined> {
  const needsConfig = Boolean(
    options.provider ||
    options.model ||
    options.thinking ||
    options.extensions?.length ||
    options.noExtensions ||
    options.skills?.length ||
    options.noSkills ||
    options.promptTemplates?.length ||
    options.noPromptTemplates ||
    options.themes?.length ||
    options.noThemes,
  );
  if (!needsConfig) return undefined;
  const config = await loadSparkConfig();
  if (options.provider && options.model) {
    config.activeModelId = `${options.provider}/${options.model}`;
    delete config.activeProvider;
    delete config.activeModel;
  } else if (options.model) {
    config.activeModelId = options.model;
    delete config.activeProvider;
    delete config.activeModel;
  } else if (options.provider) {
    config.activeProvider = options.provider;
  }
  if (options.thinking) config.activeThinkingLevel = options.thinking;
  if (options.noExtensions) config.extensions = [];
  if (options.extensions?.length)
    config.extensions = appendUnique(config.extensions, options.extensions);
  if (options.noSkills) config.skills = [];
  if (options.skills?.length) config.skills = appendUnique(config.skills ?? [], options.skills);
  if (options.noPromptTemplates) config.promptTemplates = [];
  if (options.promptTemplates?.length)
    config.promptTemplates = appendUnique(config.promptTemplates ?? [], options.promptTemplates);
  if (options.noThemes) config.themes = [];
  if (options.themes?.length) config.themes = appendUnique(config.themes ?? [], options.themes);
  return config;
}

function appendUnique(existing: string[], additions: readonly string[]): string[] {
  return [...new Set([...existing, ...additions])];
}

function formatSparkModelList(services: SparkCliHostServices, query: string | undefined): string {
  const normalized = query?.toLowerCase();
  const rows = services.modelSelector
    .getPickerState()
    .items.filter((item) =>
      normalized
        ? `${item.value} ${item.modelId} ${item.modelLabel} ${item.description}`
            .toLowerCase()
            .includes(normalized)
        : true,
    );
  if (rows.length === 0)
    return query ? `No Spark models matching ${query}` : "No Spark models registered";
  return rows
    .map((row) => {
      const marker = row.active ? "*" : " ";
      return `${marker} ${row.value} — ${row.modelLabel} (${row.description})`;
    })
    .join("\n");
}

function printSparkJsonEventStream(
  prompt: string,
  sessionId: string,
  result: unknown,
  assistantText = "Spark daemon accepted the headless prompt.",
): void {
  const timestamp = new Date().toISOString();
  const lines = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: process.cwd() },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "queue_update", steering: [], followUp: [prompt] },
    {
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
      },
      toolResults: [],
      result,
    },
    { type: "agent_end", messages: [] },
  ];
  for (const line of lines) console.log(JSON.stringify(line));
}

async function runSparkRpcMode(
  daemonClient: SparkDaemonClientOptions,
  options: SparkCliRuntimeOptions | undefined,
): Promise<void> {
  writeRpc({
    type: "response",
    command: "ready",
    success: true,
    data: { protocol: "spark-rpc-jsonl", mode: "daemon" },
  });
  let buffered = "";
  for await (const chunk of processStdin) {
    buffered += String(chunk);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (line.trim()) await handleSparkRpcLine(line, daemonClient, options);
      newline = buffered.indexOf("\n");
    }
  }
  if (buffered.trim())
    await handleSparkRpcLine(buffered.replace(/\r$/u, ""), daemonClient, options);
}

export async function handleSparkRpcLine(
  line: string,
  daemonClient: SparkDaemonClientOptions,
  options: SparkCliRuntimeOptions | undefined,
  writer: (value: Record<string, unknown>) => void = writeRpc,
): Promise<void> {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    writer({ type: "response", command: "parse", success: false, error: errorMessage(error) });
    return;
  }
  const id = typeof request.id === "string" ? request.id : undefined;
  const command = typeof request.type === "string" ? request.type : "unknown";
  try {
    if (command === "prompt" || command === "steer" || command === "follow_up") {
      const message = typeof request.message === "string" ? request.message : "";
      if (!message) throw new Error(`${command} requires message`);
      const sessionId =
        options?.sessionId ?? options?.session ?? `spark-rpc-${Date.now().toString(36)}`;
      const result = await handleSparkDaemonCliCommand(
        { action: "submit", json: true, sessionId, prompt: message },
        daemonClient,
      );
      writer({ id, type: "response", command, success: true, data: result });
      return;
    }
    if (command === "get_state") {
      const state = await handleSparkDaemonCliCommand(
        { action: "status", json: true },
        daemonClient,
      );
      writer({ id, type: "response", command, success: true, data: state });
      return;
    }
    if (command === "get_messages") {
      writer({
        id,
        type: "response",
        command,
        success: true,
        data: { messages: [] },
      });
      return;
    }
    if (command === "abort") {
      writer({
        id,
        type: "response",
        command,
        success: true,
        data: { queuedDaemonMode: true },
      });
      return;
    }
    if (command === "new_session") {
      writer({
        id,
        type: "response",
        command,
        success: true,
        data: { queuedDaemonMode: true },
      });
      return;
    }
    writer({
      id,
      type: "response",
      command,
      success: false,
      error: `unsupported rpc command: ${command}`,
    });
  } catch (error) {
    writer({ id, type: "response", command, success: false, error: errorMessage(error) });
  }
}

function writeRpc(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  console.log(
    `spark-tui - Spark terminal UI\n\nUsage:\n  spark-tui [initial message]\n  spark-tui --print <prompt>\n  spark-tui --mode json --print <prompt>\n  spark-tui --mode rpc\n  spark-tui --list-models [search]\n  spark-tui install|remove|update|list|config [resource]\n  spark-tui --help\n\nRuns terminal UI rendering by default, but prompts are submitted to the Spark daemon over local IPC. Pi-compatible resource commands update ~/.spark/config.json and keep extensions/providers/skills/prompt templates/themes explicit. Use the root "spark daemon ..." dispatcher path for daemon administration.`,
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
