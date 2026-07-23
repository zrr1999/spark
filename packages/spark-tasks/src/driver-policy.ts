import type { SparkDriverPolicyDefinition } from "@zendev-lab/spark-core";

export const sparkImplementDriverPolicy = {
  kind: "implement",
  // An implement turn must explicitly schedule the next tick after proving
  // that ready work remains. Missing that decision is dormant, not a spin.
  success: { status: "dormant" },
  retryDelaysMs: [30_000, 60_000, 120_000],
} as const satisfies SparkDriverPolicyDefinition;

export const sparkSessionTodoDriverPolicy = {
  kind: "session_todo",
  success: { status: "dormant" },
  retryDelaysMs: [30_000, 60_000, 120_000],
} as const satisfies SparkDriverPolicyDefinition;
