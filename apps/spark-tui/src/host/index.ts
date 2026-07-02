/**
 * Public barrel for the SparkHostRuntime native ExtensionAPI host.
 *
 * Extensions speak to `spark-extension-api`'s `ExtensionAPI` shape; this
 * package's job is to provide a runtime that satisfies that contract for the
 * spark-tui native pi-tui host. The barrel keeps the import surface stable
 * across follow-up tasks (`agent-turn-loop`, `model-selector-ui`,
 * `session-format-and-store`, `tool-and-thinking-rendering`, …) which will
 * extend the runtime in place.
 */

export { SparkHostRuntime, createSparkHostRuntime } from "./runtime.ts";
export type { SparkHostRuntimeOptions } from "./runtime.ts";
export { SparkAgentLoop } from "./agent-loop.ts";
export {
  SparkAuthStore,
  SparkProviderAuthResolver,
  defaultSparkAuthPath,
  listOAuthProviderSummaries,
  registerSparkOAuthProvider,
  resetSparkOAuthProviders,
} from "./auth.ts";
export type {
  SparkAuthFile,
  SparkAuthStoreOptions,
  SparkProviderAuthResolverOptions,
  SparkOAuthProviderInterface,
  SparkProviderAuthStatus,
  SparkStoredCredential,
} from "./auth.ts";
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
export { SparkHostModelRegistry } from "./model-registry.ts";
export type {
  SparkHostModelAuthResolver,
  SparkHostModelRegistryLike,
  SparkHostModelRegistryOptions,
  SparkHostRegistryModel,
} from "./model-registry.ts";
export {
  SPARK_MODEL_CYCLE_NEXT_BINDING_ID,
  SPARK_MODEL_CYCLE_PREV_BINDING_ID,
  SPARK_MODEL_PICKER_BINDING_ID,
  SparkModelSelector,
  formatSelection as formatSparkModelSelection,
  registerSparkModelSelectorKeybindings,
  resolveSparkModelSelectionById,
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
  appendSparkBranchSummary,
  collectSparkBranchEntriesToSummarize,
  compactSparkSessionRecord,
  compactSparkVisibleTranscript,
  deterministicSparkCompactionSummary,
  entriesToMessages,
  estimateSparkContextTokens,
  estimateSparkTokens,
  findSparkCompactionCutPoint,
  findSparkTurnStartIndex,
  navigateSparkSessionBranchWithSummary,
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
  BUILTIN_SPARK_THEMES,
  DEFAULT_SPARK_THEME_ID,
  createSparkHostRenderTheme,
  createSparkMarkdownTheme,
  loadSparkThemeCatalog,
  styleSparkDiffLine,
  styleSparkRoleLine,
} from "./theme.ts";
export type {
  SparkTheme,
  SparkThemeCatalog,
  SparkThemeColors,
  SparkThemeDiagnostic,
  SparkThemeLoadOptions,
} from "./theme.ts";
export {
  defaultSparkHtmlExportDir,
  defaultSparkShareDir,
  renderSparkTranscriptHtml,
  sparkSessionRecordToHtmlMessages,
  writeSparkTranscriptHtml,
} from "./html-export.ts";
export {
  SparkPromptTemplateResolver,
  defaultSparkPromptTemplatesDir,
  defaultSparkPromptTemplatesRoot,
  expandSparkPromptTemplate,
  loadPromptTemplateFromFile,
  loadPromptTemplatesFromDir,
  loadPromptTemplatesFromPath,
  parseSparkPromptTemplateArgs,
  substituteSparkPromptTemplateArgs,
} from "./prompt-templates.ts";
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
  SparkBranchNavigationSummaryResult,
  SparkCompactionSummaryResult,
  SparkContextUsageEstimate,
  SparkCutPointResult,
  SparkTranscriptMessageForCompaction,
  SparkVisibleTranscriptCompactionResult,
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
  SparkHtmlExportInput,
  SparkHtmlTranscriptMessage,
  SparkHtmlWriteOptions,
  SparkHtmlWriteResult,
} from "./html-export.ts";
export type {
  SparkPromptTemplate,
  SparkPromptTemplateDiagnostic,
  SparkPromptTemplateExpansion,
  SparkPromptTemplateLayer,
  SparkPromptTemplateResolveResult,
  SparkPromptTemplateResolverOptions,
} from "./prompt-templates.ts";
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
