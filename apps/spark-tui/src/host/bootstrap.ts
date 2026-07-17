/** Spark TUI native host service construction. */

import { basename, join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { stableId, type ExtensionAPI } from "@zendev-lab/spark-extension-api";
import {
  createProviderRegistryLeafRunner,
  createProviderRegistryStreamFunction,
} from "@zendev-lab/spark-ai";
import {
  DEFAULT_SPARK_IDENTITY_PROMPT,
  renderAgentRuntimeContextPrompt,
} from "@zendev-lab/spark-host/system-prompt";
import { composeAgentSystemPrompt } from "@zendev-lab/spark-modes";
import {
  PiRolesReviewerRunner,
  createSparkRoleRegistry,
  loadSparkMode,
  renderSparkActiveSystemPrompt,
  type SparkSessionContext,
} from "@zendev-lab/pi-extension/host-support";
import { SparkAgentLoop } from "./agent-loop.ts";
import { SparkAuthStore, SparkProviderAuthResolver, defaultSparkAuthPath } from "./auth.ts";
import {
  type SparkConfig,
  defaultSparkConfigPath,
  loadSparkConfig,
  saveSparkConfig,
} from "./config.ts";
import { SparkExtensionLoader, type SparkExtensionLoadResult } from "./extension-loader.ts";
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
import {
  SparkSkillResolver,
  formatSelectedSparkSkillsForPrompt,
  type SparkSkillPromptMatch,
} from "./skill-resolver.ts";
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
  sparkStateRoot?: string;
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  channelBinding?: SparkHostRuntimeOptions["channelBinding"];
  invocationId?: string;
  sessionQuestionChain?: readonly string[];
  allowedTools?: readonly string[];
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
  /** Per-model-stream deadline; <=0 disables it. */
  streamTimeoutMs?: number;
  /**
   * Session tool-approval method for `requiresApproval` tools.
   * Local TUI defaults to `skip`; channel headless sessions should pass `auto`.
   */
  approvalMethod?: "skip" | "human" | "auto";
  /** When auto-review rejects: escalate to ask (default) or deny. */
  approvalRejectAction?: "ask" | "deny";
}

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
    sparkStateRoot: options.sparkStateRoot,
    sessionSurface: options.sessionSurface,
    sessionSource: options.sessionSource,
    channelBinding: options.channelBinding,
    invocationId: options.invocationId,
    sessionQuestionChain: options.sessionQuestionChain,
    allowedTools: options.allowedTools,
    hasUI: options.hasUI ?? false,
    ui: options.ui,
    sessionManager: options.sessionManager,
    keybindings,
  });
  // Registered before extensions so request-scoped prompt state is cleared
  // before any extension's agent_end handler can enqueue a background turn.
  let clearRequestSkillSelection: () => void = () => undefined;
  runtime.on("agent_end", () => clearRequestSkillSelection());

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
  runtime.setLeafRunner(
    createProviderRegistryLeafRunner({
      registry: providerRegistry,
      runnerOptions: { resolveApiKey: (provider) => authResolver.resolveApiKey(provider) },
    }),
  );
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
  keybindings.register({
    id: "app.thinking.cycle",
    defaultKey: "shift+tab",
    description: "Cycle the assistant thinking level (off/minimal/low/medium/high/xhigh)",
    handler: async () => {
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
      const current = config.activeThinkingLevel;
      const index = current ? levels.indexOf(current) : -1;
      const next = levels[(index + 1) % levels.length]!;
      config.activeThinkingLevel = next;
      await saveLoadedConfig(config);
      runtime.makeContext().ui?.notify?.(`thinking ${next}`, "info");
    },
  });

  const sessionStore = new SparkSessionStore({ cwd, sparkHome: options.sparkHome });
  runtime.setSessionManager(
    options.sessionManager ?? createSparkCliSessionManagerStub(sessionStore, cwd),
  );

  const extensionLoadResult = await new SparkExtensionLoader({
    api: runtime as ExtensionAPI,
    extensions: options.extensions ?? config.extensions,
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

  runtime.setRoleRunner(async (input) => {
    const { createSparkHeadlessRoleExecutor } = await import("../headless-role-executor.ts");
    const executeRole = createSparkHeadlessRoleExecutor({ sparkHome: options.sparkHome });
    return await executeRole(input);
  });
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
  const skillsCatalogPrompt = await skillResolver.formatAvailableSkillsForPrompt();
  let selectedSkillMatches: SparkSkillPromptMatch[] = [];
  let selectedSkillsPrompt = "";
  const baseSystemPrompt = options.systemPrompt ?? DEFAULT_SPARK_IDENTITY_PROMPT;
  const initialPromptState = await resolveSparkCliAgentPromptState(
    cwd,
    runtime.makeContext(),
    baseSystemPrompt,
    skillsCatalogPrompt,
    selectedSkillsPrompt,
  );
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
    getReasoning: () => config.activeThinkingLevel,
    systemPrompt: initialPromptState.systemPrompt,
    streamTimeoutMs: options.streamTimeoutMs,
    prepareUserSubmit: async (request) => {
      // Selection belongs to exactly one real user request. Clear the prior
      // bodies before resolving so an empty/unmatched request cannot inherit
      // stale instructions from the preceding turn.
      selectedSkillMatches = [];
      selectedSkillsPrompt = "";
      try {
        selectedSkillMatches = await skillResolver.loadMatchingSkillsForPrompt(request, 3);
        selectedSkillsPrompt = formatSelectedSparkSkillsForPrompt(selectedSkillMatches);
      } finally {
        // A disappearing/unreadable skill may reject this submit, but it must
        // never leave the previous request's bodies installed in the prompt.
        const promptState = await resolveSparkCliAgentPromptState(
          cwd,
          runtime.makeContext(),
          baseSystemPrompt,
          skillsCatalogPrompt,
          selectedSkillsPrompt,
        );
        agentLoop.setSystemPrompt(promptState.systemPrompt);
        agentLoop.setCurrentPhase(promptState.phase);
      }
    },
    finishUserSubmit: () => clearRequestSkillSelection(),
    promptManifest: {
      getSelectedSkills: () => selectedSkillMatches.map((match) => match.skill.name),
    },
    // Local interactive TUI skips approval gates; channel/headless pass `auto`.
    approvalMethod: options.approvalMethod ?? "skip",
    ...(options.approvalRejectAction ? { approvalRejectAction: options.approvalRejectAction } : {}),
    reviewToolApproval: async (request, signal) => {
      const ctx = runtime.makeContext();
      const reviewer = new PiRolesReviewerRunner({
        registry: await createSparkRoleRegistry(cwd),
        cwd,
        nativeExecutor: ctx.runRole,
      });
      const result = await reviewer.review(
        {
          targetKind: "tool_approval",
          cwd,
          toolName: request.toolName,
          toolCallId: request.toolCallId,
          arguments: request.arguments,
          reason: request.reason,
          sessionKey: ctx.sessionId,
          forkFromSession: ctx.sessionManager?.getSessionFile?.(),
        },
        signal,
      );
      return {
        outcome: result.verdict.outcome,
        summary: result.verdict.summary,
      };
    },
  });
  agentLoop.setCurrentPhase(initialPromptState.phase);
  clearRequestSkillSelection = () => {
    const hadSelection = selectedSkillMatches.length > 0 || selectedSkillsPrompt.length > 0;
    selectedSkillMatches = [];
    selectedSkillsPrompt = "";
    if (!hadSelection) return;
    agentLoop.setSystemPrompt(
      composeSparkCliAgentSystemPrompt(
        cwd,
        baseSystemPrompt,
        skillsCatalogPrompt,
        selectedSkillsPrompt,
        agentLoop.getCurrentPhase() ?? initialPromptState.phase,
      ),
    );
  };
  runtime.on("before_agent_start", async (event, ctx) => {
    if (sparkAgentLifecycleSource(event) === "triggerTurn") {
      // Driver/background turns (goal, loop, repro, scheduled continuations)
      // are not assist-plan turns. Do not inherit a request skill body or a
      // persisted plan/implement tool profile from the last user session.
      selectedSkillMatches = [];
      selectedSkillsPrompt = "";
      agentLoop.setSystemPrompt(
        composeSparkCliDriverSystemPrompt(cwd, baseSystemPrompt, skillsCatalogPrompt),
      );
      agentLoop.setCurrentPhase(undefined);
      return;
    }
    const promptState = await resolveSparkCliAgentPromptState(
      cwd,
      ctx,
      baseSystemPrompt,
      skillsCatalogPrompt,
      selectedSkillsPrompt,
    );
    agentLoop.setSystemPrompt(promptState.systemPrompt);
    agentLoop.setCurrentPhase(promptState.phase);
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

async function resolveSparkCliAgentPromptState(
  cwd: string,
  ctx: SparkSessionContext,
  baseSystemPrompt: string,
  skillsCatalogPrompt: string,
  selectedSkillsPrompt: string,
): Promise<{ systemPrompt: string; phase: "plan" | "implement" }> {
  const mode = (await loadSparkMode(cwd, ctx)).mode;
  return {
    phase: mode,
    systemPrompt: composeSparkCliAgentSystemPrompt(
      cwd,
      baseSystemPrompt,
      skillsCatalogPrompt,
      selectedSkillsPrompt,
      mode,
    ),
  };
}

function composeSparkCliAgentSystemPrompt(
  cwd: string,
  baseSystemPrompt: string,
  skillsCatalogPrompt: string,
  selectedSkillsPrompt: string,
  phase: "plan" | "implement",
): string {
  return composeAgentSystemPrompt([
    renderSparkActiveSystemPrompt(baseSystemPrompt, phase),
    skillsCatalogPrompt,
    selectedSkillsPrompt,
    renderAgentRuntimeContextPrompt({ cwd }),
  ]);
}

function composeSparkCliDriverSystemPrompt(
  cwd: string,
  baseSystemPrompt: string,
  skillsCatalogPrompt: string,
): string {
  return composeAgentSystemPrompt([
    baseSystemPrompt,
    skillsCatalogPrompt,
    renderAgentRuntimeContextPrompt({ cwd }),
  ]);
}

function sparkAgentLifecycleSource(event: unknown): "agentLoop" | "triggerTurn" {
  if (
    event &&
    typeof event === "object" &&
    (event as { source?: unknown }).source === "triggerTurn"
  ) {
    return "triggerTurn";
  }
  return "agentLoop";
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
