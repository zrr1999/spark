/** Compatibility shim: session goal state is owned by @zendev-lab/spark-loop. */
export {
  clearSessionGoal,
  editSessionGoalObjective,
  importLegacySessionGoal,
  inferSessionGoalObjective,
  loadSessionGoal,
  normalizeGoalObjective,
  normalizeOptionalReason,
  sessionGoalStorePath,
  setSessionGoal,
  updateSessionGoalStatus,
} from "@zendev-lab/spark-loop";
export type {
  SparkSessionGoal,
  SparkSessionGoalReviewSummary,
  SparkSessionGoalSource,
  SparkSessionGoalStatus,
} from "@zendev-lab/spark-loop";
