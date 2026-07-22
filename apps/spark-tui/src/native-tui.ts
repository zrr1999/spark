/**
 * Native Spark TUI surface — aggregation entry.
 *
 * Implementation lives under `./native-tui/`; this module keeps the historical
 * import path and public API stable for CLI, harnesses, and root tests.
 */

export {
  SPARK_NATIVE_KERNEL_SLASH_COMMANDS,
  SparkNativeSession,
  SparkNativeTuiApp,
  createSparkNativeLocalControlSlashCommands,
  createSparkNativeRuntimeSlashCommands,
  createSparkNativeSideThreadSlashCommands,
  createSparkNativeUiTransport,
  defaultSparkNativeResponder,
  prepareSparkNativeEditorInput,
  runNativeSparkTui,
  type RunNativeSparkTuiOptions,
  type SparkNativeAbortResult,
  type SparkNativeCockpitPanel,
  type SparkNativeCockpitSnapshot,
  type SparkNativeCustomMessageInput,
  type SparkNativeInteractionContext,
  type SparkNativeInteractionHandler,
  type SparkNativeMessage,
  type SparkNativeMessageRole,
  type SparkNativeQueueMode,
  type SparkNativeQueueSummary,
  type SparkNativeQueuedInput,
  type SparkNativeResponder,
  type SparkNativeResponderContext,
  type SparkNativeRuntimeCommandHost,
  type SparkNativeRuntimeSlashCommandOptions,
  type SparkNativeSlashCommand,
  type SparkNativeSlashCommandContext,
  type SparkNativeSlashCommandHandler,
  type SparkNativeSlashCommandMap,
  type SparkNativeSideThreadClient,
  type SparkNativeStatusContext,
  type SparkNativeToolMessageInput,
  type SparkNativeToolStatus,
  type SparkNativeToolStatusInput,
  type SparkNativeTuiAppOptions,
  type SparkNativeWorkspaceSessionMode,
  type SparkNativeWorkspaceSessionState,
} from "./native-tui/index.ts";
