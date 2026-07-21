/**
 * Compatibility facade: LearningStore / learning tool live in `@zendev-lab/spark-memory`.
 * Reflection pipelines remain here until they move with the next memory slice.
 */
export * from "@zendev-lab/spark-memory/learning";
export {
  registerPiLearningTool,
  type PiLearningAction,
  type PiLearningActionHandler,
  type PiLearningActionHandlerArgs,
  type PiLearningExtensionApi,
  type PiLearningToolHandlers,
  type PiLearningToolOptions,
  type PiLearningToolResult,
} from "@zendev-lab/spark-memory/learning/extension";
export * from "./reflection-candidate-inbox.ts";
export * from "./reflection-in-session-scheduler.ts";
export * from "./reflection-session-scanner.ts";
export * from "./reflection-synthesis-engine.ts";
