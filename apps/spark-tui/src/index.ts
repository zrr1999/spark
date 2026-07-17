export {
  createSparkCliHostServices,
  createProviderRegistryStreamFunction,
  createProviderRegistryWorkflowModelRunner,
  type SparkCliHostServices,
  type SparkCliHostServicesOptions,
  type SparkWorkflowModelRunRequest,
  type SparkWorkflowModelRunResponse,
} from "./host/bootstrap.ts";
export {
  SparkAgentLoop,
  type SparkAgentLoopEvent,
  type SparkPromptItem,
  type SparkPromptManifest,
  type SparkPromptManifestOptions,
  type SparkRunOutcome,
} from "./host/agent-loop.ts";
export {
  SparkAgentSession,
  sessionEntriesToPromptItems,
  sessionRecordToAgentMessages,
  sessionRecordToPromptItems,
  type SparkAgentSessionRunOptions,
  type SparkAgentSessionRunResult,
} from "./host/agent-session.ts";
export { SparkHostRuntime, type SparkHostRuntimeOptions } from "./host/runtime.ts";
export { SparkSessionStore, type SparkSessionRecord } from "./host/session-store.ts";
export { SparkProviderRegistry, type ProviderConfig } from "./host/provider-registry.ts";
export { SparkModelSelector } from "./host/model-selector.ts";
export {
  SparkSkillResolver,
  type SparkSkill,
  type SparkSkillResolveResult,
} from "./host/skill-resolver.ts";
export {
  loadSparkConfig,
  saveSparkConfig,
  mergeWithDefault,
  defaultSparkConfigPath,
  type SparkConfig,
} from "./host/config.ts";
export {
  listSparkResources,
  runSparkResourceCommand,
  formatSparkResourceResult,
  type SparkResourceKind,
  type SparkResourceCommandResult,
} from "./cli/resource-manager.ts";
export {
  handleSparkRpcLine,
  parseSparkCliCommand,
  runSparkCli,
  type SparkCliRuntimeOptions,
} from "./cli.ts";
