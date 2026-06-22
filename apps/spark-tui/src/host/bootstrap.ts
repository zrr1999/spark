/** Spark TUI native host service construction. */

import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AssistantMessageEvent, Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import { stableId, type ExtensionAPI } from "@zendev-lab/pi-extension-api";

import { renderSparkActiveSystemPrompt } from "../../../../packages/spark-extension/src/extension/spark-active-injection.ts";
import { renderBaseSystemPromptsPrompt } from "../../../../packages/spark-extension/src/extension/spark-builtin-skills.ts";
import { loadSparkMode } from "../../../../packages/spark-extension/src/extension/session-state.ts";
import type { SparkSessionContext } from "../../../../packages/spark-extension/src/extension/session-identity.ts";
import { SparkAgentLoop, type SparkAgentStreamFunction } from "./agent-loop.ts";
import {
  type SparkConfig,
  defaultSparkConfigPath,
  loadSparkConfig,
  saveSparkConfig,
} from "./config.ts";
import {
  DEFAULT_SPARK_EXTENSION_SPECS,
  SparkExtensionLoader,
  type SparkExtensionLoadResult,
} from "./extension-loader.ts";
import { SparkKeybindings } from "./keybindings.ts";
import {
  SparkModelSelector,
  registerSparkModelSelectorKeybindings,
  type SparkModelPicker,
} from "./model-selector.ts";
import { loadPlugins, type LoadResult } from "./plugin-loader.ts";
import {
  SparkProviderRegistry,
  type ProviderConfig,
  type SparkActiveSelection,
} from "./provider-registry.ts";
import { SparkHostRuntime, type SparkHostRuntimeOptions } from "./runtime.ts";
import { SparkSessionStore } from "./session-store.ts";
import { SparkSkillResolver } from "./skill-resolver.ts";

export interface SparkCliHostDiagnostic {
  type: "warning" | "error";
  message: string;
}

export interface SparkCliHostServices {
  cwd: string;
  config: SparkConfig;
  runtime: SparkHostRuntime;
  keybindings: SparkKeybindings;
  providerRegistry: SparkProviderRegistry;
  modelSelector: SparkModelSelector;
  sessionStore: SparkSessionStore;
  skillResolver: SparkSkillResolver;
  agentLoop: SparkAgentLoop;
  extensionLoadResult: SparkExtensionLoadResult;
  providerLoadResult: LoadResult;
  diagnostics: SparkCliHostDiagnostic[];
}

export interface SparkWorkflowModelRunRequest {
  prompt: string;
  label: string;
  phase?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface SparkWorkflowModelRunResponse {
  text: string;
  structured?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SparkCliHostServicesOptions {
  cwd?: string;
  sparkHome?: string;
  config?: SparkConfig;
  configPath?: string;
  keybindingsPath?: string;
  hasUI?: boolean;
  ui?: SparkHostRuntimeOptions["ui"];
  sessionManager?: SparkHostRuntimeOptions["sessionManager"];
  extensions?: string[];
  providers?: string[];
  extensionImporter?: (specifier: string) => Promise<unknown>;
  providerImporter?: (specifier: string) => Promise<unknown>;
  modelPicker?: SparkModelPicker;
  systemPrompt?: string;
}

const DEFAULT_SPARK_SYSTEM_PROMPT =
  "You are a coding assistant running in the native spark-tui host. Use Spark as the project/task coordination layer, not as your assistant identity.";

export async function createSparkCliHostServices(
  options: SparkCliHostServicesOptions = {},
): Promise<SparkCliHostServices> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const diagnostics: SparkCliHostDiagnostic[] = [];
  const configPath =
    options.configPath ??
    (options.sparkHome ? join(options.sparkHome, "config.json") : defaultSparkConfigPath());
  const config = options.config ?? (await loadSparkConfig(configPath));

  const keybindings = new SparkKeybindings();
  const keybindingsPath =
    options.keybindingsPath ?? defaultSparkCliKeybindingsPath(options.sparkHome);
  try {
    await keybindings.loadFromDisk(keybindingsPath);
  } catch (error) {
    diagnostics.push({
      type: "warning",
      message: `Failed to load keybindings: ${errorMessage(error)}`,
    });
  }

  const runtime = new SparkHostRuntime({
    cwd,
    hasUI: options.hasUI ?? false,
    ui: options.ui,
    sessionManager: options.sessionManager,
    keybindings,
  });

  const providerRegistry = new SparkProviderRegistry();
  const providerLoadResult = await loadPlugins({
    extensionApi: runtime,
    providerApi: providerRegistry,
    extensions: [],
    providers: options.providers ?? config.providers,
    importer: options.providerImporter,
  });
  for (const outcome of providerLoadResult.outcomes) {
    if (!outcome.ok)
      diagnostics.push({
        type: "warning",
        message: `Provider ${outcome.specifier}: ${outcome.error}`,
      });
  }
  const activeSelection = selectInitialModel(providerRegistry, config);
  if (!activeSelection) {
    diagnostics.push({ type: "warning", message: "No Spark provider/model is registered yet." });
  }

  const modelSelector = new SparkModelSelector({
    registry: providerRegistry,
    config,
    saveConfig: (nextConfig) => saveSparkConfig(nextConfig, configPath),
    picker: options.modelPicker,
  });
  registerSparkModelSelectorKeybindings(keybindings, modelSelector, {
    notify: (message, level) => runtime.makeContext().ui?.notify?.(message, level),
  });

  const extensionLoadResult = await new SparkExtensionLoader({
    api: runtime as ExtensionAPI,
    extensions: options.extensions ?? [...DEFAULT_SPARK_EXTENSION_SPECS],
    importer: options.extensionImporter,
  }).load();
  for (const outcome of extensionLoadResult.outcomes) {
    if (!outcome.ok)
      diagnostics.push({
        type: "warning",
        message: `Extension ${outcome.specifier}: ${outcome.error}`,
      });
  }

  const sessionStore = new SparkSessionStore({ cwd, sparkHome: options.sparkHome });
  runtime.setSessionManager(
    options.sessionManager ?? createSparkCliSessionManagerStub(sessionStore, cwd),
  );
  const skillResolver = new SparkSkillResolver({ cwd, sparkHome: options.sparkHome });
  const builtinSkillsPrompt = await renderBaseSystemPromptsPrompt();
  const skillsPrompt = await skillResolver.formatAvailableSkillsForPrompt();
  const baseSystemPrompt = options.systemPrompt ?? DEFAULT_SPARK_SYSTEM_PROMPT;
  const streamFunction = createProviderRegistryStreamFunction(providerRegistry);
  const agentLoop = new SparkAgentLoop({
    host: runtime,
    streamFunction,
    getModel: () => {
      const model = providerRegistry.buildActiveModel();
      if (!model) throw new Error("No active Spark model selected");
      return model as Model<string>;
    },
    systemPrompt: await renderSparkCliAgentSystemPrompt(
      cwd,
      runtime.makeContext(),
      baseSystemPrompt,
      builtinSkillsPrompt,
      skillsPrompt,
    ),
  });
  runtime.on("before_agent_start", async (_event, ctx) => {
    agentLoop.setSystemPrompt(
      await renderSparkCliAgentSystemPrompt(
        cwd,
        ctx,
        baseSystemPrompt,
        builtinSkillsPrompt,
        skillsPrompt,
      ),
    );
  });

  return {
    cwd,
    config,
    runtime,
    keybindings,
    providerRegistry,
    modelSelector,
    sessionStore,
    skillResolver,
    agentLoop,
    extensionLoadResult,
    providerLoadResult,
    diagnostics,
  };
}

async function renderSparkCliAgentSystemPrompt(
  cwd: string,
  ctx: SparkSessionContext,
  baseSystemPrompt: string,
  builtinSkillsPrompt: string,
  skillsPrompt: string,
): Promise<string> {
  const mode = (await loadSparkMode(cwd, ctx)).mode;
  return [renderSparkActiveSystemPrompt(baseSystemPrompt, mode), builtinSkillsPrompt, skillsPrompt]
    .filter(Boolean)
    .join("\n");
}

export function createProviderRegistryStreamFunction(
  registry: SparkProviderRegistry,
): SparkAgentStreamFunction {
  return (model: Model<string>, context: Context, options?: StreamOptions) => {
    const active = registry.getActive();
    if (!active) throw new Error("No active Spark model selected");
    const provider = registry.getProvider(active.providerName);
    if (!provider) throw new Error(`Unknown active Spark provider: ${active.providerName}`);
    const stream = provider.streamSimple(model as Model<ProviderConfig["api"]>, context, options);
    return stream as AsyncIterable<AssistantMessageEvent> & {
      result(): Promise<unknown>;
    } as ReturnType<SparkAgentStreamFunction>;
  };
}

export function createProviderRegistryWorkflowModelRunner(
  registry: SparkProviderRegistry,
): (request: SparkWorkflowModelRunRequest) => Promise<SparkWorkflowModelRunResponse> {
  return async (request) => {
    const selection = resolveWorkflowModelSelection(registry, request.model);
    const provider = registry.getProvider(selection.providerName);
    if (!provider) throw new Error(`Unknown workflow model provider: ${selection.providerName}`);
    const model = registry.buildModel(selection.providerName, selection.modelId);
    const context: Context = {
      systemPrompt: [
        "You are a read-only Spark workflow model agent.",
        "Answer the workflow prompt directly. Do not call tools or modify repository state.",
      ].join("\n"),
      messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
      tools: [],
    };
    const stream = provider.streamSimple(
      model,
      context,
      {},
    ) as AsyncIterable<AssistantMessageEvent> & {
      result(): Promise<unknown>;
    };
    for await (const _event of stream) {
      void _event;
    }
    const result = await stream.result();
    return {
      text: assistantMessageToText(result as { content?: unknown }),
      metadata: {
        ...request.metadata,
        providerName: selection.providerName,
        modelId: selection.modelId,
      },
    };
  };
}

function resolveWorkflowModelSelection(
  registry: SparkProviderRegistry,
  requested: string | undefined,
): SparkActiveSelection {
  if (requested?.trim()) {
    const trimmed = requested.trim();
    const slash = trimmed.indexOf("/");
    if (slash > 0) {
      const selection = {
        providerName: trimmed.slice(0, slash),
        modelId: trimmed.slice(slash + 1),
      };
      assertWorkflowModelSelection(registry, selection);
      return selection;
    }
    const active = registry.getActive();
    if (
      active &&
      registry.listModelsFor(active.providerName).some((model) => model.id === trimmed)
    ) {
      const selection = { providerName: active.providerName, modelId: trimmed };
      assertWorkflowModelSelection(registry, selection);
      return selection;
    }
    const provider = registry
      .listProviders()
      .find((candidate) => candidate.models.some((model) => model.id === trimmed));
    if (!provider) throw new Error(`Unknown workflow model: ${trimmed}`);
    const selection = { providerName: provider.name, modelId: trimmed };
    assertWorkflowModelSelection(registry, selection);
    return selection;
  }

  const active = registry.getActive();
  if (active) return active;
  const provider = registry.listProviders()[0];
  const model = provider?.models[0];
  if (!provider || !model) throw new Error("No Spark model is available for workflow model agent");
  return { providerName: provider.name, modelId: model.id };
}

function assertWorkflowModelSelection(
  registry: SparkProviderRegistry,
  selection: SparkActiveSelection,
): void {
  registry.buildModel(selection.providerName, selection.modelId);
}

export function selectInitialModel(
  registry: SparkProviderRegistry,
  config: SparkConfig,
): SparkActiveSelection | undefined {
  if (config.activeProvider && config.activeModel) {
    try {
      const selection = { providerName: config.activeProvider, modelId: config.activeModel };
      registry.setActive(selection);
      return selection;
    } catch {
      // Fall through to first registered model.
    }
  }

  const provider = registry.listProviders()[0];
  const model = provider?.models[0];
  if (!provider || !model) return undefined;
  const selection = { providerName: provider.name, modelId: model.id };
  registry.setActive(selection);
  config.activeProvider = selection.providerName;
  config.activeModel = selection.modelId;
  return selection;
}

export async function submitToSparkAgent(
  services: SparkCliHostServices,
  input: string,
): Promise<string> {
  await ensureSparkCliSessionFile(services.sessionStore);
  const result = await services.agentLoop.submit(input);
  return result ? assistantMessageToText(result) : "No assistant response.";
}

function createSparkCliSessionManagerStub(store: SparkSessionStore, cwd: string) {
  return {
    getSessionFile: () => currentSparkCliSessionFile(store, cwd),
    getLeafId: () => currentSparkCliLeafId(store, cwd),
  };
}

function currentSparkCliSessionFile(store: SparkSessionStore, cwd: string): string {
  return join(store.sessionDir, `${stableId(cwd)}.jsonl`);
}

function currentSparkCliLeafId(store: SparkSessionStore, cwd: string): string {
  return basename(currentSparkCliSessionFile(store, cwd), ".jsonl");
}

async function ensureSparkCliSessionFile(store: SparkSessionStore): Promise<void> {
  await mkdir(store.sessionDir, { recursive: true });
}

export function assistantMessageToText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    if ((part as { type?: unknown }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    } else if ((part as { type?: unknown }).type === "toolCall") {
      const name = (part as { name?: unknown }).name;
      parts.push(`[tool call: ${typeof name === "string" ? name : "unknown"}]`);
    }
  }
  return parts.join("\n");
}

export function defaultSparkCliKeybindingsPath(sparkHome?: string): string {
  const root = sparkHome ?? process.env.SPARK_HOME ?? join(process.env.HOME ?? "", ".spark");
  return join(root, "agent", "keybindings.json");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
