import type { RunRef, TaskRef, ProjectRef } from "@zendev-lab/pi-extension-api";
import type { WorkflowRunRecord } from "@zendev-lab/pi-workflows";
import type {
  SparkBackgroundChildRunView,
  SparkBackgroundRunView,
  SparkBackgroundRunsDetails,
  SparkBackgroundSummaryState,
} from "./background-runs.ts";

export function isActionableProblemRun(run: WorkflowRunRecord): boolean {
  return isProblemRun(run) && !run.acknowledgedAt;
}

export function runInProjectScope(
  run: WorkflowRunRecord,
  projectRef: ProjectRef | undefined,
): boolean {
  return !projectRef || !run.projectRef || run.projectRef === projectRef;
}

export function backgroundRunView(
  run: WorkflowRunRecord,
  activeChildren: SparkBackgroundChildRunView[],
): SparkBackgroundRunView {
  const completed = new Set(run.completedTaskRefs);
  const nextActions = backgroundRunNextActions(run, activeChildren.length);
  return {
    runRef: run.ref,
    status: run.status,
    legacyTimedOut: run.status === "timed_out" || run.timedOut,
    projectRef: run.projectRef,
    ownerSessionId: run.ownerSessionId,
    scheduled: run.scheduled,
    completed: run.completed,
    taskRunRefs: run.taskRunRefs,
    incompleteTaskRefs: run.scheduledTaskRefs.filter((taskRef) => !completed.has(taskRef)),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    acknowledgedAt: run.acknowledgedAt,
    nextActions,
  };
}

export function selectBackgroundRuns(input: {
  runs: WorkflowRunRecord[];
  projectRef?: ProjectRef;
  includeHistory: boolean;
  targetRunRef?: RunRef;
  targetTaskRef?: TaskRef;
}): WorkflowRunRecord[] {
  const sorted = [...input.runs]
    .filter((run) => runInProjectScope(run, input.projectRef))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (input.targetRunRef) {
    const targetRunRef = input.targetRunRef;
    const direct = sorted.filter((run) => run.ref === targetRunRef);
    if (direct.length > 0) return direct;
    const parent = sorted.filter((run) => run.taskRunRefs.includes(targetRunRef));
    if (parent.length > 0) return parent;
  }
  if (input.targetTaskRef) {
    const targetTaskRef = input.targetTaskRef;
    const taskRuns = sorted.filter((run) => run.scheduledTaskRefs.includes(targetTaskRef));
    if (taskRuns.length > 0) return taskRuns;
  }
  if (input.includeHistory) return sorted.slice(0, 10);
  return sorted
    .filter((run) => run.status === "running" || isActionableProblemRun(run))
    .slice(0, 10);
}

export function summarizeBackgroundRuns(input: {
  runs: SparkBackgroundRunView[];
  childRuns: SparkBackgroundChildRunView[];
}): SparkBackgroundRunsDetails["summary"] {
  const activeRun = input.runs.find((run) => run.status === "running");
  const activeChildren = input.childRuns.filter((child) => child.activeProcess).length;
  const actionable = input.runs.filter(
    (run) =>
      (run.status === "failed" || run.status === "stale" || run.status === "timed_out") &&
      !run.acknowledgedAt,
  );
  const problem = actionable[0];
  const scheduled = activeRun?.scheduled ?? problem?.scheduled ?? 0;
  const completed = activeRun?.completed ?? problem?.completed ?? 0;
  if (activeRun && activeChildren > 0) {
    return {
      state: "running",
      activeRunRef: activeRun?.runRef,
      activeChildren,
      scheduled,
      completed,
      actionableProblems: actionable.length,
      nextAction: "wait, inspect a child run, or kill a child only if it is non-responsive",
    };
  }
  if (activeRun) {
    return {
      state: "stale",
      activeRunRef: activeRun.runRef,
      activeChildren,
      scheduled,
      completed,
      actionableProblems: actionable.length,
      nextAction: "reconcile; if still incomplete, inspect stale tasks",
    };
  }
  if (problem?.status === "stale" && activeChildren > 0) {
    return {
      state: "running",
      activeChildren,
      scheduled,
      completed,
      actionableProblems: actionable.length,
      nextAction: "wait or inspect active children; reconcile stale records if progress stops",
    };
  }
  if (problem) {
    const state: SparkBackgroundSummaryState =
      problem.status === "timed_out"
        ? "legacy_timeout"
        : problem.status === "stale"
          ? "stale"
          : "needs_attention";
    return {
      state,
      activeChildren,
      scheduled,
      completed,
      actionableProblems: actionable.length,
      nextAction:
        activeChildren > 0
          ? "inspect the failed background record and kill non-responsive active children only if needed"
          : (problem.nextActions[0] ?? "inspect the problem record before continuing"),
    };
  }
  if (activeChildren > 0) {
    return {
      state: "running",
      activeChildren,
      scheduled,
      completed,
      actionableProblems: 0,
      nextAction: "wait, inspect a child run, or kill a child only if it is non-responsive",
    };
  }
  return {
    state: "idle",
    activeChildren,
    scheduled: 0,
    completed: 0,
    actionableProblems: 0,
    nextAction: "no background work is active",
  };
}

function isProblemRun(run: WorkflowRunRecord): boolean {
  return run.status === "failed" || run.status === "stale" || run.status === "timed_out";
}

function backgroundRunNextActions(run: WorkflowRunRecord, activeChildren: number): string[] {
  if (run.status === "running" && activeChildren > 0)
    return ["wait, inspect a child run, or kill a child only if it is non-responsive"];
  if (run.status === "running")
    return ["reconcile; if still incomplete, inspect stale tasks before starting more work"];
  if (run.status === "failed")
    return ["inspect the failed task/run, fix the cause, then rerun the ready frontier"];
  if (run.status === "stale")
    return [
      "reconcile with task runs and active processes; ack only after the stale record is understood",
    ];
  if (run.status === "timed_out")
    return [
      "legacy foreground timeout record; reconcile and inspect incomplete child runs before acking",
    ];
  return ["no action is required for this completed background record"];
}
