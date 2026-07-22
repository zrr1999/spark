/**
 * spark-cue extension
 *
 * Atomic execution tools organized by the three category objects:
 *
 *   Execution:
 *     cue_exec / cue_run / cue_script / script_run / script_eval
 *   Jobs:
 *     cue_jobs
 *   Schedules:
 *     cue_schedule
 *   System:
 *     cue_scope / cue_history
 */

export {
  CueClient,
  CueError,
  CueTransportError,
  cueOperationId,
  cueOperationStep,
  defaultSocketPath,
  isRetryableCueTransportError,
  resolveCueTransport,
} from "./client/cue-client.ts";
export type {
  CueOperationKey,
  CueResolvedTransport,
  CueSessionOptions,
  CancelReason,
  JobInfo,
  JobOutputResult,
  JobResult,
  JobStatus,
  OutputEncoding,
  ResourceNeeds,
  ScriptItemSummary,
  ScriptResult,
  StartJobResult,
} from "./client/cue-client.ts";

export {
  __resetForTests as __resetVersionCheckForTests,
  checkAndWarn as checkCuedVersionAndWarn,
  classifyDaemonVersion,
  compareSemver,
  defaultCuedVersionCachePath,
  fetchLatestRelease,
  renderWarning as renderCuedVersionWarning,
} from "./version-check.ts";
export type { DaemonVersion, VersionCheckOptions, VersionVerdict } from "./version-check.ts";

export type {
  SparkCueHostApi,
  SparkCueNotifyLevel,
  SparkCueToolContext,
  SparkCueToolConfig,
} from "./tools/host-types.ts";
export {
  __resetSparkCueClientForTests,
  DEFAULT_CUED_AUTOSTART_TIMEOUT_MS,
} from "./tools/runtime.ts";
export {
  registerSparkCueTools,
  renderCueScriptResult,
  renderCueChainStatus,
  normalizeCueTerminalOutput,
  normalizeCueStderrForDisplay,
  normalizeCueTailBytes,
  normalizeCueLimit,
  normalizeCueTimeoutSeconds,
  normalizeCueBoolean,
  resolveCueWorkingDirectory,
  normalizeCueResourceNeeds,
  resolvePythonRunner,
} from "./tools/register.ts";

export { default } from "./tools/register.ts";
