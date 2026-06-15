import {
  workflowRunNextSteps,
  type WorkflowRunRecord,
  type WorkflowRunStatusSummary,
} from "@zendev-lab/pi-workflows";

export function appendCompactSparkDagStatusLines(
  lines: string[],
  dagStatus: WorkflowRunStatusSummary,
): WorkflowRunRecord | undefined {
  const compactRun = dagStatus.activeRun ?? dagStatus.actionableRun;
  if (!compactRun) return undefined;
  const runKind = compactRun.ref === dagStatus.activeRun?.ref ? "active" : "actionable";
  lines.push(
    `Spark workflow runs: ${dagStatus.manager.status} ${runKind}=${compactRun.ref} | running=${dagStatus.running} actionable=${dagStatus.actionable}`,
  );
  return compactRun;
}

export function appendSparkDagStatusLines(
  lines: string[],
  dagStatus: WorkflowRunStatusSummary,
): void {
  const managerSuffix = dagStatus.manager.activeRunRef
    ? ` active=${dagStatus.manager.activeRunRef}`
    : "";
  lines.push(
    `Spark workflow runs: ${dagStatus.manager.status}${managerSuffix} runs=${dagStatus.recentRuns.length} recent | running=${dagStatus.running} succeeded=${dagStatus.succeeded} failed=${dagStatus.failed} stale=${dagStatus.stale} timed_out=${dagStatus.timedOut} acknowledged=${dagStatus.acknowledged}`,
  );
  if (dagStatus.lastRun) {
    lines.push(`  Last workflow run: ${formatSparkDagRun(dagStatus.lastRun)}`);
    appendSparkDagRunNextStepLines(lines, dagStatus.lastRun, "  ");
  }
  if (dagStatus.activeRun && dagStatus.activeRun.ref !== dagStatus.lastRun?.ref) {
    lines.push(`  Active workflow run: ${formatSparkDagRun(dagStatus.activeRun)}`);
    appendSparkDagRunNextStepLines(lines, dagStatus.activeRun, "  ");
  }
  if (dagStatus.recentRuns.length > 0) {
    lines.push("  Recent workflow runs:");
    for (const run of dagStatus.recentRuns) lines.push(`    - ${formatSparkDagRun(run)}`);
  }
}

export function formatSparkDagRun(run: WorkflowRunRecord): string {
  const finishedSuffix = run.finishedAt ? ` finished=${run.finishedAt}` : "";
  const timeoutSuffix = run.timedOut ? " timed_out=true" : "";
  const ackSuffix = run.acknowledgedAt
    ? ` acknowledgedAt=${run.acknowledgedAt} acknowledgedBySession=${run.acknowledgedBySession ?? "unknown"}`
    : "";
  return `${run.ref} [${run.status}] scheduled=${run.scheduled} completed=${run.completed} maxConcurrency=${run.maxConcurrency} timeoutMs=${run.timeoutMs} updated=${run.updatedAt}${finishedSuffix}${timeoutSuffix}${ackSuffix}`;
}

export function appendSparkDagRunNextStepLines(
  lines: string[],
  run: WorkflowRunRecord,
  indent: string,
): void {
  const nextSteps = workflowRunNextSteps(run);
  if (!nextSteps) return;
  lines.push(`${indent}Next steps (${nextSteps.status}):`);
  for (const action of nextSteps.nextActions) lines.push(`${indent}  - ${action}`);
}
