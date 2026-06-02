import { nowIso, type RunRef, type TaskRun, type TaskRunCompletionSummary } from "spark-core";

import type {
  SparkDagCompletionFollowUp,
  SparkDagRunNextSteps,
  SparkDagRunRecord,
} from "./index.ts";
import { isAcknowledgeableDagRun, isAcknowledgedDagRunProblem } from "./dag-run-status.ts";

export function createSparkDagCompletionFollowUp(
  run: SparkDagRunRecord,
): SparkDagCompletionFollowUp {
  const digest = run.completionDigest;
  const digestSuffix =
    digest.length > 0 ? ` Digest: ${formatSparkDagCompletionDigest(digest)}.` : "";
  return {
    createdAt: nowIso(),
    runRef: run.ref,
    status: run.status,
    scheduled: run.scheduled,
    completed: run.completed,
    summary: `Spark workflow run: ${run.ref} ${run.status}: scheduled ${run.scheduled}, completed ${run.completed}.${digestSuffix}`,
    nextActions: sparkDagRunNextActions(run),
    completionDigest: digest.map(cloneTaskRunCompletionSummary),
  };
}

export function completionDigestFromTaskRuns(runs: TaskRun[]): TaskRunCompletionSummary[] {
  return runs
    .flatMap((run) => (run.completionSummary ? [run.completionSummary] : []))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10)
    .map(cloneTaskRunCompletionSummary);
}

export function normalizeTaskRunCompletionSummaries(
  summaries: TaskRunCompletionSummary[] | undefined,
): TaskRunCompletionSummary[] {
  return (summaries ?? []).map(cloneTaskRunCompletionSummary);
}

export function collectSparkDagRunNextSteps(
  runs: Array<SparkDagRunRecord | undefined>,
): SparkDagRunNextSteps[] {
  const seen = new Set<RunRef>();
  const nextSteps: SparkDagRunNextSteps[] = [];
  for (const run of runs) {
    const steps = run ? sparkDagRunNextSteps(run) : undefined;
    if (!steps || seen.has(steps.runRef)) continue;
    seen.add(steps.runRef);
    nextSteps.push(steps);
  }
  return nextSteps;
}

export function sparkDagRunNextSteps(run: SparkDagRunRecord): SparkDagRunNextSteps | undefined {
  if (!isAcknowledgeableDagRun(run) || isAcknowledgedDagRunProblem(run)) return undefined;
  return {
    runRef: run.ref,
    status: run.status,
    summary: `Next steps for ${run.status} Spark workflow run ${run.ref}`,
    nextActions: sparkDagRunNextActions(run),
  };
}

function formatSparkDagCompletionDigest(summaries: TaskRunCompletionSummary[]): string {
  const visible = summaries.slice(0, 3).map((summary) => {
    const role = summary.roleRef ? ` role=${summary.roleRef.replace(/^role:/u, "")}` : "";
    const artifacts =
      summary.artifactRefs.length > 0 ? ` artifacts=${summary.artifactRefs.join(",")}` : "";
    return `task=${summary.taskRef} run=${summary.runRef} status=${summary.status}${role}: ${summary.summary}${artifacts}`;
  });
  const hidden = summaries.length - visible.length;
  if (hidden > 0) visible.push(`… ${hidden} more role-run completion(s)`);
  return visible.join("; ");
}

function cloneTaskRunCompletionSummary(
  summary: TaskRunCompletionSummary,
): TaskRunCompletionSummary {
  return { ...summary, artifactRefs: [...summary.artifactRefs] };
}

function sparkDagRunNextActions(run: SparkDagRunRecord): string[] {
  const nextActions: string[] = [];
  if (run.status === "failed") {
    nextActions.push(
      "failed: inspect spark_background_runs inspect plus child task-run artifacts/logs to find the failed or cancelled role-run.",
      "failed: fix the task, role, model, or dependency error, then rerun ready background work for the remaining ready frontier.",
    );
  } else if (run.status === "stale") {
    nextActions.push(
      "stale: run spark_background_runs reconcile and compare background records with task runs/claims; the manager lost track of child process completion.",
      "stale: preserve useful evidence, acknowledge known stale failures with spark_background_runs ack if no more action is needed, then retry ready tasks only after the task graph state is consistent.",
    );
  } else if (run.status === "timed_out") {
    nextActions.push(
      "timed_out: legacy foreground timeout record; inspect spark_background_runs status for active role-runs or reconcile before retrying.",
      "timed_out: if child work is still active, kill stuck children with spark_background_runs kill only when you explicitly want to stop it.",
    );
  }
  if (run.scheduled === 0)
    nextActions.push(
      "No tasks were scheduled; check pending tasks for dependency or plan-readiness blockers.",
    );
  if (run.completed < run.scheduled)
    nextActions.push(
      "Review incomplete scheduled task runs in spark_status view=full before launching another workflow wave.",
    );
  if (nextActions.length === 0)
    nextActions.push("Review task outputs and continue with newly unblocked ready tasks if any.");
  return nextActions;
}
