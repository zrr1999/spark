/**
 * Pi-compatible JSONL session record types for the native TUI/host.
 *
 * Not sunk into @zendev-lab/spark-session: that package owns the daemon
 * registry/mailbox/`session({action})` surface, while this format is the
 * local host append-only transcript (Pi-compatible key names).
 */

export const CURRENT_SPARK_SESSION_VERSION = 3;

export interface SparkSessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SparkSessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SparkSessionMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export interface SparkSessionMessageEntry extends SparkSessionEntryBase {
  type: "message";
  message: SparkSessionMessage;
}

export interface SparkThinkingLevelChangeEntry extends SparkSessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface SparkModelChangeEntry extends SparkSessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface SparkCompactionOutcomeMetadata {
  summaryVersion: number;
  tokenSource: "reported" | "tokenizer" | "estimated";
  measuredReductionRatio: number;
  fallbackReason?:
    | "model_unavailable"
    | "model_error"
    | "invalid_summary"
    | "deterministic_requested";
}

export interface SparkCompactionEntry<T = unknown> extends SparkSessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  metadata?: SparkCompactionOutcomeMetadata;
  fromHook?: boolean;
}

export interface SparkBranchSummaryEntry<T = unknown> extends SparkSessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
}

export interface SparkCustomEntry<T = unknown> extends SparkSessionEntryBase {
  type: "custom";
  customType: string;
  data?: T;
}

export interface SparkCustomMessageEntry<T = unknown> extends SparkSessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  details?: T;
  display: boolean;
}

export interface SparkLabelEntry extends SparkSessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SparkSessionInfoEntry extends SparkSessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SparkSessionEntry =
  | SparkSessionMessageEntry
  | SparkThinkingLevelChangeEntry
  | SparkModelChangeEntry
  | SparkCompactionEntry
  | SparkBranchSummaryEntry
  | SparkCustomEntry
  | SparkCustomMessageEntry
  | SparkLabelEntry
  | SparkSessionInfoEntry;

export type SparkSessionFileEntry = SparkSessionHeader | SparkSessionEntry;

export interface SparkSessionRecord {
  path: string;
  header: SparkSessionHeader;
  entries: SparkSessionEntry[];
}

export interface SparkSessionInfo {
  path: string;
  id: string;
  cwd: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
  name?: string;
}

export interface SparkSessionStoreOptions {
  cwd: string;
  /** Defaults to the effective Spark user data root sessions directory. */
  sparkHome?: string;
  /** Overrides sparkHome/sessions, mainly for tests. */
  sessionsRoot?: string;
}

export interface NewSparkSessionOptions {
  id?: string;
  parentSession?: string;
  timestamp?: string;
}
