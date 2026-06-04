/**
 * Output language detection for copy templates and rendered prompts.
 *
 * Lives in `spark-core` (not `pi-ask`) because the heuristic is shared by
 * Spark-side rendering paths beyond ask flows: SPARK.md initialization,
 * project intent rendering, and ask-tool i18n. Keep this primitive small and
 * dependency-free.
 */

export type CopyLanguage = "en" | "zh";

export function detectCopyLanguage(text: string): CopyLanguage {
  return /[\u4e00-\u9fff]/u.test(text) ? "zh" : "en";
}
