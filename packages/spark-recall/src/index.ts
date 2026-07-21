/**
 * Compatibility facade: recall candidates now live in `@zendev-lab/spark-memory`.
 * Prefer importing from `@zendev-lab/spark-memory` or `@zendev-lab/spark-memory/recall`.
 */
export {
  RecallStore,
  RecallStoreFormatError,
  defaultRecallStore,
  recallStorePath,
  type RecallCandidate,
  type RecallCandidateStatus,
  type RecallScope,
  type RecallStorePaths,
  type RecallStoreSnapshot,
} from "@zendev-lab/spark-memory/recall";
