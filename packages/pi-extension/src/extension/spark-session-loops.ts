/** Compatibility shim: session loop state is owned by @zendev-lab/spark-loop. */
export {
  clearSessionLoop,
  clearSessionLoopSchedule,
  importLegacySessionLoop,
  loadSessionLoop,
  normalizeLoopDelayMs,
  normalizeLoopObjective,
  scheduleSessionLoopTick,
  sessionLoopStorePath,
  setSessionLoop,
  updateSessionLoopStatus,
} from "@zendev-lab/spark-loop";
export type {
  SparkSessionLoop,
  SparkSessionLoopRetryState,
  SparkSessionLoopScheduleState,
  SparkSessionLoopSource,
  SparkSessionLoopStatus,
} from "@zendev-lab/spark-loop";
