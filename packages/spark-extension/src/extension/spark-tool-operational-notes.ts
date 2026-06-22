interface SparkToolOperationalNotes {
  atomic: string;
  idempotent: string;
  prerequisites: string[];
}

const DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES: SparkToolOperationalNotes = {
  atomic: "read-only",
  idempotent: "yes; repeated calls only re-read current Spark state",
  prerequisites: ["Spark state exists in the current workspace."],
};

export function withSparkToolOperationalNotes(_toolName: string, description: string): string {
  const notes = DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES;
  return [
    description.trimEnd(),
    "",
    `Atomic: ${notes.atomic}`,
    `Idempotent: ${notes.idempotent}`,
    "Prerequisites:",
    ...notes.prerequisites.map((item) => `- ${item}`),
  ].join("\n");
}
