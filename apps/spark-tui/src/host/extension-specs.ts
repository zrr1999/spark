/**
 * One default extension profile shared by config loading and host bootstrap.
 * Optional capabilities such as Graft stay out of this list and may be added
 * explicitly through config or `--extension`.
 */
export const DEFAULT_SPARK_EXTENSION_SPECS = [
  "@zendev-lab/spark-ask/extension",
  "@zendev-lab/spark-cue/extension",
  "@zendev-lab/spark-files/extension",
  "@zendev-lab/spark-ai/models-extension",
  "@zendev-lab/spark-memory/extension",
  "@zendev-lab/spark-roles/extension",
  "@zendev-lab/spark-session/extension",
  "@zendev-lab/spark-web/extension",
  "@zendev-lab/spark-extension/extension",
] as const;
