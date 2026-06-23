import {
  nowIso,
  type RunRef,
  type TaskRun,
  type TaskRunCompletionSummary,
} from "@zendev-lab/pi-extension-api";

import type {
  WorkflowRunCompletionFollowUp,
  WorkflowRunNextSteps,
  WorkflowRunRecord,
} from "./index.ts";
import {
  isAcknowledgeableWorkflowRun,
  isAcknowledgedWorkflowRunProblem,
} from "./workflow-run-status.ts";

export function createWorkflowRunCompletionFollowUp(
  run: WorkflowRunRecord,
): WorkflowRunCompletionFollowUp {
  const digest = run.completionDigest;
  const digestSuffix =
    digest.length > 0 ? ` Digest: ${formatWorkflowRunCompletionDigest(digest)}.` : "";
  return {
    createdAt: nowIso(),
    runRef: run.ref,
    status: run.status,
    scheduled: run.scheduled,
    completed: run.completed,
    summary: `Workflow run: ${run.ref} ${run.status}: scheduled ${run.scheduled}, completed ${run.completed}.${digestSuffix}`,
    nextActions: workflowRunNextActions(run),
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

export function collectWorkflowRunNextSteps(
  runs: Array<WorkflowRunRecord | undefined>,
): WorkflowRunNextSteps[] {
  const seen = new Set<RunRef>();
  const nextSteps: WorkflowRunNextSteps[] = [];
  for (const run of runs) {
    const steps = run ? workflowRunNextSteps(run) : undefined;
    if (!steps || seen.has(steps.runRef)) continue;
    seen.add(steps.runRef);
    nextSteps.push(steps);
  }
  return nextSteps;
}

export function workflowRunNextSteps(run: WorkflowRunRecord): WorkflowRunNextSteps | undefined {
  if (!isAcknowledgeableWorkflowRun(run) || isAcknowledgedWorkflowRunProblem(run)) return undefined;
  return {
    runRef: run.ref,
    status: run.status,
    summary: `Next steps for ${run.status} workflow run ${run.ref}`,
    nextActions: workflowRunNextActions(run),
  };
}

function formatWorkflowRunCompletionDigest(summaries: TaskRunCompletionSummary[]): string {
  const visible = summaries.slice(0, 3).map((summary) => {
    const role = summary.roleRef ? ` role=${summary.roleRef.replace(/^role:/u, "")}` : "";
    const artifacts =
      summary.artifactRefs.length > 0 ? ` artifacts=${summary.artifactRefs.join(",")}` : "";
    return `task=${summary.taskRef} run=${summary.runRef} status=${summary.status}${role}: ${summary.summary}${artifacts}`;
  });
  const hidden = summaries.length - visible.length;
  if (hidden > 0) visible.push(`… ${hidden} more child run completion(s)`);
  return visible.join("; ");
}

function cloneTaskRunCompletionSummary(
  summary: TaskRunCompletionSummary,
): TaskRunCompletionSummary {
  return { ...summary, artifactRefs: [...summary.artifactRefs] };
}

function workflowRunNextActions(run: WorkflowRunRecord): string[] {
  const nextActions: string[] = [];
  if (run.status === "failed") {
    nextActions.push(
      'failed: inspect task_read({ action: "run_status", runAction: "inspect" }) plus child task-run artifacts/logs to find the failed or cancelled child run.',
      "failed: fix the task, executor, model, or dependency error, then rerun ready background work for the remaining ready frontier.",
    );
  } else if (run.status === "stale") {
    nextActions.push(
      'stale: run task_read({ action: "run_status", runAction: "reconcile" }) and compare background records with task runs/claims; the manager lost track of child process completion.',
      "stale: preserve useful evidence, resolve known stale failures in the task graph, then retry assignment only after the task graph state is consistent.",
    );
  } else if (run.status === "timed_out") {
    nextActions.push(
      'timed_out: historical foreground timeout record; inspect task_read({ action: "run_status" }) for active child runs or reconcile before retrying.',
      "timed_out: if child work is still active, stop stuck children through explicit host run-management controls only when you intend to cancel them.",
    );
  }
  if (run.scheduled === 0)
    nextActions.push(
      "No tasks were scheduled; check pending tasks for dependency or plan-readiness blockers.",
    );
  if (run.completed < run.scheduled)
    nextActions.push(
      'Review incomplete scheduled task runs with task_read({ action: "run_status", runAction: "inspect", runRef: "<run ref>" }) or targeted task_read({ action: "task_status", taskRef: "<task ref>" }) before launching another workflow wave.',
    );
  if (nextActions.length === 0)
    nextActions.push("Review task outputs and continue with newly unblocked ready tasks if any.");
  return nextActions;
}
