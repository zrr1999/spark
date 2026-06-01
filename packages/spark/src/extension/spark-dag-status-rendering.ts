import {
  sparkDagRunNextSteps,
  type SparkDagRunRecord,
  type SparkDagStatusSummary,
} from "spark-orchestrator";

export function appendCompactSparkDagStatusLines(
  lines: string[],
  dagStatus: SparkDagStatusSummary,
): SparkDagRunRecord | undefined {
  const compactRun = dagStatus.activeRun ?? dagStatus.actionableRun;
  if (!compactRun) return undefined;
  const runKind = compactRun.ref === dagStatus.activeRun?.ref ? "active" : "actionable";
  lines.push(
    `Spark orchestrator: ${dagStatus.manager.status} ${runKind}=${compactRun.ref} | running=${dagStatus.running} actionable=${dagStatus.actionable}`,
  );
  return compactRun;
}

export function appendSparkDagStatusLines(lines: string[], dagStatus: SparkDagStatusSummary): void {
  const managerSuffix = dagStatus.manager.activeRunRef
    ? ` active=${dagStatus.manager.activeRunRef}`
    : "";
  lines.push(
    `Spark orchestrator: ${dagStatus.manager.status}${managerSuffix} runs=${dagStatus.recentRuns.length} recent | running=${dagStatus.running} succeeded=${dagStatus.succeeded} failed=${dagStatus.failed} stale=${dagStatus.stale} timed_out=${dagStatus.timedOut} acknowledged=${dagStatus.acknowledged}`,
  );
  if (dagStatus.lastRun) {
    lines.push(`  Last DAG run: ${formatSparkDagRun(dagStatus.lastRun)}`);
    appendSparkDagRunNextStepLines(lines, dagStatus.lastRun, "  ");
  }
  if (dagStatus.activeRun && dagStatus.activeRun.ref !== dagStatus.lastRun?.ref) {
    lines.push(`  Active DAG run: ${formatSparkDagRun(dagStatus.activeRun)}`);
    appendSparkDagRunNextStepLines(lines, dagStatus.activeRun, "  ");
  }
  if (dagStatus.recentRuns.length > 0) {
    lines.push("  Recent DAG runs:");
    for (const run of dagStatus.recentRuns) lines.push(`    - ${formatSparkDagRun(run)}`);
  }
}

export function formatSparkDagRun(run: SparkDagRunRecord): string {
  const finishedSuffix = run.finishedAt ? ` finished=${run.finishedAt}` : "";
  const timeoutSuffix = run.timedOut ? " timed_out=true" : "";
  const ackSuffix = run.acknowledgedAt
    ? ` acknowledgedAt=${run.acknowledgedAt} acknowledgedBySession=${run.acknowledgedBySession ?? "unknown"}`
    : "";
  return `${run.ref} [${run.status}] scheduled=${run.scheduled} completed=${run.completed} maxConcurrency=${run.maxConcurrency} timeoutMs=${run.timeoutMs} updated=${run.updatedAt}${finishedSuffix}${timeoutSuffix}${ackSuffix}`;
}

export function appendSparkDagRunNextStepLines(
  lines: string[],
  run: SparkDagRunRecord,
  indent: string,
): void {
  const nextSteps = sparkDagRunNextSteps(run);
  if (!nextSteps) return;
  lines.push(`${indent}Next steps (${nextSteps.status}):`);
  for (const action of nextSteps.nextActions) lines.push(`${indent}  - ${action}`);
}
