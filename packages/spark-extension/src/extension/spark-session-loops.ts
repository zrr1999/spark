/** Compatibility shim: session loop state is owned by @zendev-lab/spark-loop. */
export {
  clearSessionLoop,
  importLegacySessionLoop,
  loadSessionLoop,
  normalizeLoopDelayMs,
  normalizeLoopObjective,
  sessionLoopStorePath,
  setSessionLoop,
  updateSessionLoopStatus,
} from "@zendev-lab/spark-loop";
export type {
  SparkSessionLoop,
  SparkSessionLoopSource,
  SparkSessionLoopStatus,
} from "@zendev-lab/spark-loop";
