import type { SparkDagRunRecord, SparkDagRunStatus } from "./index.ts";

export function isTerminalDagRunStatus(status: SparkDagRunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "timed_out" || status === "stale"
  );
}

export function isAcknowledgeableDagRun(run: SparkDagRunRecord): run is SparkDagRunRecord & {
  status: Extract<SparkDagRunStatus, "failed" | "stale" | "timed_out">;
} {
  return run.status === "failed" || run.status === "stale" || run.status === "timed_out";
}

export function isAcknowledgedDagRunProblem(run: SparkDagRunRecord): boolean {
  return isAcknowledgeableDagRun(run) && Boolean(run.acknowledgedAt);
}

export function isActionableDagRunProblem(run: SparkDagRunRecord): boolean {
  return isAcknowledgeableDagRun(run) && !isAcknowledgedDagRunProblem(run);
}
