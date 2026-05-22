export type SparkCopyLanguage = "en" | "zh";

export function detectCopyLanguage(text: string): SparkCopyLanguage {
  return /[\u4e00-\u9fff]/u.test(text) ? "zh" : "en";
}
