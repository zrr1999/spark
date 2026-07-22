/**
 * Compaction types/settings for native JSONL session transcripts.
 *
 * Sink deferred: see ./README.md (or host SINK notes). Full transcript
 * compaction is coupled to TUI host session-store + session-navigation.
 */

export type SparkCompactionTokenSource = "reported" | "tokenizer" | "estimated";

export type SparkCompactionFallbackReason =
  | "model_unavailable"
  | "model_error"
  | "invalid_summary"
  | "deterministic_requested";

export type SparkCompactModelSelection = string;

export interface SparkCompactionSettings {
  enabled: boolean;
  /** Context-window ratio that triggers one stateless micro-compaction pass. */
  microThreshold: number;
  /** Context-window ratio that triggers full semantic compaction after micro-compaction. */
  fullThreshold: number;
  /** Fraction of the current compactable context that micro-compaction attempts to remove. */
  targetReduction: number;
  /** Stop a micro-compaction pass when it cannot remove this fraction of its input. */
  minUsefulReduction: number;
  /** `current` selects the active session model; any other value is an explicit model id. */
  compactModel: SparkCompactModelSelection;
  /** Legacy full-compaction trigger retained while V2 runtime scheduling is adopted. */
  reserveTokens: number;
  /** Recent context protected from full compaction. */
  keepRecentTokens: number;
}

export const CURRENT_SPARK_COMPACTION_SUMMARY_VERSION = 2;

export const DEFAULT_SPARK_COMPACTION_SETTINGS: SparkCompactionSettings = {
  enabled: true,
  microThreshold: 0.75,
  fullThreshold: 0.9,
  targetReduction: 0.4,
  minUsefulReduction: 0.05,
  compactModel: "current",
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};
