/** Spark TUI native host service construction. */

import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { stableId, type ExtensionAPI } from "@zendev-lab/pi-extension-api";
import { assistantMessageToText, createProviderRegistryStreamFunction } from "@zendev-lab/spark-ai";

import { renderSparkActiveSystemPrompt } from "../../../../packages/spark-extension/src/extension/spark-active-injection.ts";
import { renderBaseSystemPromptsPrompt } from "../../../../packages/spark-extension/src/extension/spark-builtin-skills.ts";
import { loadSparkMode } from "../../../../packages/spark-extension/src/extension/session-state.ts";
import type { SparkSessionContext } from "../../../../packages/spark-extension/src/extension/session-identity.ts";
import { SparkAgentLoop } from "./agent-loop.ts";
import { SparkAuthStore, SparkProviderAuthResolver, defaultSparkAuthPath } from "./auth.ts";
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
  resolveSparkModelSelectionById,
  sparkModelSelectionValue,
  type SparkModelPicker,
} from "./model-selector.ts";
import { SparkHostModelRegistry } from "./model-registry.ts";
import { loadPlugins, type LoadResult } from "./plugin-loader.ts";
import {
  SparkPromptTemplateResolver,
  type SparkPromptTemplateResolveResult,
} from "./prompt-templates.ts";
import { SparkProviderRegistry, type SparkActiveSelection } from "./provider-registry.ts";
import { SparkHostRuntime, type SparkHostRuntimeOptions } from "./runtime.ts";
import { SparkSessionStore } from "./session-store.ts";
import { SparkSkillResolver } from "./skill-resolver.ts";
import { loadSparkThemeCatalog, type SparkTheme, type SparkThemeCatalog } from "./theme.ts";

export interface SparkCliHostDiagnostic {
  type: "warning" | "error";
  message: string;
}

export interface SparkCliHostServices {
  cwd: string;
  config: SparkConfig;
  saveConfig?: (config: SparkConfig) => Promise<void>;
  runtime: SparkHostRuntime;
  keybindings: SparkKeybindings;
  providerRegistry: SparkProviderRegistry;
  authStore?: SparkAuthStore;
  authResolver?: SparkProviderAuthResolver;
  modelRegistry?: SparkHostModelRegistry;
  modelSelector: SparkModelSelector;
  sessionStore: SparkSessionStore;
  skillResolver: SparkSkillResolver;
  promptTemplates?: SparkPromptTemplateResolveResult;
  agentLoop: SparkAgentLoop;
  extensionLoadResult: SparkExtensionLoadResult;
  providerLoadResult: LoadResult;
  diagnostics: SparkCliHostDiagnostic[];
  themeCatalog?: SparkThemeCatalog;
  theme?: SparkTheme;
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
  authPath?: string;
  authStore?: SparkAuthStore;
  authEnv?: NodeJS.ProcessEnv;
  modelPicker?: SparkModelPicker;
  systemPrompt?: string;
  noPromptTemplates?: boolean;
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
  const saveLoadedConfig = (nextConfig: SparkConfig) => saveSparkConfig(nextConfig, configPath);

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
    diagnostics.push({ type: "warning", message: "No Spark model is registered yet." });
  }
  const authStore =
    options.authStore ??
    new SparkAuthStore({ path: options.authPath ?? defaultSparkAuthPath(options.sparkHome) });
  await authStore.reload();
  if (authStore.loadError) {
    diagnostics.push({
      type: "warning",
      message: `Failed to load Spark auth store: ${errorMessage(authStore.loadError)}`,
    });
  }
  const authResolver = new SparkProviderAuthResolver(authStore, { env: options.authEnv });
  const modelRegistry = new SparkHostModelRegistry(providerRegistry, {
    authResolver,
    getError: () => formatProviderLoadError(providerLoadResult),
  });
  runtime.setModelRegistry(modelRegistry);

  const modelSelector = new SparkModelSelector({
    registry: providerRegistry,
    config,
    saveConfig: saveLoadedConfig,
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

  const themeCatalog = await loadSparkThemeCatalog({
    cwd,
    sparkHome: options.sparkHome,
    configuredThemePaths: config.themes ?? [],
    activeThemeId: config.activeTheme,
  });
  for (const diagnostic of themeCatalog.diagnostics) diagnostics.push(diagnostic);

  const sessionStore = new SparkSessionStore({ cwd, sparkHome: options.sparkHome });
  runtime.setSessionManager(
    options.sessionManager ?? createSparkCliSessionManagerStub(sessionStore, cwd),
  );
  const skillResolver = new SparkSkillResolver({
    cwd,
    sparkHome: options.sparkHome,
    skillDirs: config.skills ?? [],
  });
  const promptTemplateResolver = new SparkPromptTemplateResolver({
    cwd,
    sparkHome: options.sparkHome,
    promptTemplatePaths: config.promptTemplates ?? [],
    includeDefaults: options.noPromptTemplates !== true,
  });
  const promptTemplates = await promptTemplateResolver.resolve();
  for (const diagnostic of promptTemplates.diagnostics) {
    diagnostics.push({ type: "warning", message: formatPromptTemplateDiagnostic(diagnostic) });
  }
  const builtinSkillsPrompt = await renderBaseSystemPromptsPrompt();
  const skillsPrompt = await skillResolver.formatAvailableSkillsForPrompt();
  const baseSystemPrompt = options.systemPrompt ?? DEFAULT_SPARK_SYSTEM_PROMPT;
  const streamFunction = createProviderRegistryStreamFunction(providerRegistry, {
    resolveApiKey: (provider) => authResolver.resolveApiKey(provider),
  });
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
    saveConfig: saveLoadedConfig,
    runtime,
    keybindings,
    providerRegistry,
    authStore,
    authResolver,
    modelRegistry,
    modelSelector,
    sessionStore,
    skillResolver,
    promptTemplates,
    agentLoop,
    extensionLoadResult,
    providerLoadResult,
    diagnostics,
    themeCatalog,
    theme: themeCatalog.active,
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

export {
  assistantMessageToText,
  createProviderRegistryStreamFunction,
  createProviderRegistryWorkflowModelRunner,
} from "@zendev-lab/spark-ai";
export type {
  SparkWorkflowModelRunRequest,
  SparkWorkflowModelRunResponse,
} from "@zendev-lab/spark-ai";

function formatProviderLoadError(providerLoadResult: LoadResult): string | undefined {
  const failures = providerLoadResult.outcomes.filter((outcome) => !outcome.ok);
  if (failures.length === 0) return undefined;
  return failures
    .map((outcome) => `${outcome.specifier}: ${outcome.error ?? "unknown error"}`)
    .join("; ");
}

export function selectInitialModel(
  registry: SparkProviderRegistry,
  config: SparkConfig,
): SparkActiveSelection | undefined {
  const configuredModelId = config.activeModelId;
  if (configuredModelId) {
    try {
      const selection = resolveSparkModelSelectionById(registry, configuredModelId);
      registry.setActive(selection);
      config.activeModelId = sparkModelSelectionValue(selection);
      delete config.activeProvider;
      delete config.activeModel;
      return selection;
    } catch {
      // Fall through to legacy pair or first registered model.
    }
  }

  if (config.activeProvider && config.activeModel) {
    try {
      const selection = { providerName: config.activeProvider, modelId: config.activeModel };
      registry.setActive(selection);
      config.activeModelId = sparkModelSelectionValue(selection);
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
  config.activeModelId = sparkModelSelectionValue(selection);
  delete config.activeProvider;
  delete config.activeModel;
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

export function defaultSparkCliKeybindingsPath(sparkHome?: string): string {
  const root = sparkHome ?? process.env.SPARK_HOME ?? join(process.env.HOME ?? "", ".spark");
  return join(root, "agent", "keybindings.json");
}

function formatPromptTemplateDiagnostic(
  diagnostic: SparkPromptTemplateResolveResult["diagnostics"][number],
): string {
  return diagnostic.path
    ? `Prompt template ${diagnostic.path}: ${diagnostic.message}`
    : `Prompt template: ${diagnostic.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
