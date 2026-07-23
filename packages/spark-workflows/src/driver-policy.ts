import type { SparkDriverPolicyDefinition } from "@zendev-lab/spark-core";

export const sparkWorkflowDriverPolicy = {
  kind: "workflow",
  // workflow_driver owns the continue/stop decision for each successful tick.
  // If the adapter was not called, fail dormant instead of polling forever.
  success: { status: "dormant" },
  retryDelaysMs: [1_000, 2_000, 5_000, 10_000, 30_000],
} as const satisfies SparkDriverPolicyDefinition;
