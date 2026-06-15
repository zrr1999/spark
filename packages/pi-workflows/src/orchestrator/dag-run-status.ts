import type { WorkflowRunRecord, WorkflowRunStatus } from "./index.ts";

export function isTerminalDagRunStatus(status: WorkflowRunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "timed_out" || status === "stale"
  );
}

export function isAcknowledgeableDagRun(run: WorkflowRunRecord): run is WorkflowRunRecord & {
  status: Extract<WorkflowRunStatus, "failed" | "stale" | "timed_out">;
} {
  return run.status === "failed" || run.status === "stale" || run.status === "timed_out";
}

export function isAcknowledgedDagRunProblem(run: WorkflowRunRecord): boolean {
  return isAcknowledgeableDagRun(run) && Boolean(run.acknowledgedAt);
}

export function isActionableDagRunProblem(run: WorkflowRunRecord): boolean {
  return isAcknowledgeableDagRun(run) && !isAcknowledgedDagRunProblem(run);
}
