/**
 * Public barrel for the SparkHostRuntime native ExtensionAPI host.
 *
 * Extensions speak to `pi-extension-api`'s `ExtensionAPI` shape; this
 * package's job is to provide a runtime that satisfies that contract for the
 * spark-tui native pi-tui host. The barrel keeps the import surface stable
 * across follow-up tasks (`agent-turn-loop`, `model-selector-ui`,
 * `session-format-and-store`, `tool-and-thinking-rendering`, …) which will
 * extend the runtime in place.
 */

export { SparkHostRuntime, createSparkHostRuntime } from "./runtime.ts";
export type { SparkHostRuntimeOptions } from "./runtime.ts";
export { SparkAgentLoop } from "./agent-loop.ts";
export type {
  SparkAgentLoopEvent,
  SparkAgentLoopOptions,
  SparkAgentLoopState,
  SparkAgentStreamFunction,
} from "./agent-loop.ts";
export {
  SparkAgentSession,
  agentMessageToSessionMessage,
  sessionEntriesToAgentMessages,
  sessionMessageToAgentMessage,
  sessionRecordToAgentMessages,
} from "./agent-session.ts";
export type { SparkAgentSessionRunOptions, SparkAgentSessionRunResult } from "./agent-session.ts";
export {
  SparkKeybindings,
  defaultKeybindingsPath,
  defaultSparkKeybindings,
} from "./keybindings.ts";
export type {
  SparkKeybindingContext,
  SparkKeybindingDefinition,
  SparkKeybindingId,
  SparkKeybindingsOptions,
  SparkKeybindingsSnapshot,
} from "./keybindings.ts";
export { SparkProviderRegistry } from "./provider-registry.ts";
export type {
  ProviderConfig,
  ProviderModelDefinition,
  ProviderRegistrationAPI,
  SparkActiveSelection,
} from "./provider-registry.ts";
export {
  SPARK_MODEL_CYCLE_NEXT_BINDING_ID,
  SPARK_MODEL_CYCLE_PREV_BINDING_ID,
  SPARK_MODEL_PICKER_BINDING_ID,
  SparkModelSelector,
  formatSelection as formatSparkModelSelection,
  registerSparkModelSelectorKeybindings,
  sparkModelSelectionFromValue,
  sparkModelSelectionValue,
} from "./model-selector.ts";
export type {
  SparkConfigLoader,
  SparkConfigSaver,
  SparkModelCycleDirection,
  SparkModelPicker,
  SparkModelPickerState,
  SparkModelProviderGroup,
  SparkModelSelectorItem,
  SparkModelSelectorKeybindingOptions,
  SparkModelSelectorOptions,
} from "./model-selector.ts";
export {
  assistantMessageToText,
  createProviderRegistryStreamFunction,
  createProviderRegistryWorkflowModelRunner,
  createSparkCliHostServices,
  defaultSparkCliKeybindingsPath,
  selectInitialModel,
  submitToSparkAgent,
} from "./bootstrap.ts";
export {
  DEFAULT_SPARK_CONFIG,
  defaultSparkConfigPath,
  loadSparkConfig,
  mergeWithDefault as mergeSparkConfigWithDefault,
  saveSparkConfig,
} from "./config.ts";
export {
  DEFAULT_SPARK_COMPACTION_SETTINGS,
  compactSparkSessionRecord,
  entriesToMessages,
  estimateSparkContextTokens,
  estimateSparkTokens,
  findSparkCompactionCutPoint,
  findSparkTurnStartIndex,
  prepareSparkCompaction,
  shouldSparkCompact,
} from "./compaction.ts";
export {
  DEFAULT_SPARK_EXTENSION_SPECS,
  SparkExtensionLoader,
  createSparkExtensionImporter,
  getBuiltinExtensionFactory,
  loadBuiltinExtensionFactories,
  loadSparkExtensions,
} from "./extension-loader.ts";
export {
  SparkSkillResolver,
  defaultBuiltinSkillsDir,
  defaultSparkSkillsRoot,
  defaultUserSkillsDir,
  formatSparkSkillsForPrompt,
  loadMatchingSparkSkillsForPrompt,
  loadSkillsFromDir,
  parseSkillFrontmatter,
} from "./skill-resolver.ts";
export type {
  SparkCliHostDiagnostic,
  SparkCliHostServices,
  SparkCliHostServicesOptions,
  SparkWorkflowModelRunRequest,
  SparkWorkflowModelRunResponse,
} from "./bootstrap.ts";
export type { SparkConfig } from "./config.ts";
export type {
  SparkCompactionPreparation,
  SparkCompactionSettings,
  SparkCompactionSummarizer,
  SparkCompactionSummaryResult,
  SparkContextUsageEstimate,
  SparkCutPointResult,
} from "./compaction.ts";
export type {
  SparkBuiltinExtensionFactory,
  SparkBuiltinExtensionName,
  SparkExtensionFactory,
  SparkExtensionLoadOutcome,
  SparkExtensionLoadResult,
  SparkExtensionLoaderOptions,
} from "./extension-loader.ts";
export type {
  SparkSkill,
  SparkSkillDiagnostic,
  SparkSkillFrontmatter,
  SparkSkillLayer,
  SparkSkillPromptMatch,
  SparkSkillResolveResult,
  SparkSkillResolverOptions,
} from "./skill-resolver.ts";
export {
  CURRENT_SPARK_SESSION_VERSION,
  SparkSessionStore,
  defaultSparkHome,
  defaultSparkSessionsRoot,
  parseSparkSessionEntries,
  workspaceSessionHash,
  writeJsonLinesAtomically,
} from "./session-store.ts";
export {
  buildSparkSessionTree,
  exportSparkSessionRecord,
  flattenSparkSessionTree,
  formatBranchRows,
  formatSessionList,
  formatSessionReplay,
  getSparkSessionBranch,
  getSparkSessionLeafId,
  readSparkSessionExportFormat,
  registerSparkSessionsCommand,
  runSparkSessionsCommand,
  switchSparkSessionLeaf,
} from "./session-navigation.ts";
export type {
  NewSparkSessionOptions,
  SparkBranchSummaryEntry,
  SparkCompactionEntry,
  SparkCustomEntry,
  SparkCustomMessageEntry,
  SparkLabelEntry,
  SparkModelChangeEntry,
  SparkSessionEntry,
  SparkSessionEntryBase,
  SparkSessionFileEntry,
  SparkSessionHeader,
  SparkSessionInfo,
  SparkSessionInfoEntry,
  SparkSessionMessage,
  SparkSessionMessageEntry,
  SparkSessionRecord,
  SparkSessionStoreOptions,
  SparkThinkingLevelChangeEntry,
} from "./session-store.ts";
export type {
  SparkSessionExportFormat,
  SparkSessionNavigationState,
  SparkSessionsCommandHost,
  SparkSessionsCommandOptions,
  SparkSessionTreeNode,
  SparkSessionTreeRow,
} from "./session-navigation.ts";
export { loadPlugins } from "./plugin-loader.ts";
export type {
  LoadPluginsOptions,
  LoadResult,
  PluginKind,
  PluginLoadOutcome,
} from "./plugin-loader.ts";
export type {
  RegisteredTool,
  RegisteredCommand,
  EventListener,
  EventName,
  OutboxEnvelope,
  SparkHostCustomMessage,
  SparkHostMessageRenderer,
  SparkHostMessageRenderOptions,
  SparkHostRenderComponent,
  SparkHostRenderTheme,
  SparkHostSessionManagerStub,
  SparkHostUiTransport,
  ToolRegistrationListener,
} from "./types.ts";
