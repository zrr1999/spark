/** Session-store package surface (kept import-stable via ../session-store.ts). */

export {
  CURRENT_SPARK_SESSION_VERSION,
  type SparkSessionHeader,
  type SparkSessionEntryBase,
  type SparkSessionMessage,
  type SparkSessionMessageEntry,
  type SparkThinkingLevelChangeEntry,
  type SparkModelChangeEntry,
  type SparkCompactionOutcomeMetadata,
  type SparkCompactionEntry,
  type SparkBranchSummaryEntry,
  type SparkCustomEntry,
  type SparkCustomMessageEntry,
  type SparkLabelEntry,
  type SparkSessionInfoEntry,
  type SparkSessionEntry,
  type SparkSessionFileEntry,
  type SparkSessionRecord,
  type SparkSessionInfo,
  type SparkSessionStoreOptions,
  type NewSparkSessionOptions,
} from "./types.ts";
export {
  SparkSessionStore,
  defaultSparkSessionsRoot,
  defaultSparkHome,
  workspaceSessionHash,
  parseSparkSessionEntries,
  writeJsonLinesAtomically,
} from "./store.ts";
