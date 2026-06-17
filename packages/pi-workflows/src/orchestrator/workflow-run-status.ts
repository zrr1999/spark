import type { WorkflowRunRecord, WorkflowRunStatus } from "./index.ts";

export function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "timed_out" || status === "stale"
  );
}

export function isAcknowledgeableWorkflowRun(run: WorkflowRunRecord): run is WorkflowRunRecord & {
  status: Extract<WorkflowRunStatus, "failed" | "stale" | "timed_out">;
} {
  return run.status === "failed" || run.status === "stale" || run.status === "timed_out";
}

export function isAcknowledgedWorkflowRunProblem(run: WorkflowRunRecord): boolean {
  return isAcknowledgeableWorkflowRun(run) && Boolean(run.acknowledgedAt);
}

export function isActionableWorkflowRunProblem(run: WorkflowRunRecord): boolean {
  return isAcknowledgeableWorkflowRun(run) && !isAcknowledgedWorkflowRunProblem(run);
}
