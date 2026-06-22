import {
  workflowRunNextSteps,
  type WorkflowRunRecord,
  type WorkflowRunStatusSummary,
} from "@zendev-lab/pi-workflows";

export function appendCompactSparkWorkflowRunStatusLines(
  lines: string[],
  workflowRunStatus: WorkflowRunStatusSummary,
): WorkflowRunRecord | undefined {
  const compactRun = workflowRunStatus.activeRun ?? workflowRunStatus.actionableRun;
  if (!compactRun) return undefined;
  const runKind = compactRun.ref === workflowRunStatus.activeRun?.ref ? "active" : "actionable";
  lines.push(
    `Spark workflow runs: ${workflowRunStatus.manager.status} ${runKind}=${compactRun.ref} | running=${workflowRunStatus.running} actionable=${workflowRunStatus.actionable}`,
  );
  return compactRun;
}

export function appendSparkWorkflowRunStatusLines(
  lines: string[],
  workflowRunStatus: WorkflowRunStatusSummary,
): void {
  const managerSuffix = workflowRunStatus.manager.activeRunRef
    ? ` active=${workflowRunStatus.manager.activeRunRef}`
    : "";
  lines.push(
    `Spark workflow runs: ${workflowRunStatus.manager.status}${managerSuffix} runs=${workflowRunStatus.recentRuns.length} recent | running=${workflowRunStatus.running} succeeded=${workflowRunStatus.succeeded} failed=${workflowRunStatus.failed} stale=${workflowRunStatus.stale} timed_out=${workflowRunStatus.timedOut} acknowledged=${workflowRunStatus.acknowledged}`,
  );
  if (workflowRunStatus.lastRun) {
    lines.push(`  Last workflow run: ${formatSparkWorkflowRun(workflowRunStatus.lastRun)}`);
    appendSparkWorkflowRunNextStepLines(lines, workflowRunStatus.lastRun, "  ");
  }
  if (
    workflowRunStatus.activeRun &&
    workflowRunStatus.activeRun.ref !== workflowRunStatus.lastRun?.ref
  ) {
    lines.push(`  Active workflow run: ${formatSparkWorkflowRun(workflowRunStatus.activeRun)}`);
    appendSparkWorkflowRunNextStepLines(lines, workflowRunStatus.activeRun, "  ");
  }
  if (workflowRunStatus.recentRuns.length > 0) {
    lines.push("  Recent workflow runs:");
    for (const run of workflowRunStatus.recentRuns)
      lines.push(`    - ${formatSparkWorkflowRun(run)}`);
  }
}

export function formatSparkWorkflowRun(run: WorkflowRunRecord): string {
  const finishedSuffix = run.finishedAt ? ` finished=${run.finishedAt}` : "";
  const timeoutSuffix = run.timedOut ? " timed_out=true" : "";
  const ackSuffix = run.acknowledgedAt
    ? ` acknowledgedAt=${run.acknowledgedAt} acknowledgedBySession=${run.acknowledgedBySession ?? "unknown"}`
    : "";
  return `${run.ref} [${run.status}] scheduled=${run.scheduled} completed=${run.completed} maxConcurrency=${run.maxConcurrency} timeoutMs=${run.timeoutMs} updated=${run.updatedAt}${finishedSuffix}${timeoutSuffix}${ackSuffix}`;
}

export function appendSparkWorkflowRunNextStepLines(
  lines: string[],
  run: WorkflowRunRecord,
  indent: string,
): void {
  const nextSteps = workflowRunNextSteps(run);
  if (!nextSteps) return;
  lines.push(`${indent}Next steps (${nextSteps.status}):`);
  for (const action of nextSteps.nextActions) lines.push(`${indent}  - ${action}`);
}
