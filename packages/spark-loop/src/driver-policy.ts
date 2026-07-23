import type { SparkDriverPolicyDefinition } from "@zendev-lab/spark-core";

export const sparkGoalDriverPolicy = {
  kind: "goal",
  success: { status: "scheduled", delayMs: 30_000 },
  retryDelaysMs: [30_000, 60_000, 120_000],
} as const satisfies SparkDriverPolicyDefinition;

export const sparkLoopDriverPolicy = {
  kind: "loop",
  success: { status: "dormant" },
  retryDelaysMs: [30_000, 60_000, 120_000],
} as const satisfies SparkDriverPolicyDefinition;
