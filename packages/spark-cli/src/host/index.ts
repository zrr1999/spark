/**
 * Public barrel for the SparkHostRuntime native ExtensionAPI host.
 *
 * Extensions speak to `pi-extension-api`'s `ExtensionAPI` shape; this
 * package's job is to provide a runtime that satisfies that contract for the
 * spark-cli native pi-tui host. The barrel keeps the import surface stable
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
  DEFAULT_SPARK_FUSION_PANEL_SIZE,
  SPARK_FUSION_MODEL,
  SPARK_FUSION_PROVIDER,
  createSparkFusionProvider,
  listAvailableFusionTargets,
  registerSparkFusionProvider,
  resolveSparkFusionRunConfig,
  runSparkFusion,
  streamSparkFusion,
} from "./fusion-provider.ts";
export type {
  SparkFusionConfig,
  SparkFusionModelSelection,
  SparkFusionRunConfig,
} from "./fusion-provider.ts";
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
export * from "./daemon/index.ts";
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
} from "./bootstrap.ts";
export type {
  SparkConfig,
  SparkFusionConfig as SparkConfigFusionConfig,
  SparkModelSelectionConfig,
} from "./config.ts";
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
  flattenSparkSessionTree,
  formatBranchRows,
  formatSessionList,
  getSparkSessionBranch,
  getSparkSessionLeafId,
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
