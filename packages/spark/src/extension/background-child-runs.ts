import type { RunRef, TaskRef, ProjectRef } from "@zendev-lab/pi-extension-api";
import type { WorkflowRunRecord } from "@zendev-lab/pi-workflows";
import {
  readRoleRunArtifactPreview,
  type ActiveSparkRoleRunProcess,
} from "@zendev-lab/spark-runtime";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import type { SparkBackgroundChildRunView, SparkBackgroundChildStatus } from "./background-runs.ts";

export function resolveBackgroundTaskRef(
  graph: TaskGraph,
  selector: string | undefined,
  projectRef: ProjectRef | undefined,
): TaskRef | undefined {
  if (!selector) return undefined;
  const normalized = selector.trim().replace(/^@/, "");
  const tasks = graph.tasks(projectRef);
  return tasks.find(
    (task) =>
      task.ref === selector ||
      task.ref === normalized ||
      task.name === normalized ||
      task.title === selector ||
      task.title === normalized,
  )?.ref;
}

export function collectBackgroundChildRuns(input: {
  graph: TaskGraph;
  workflowRuns: WorkflowRunRecord[];
  activeProcesses: ActiveSparkRoleRunProcess[];
  projectRef?: ProjectRef;
  targetRunRef?: RunRef;
  targetTaskRef?: TaskRef;
}): SparkBackgroundChildRunView[] {
  const allTasks = input.graph.tasks();
  const taskByRef = new Map(allTasks.map((task) => [task.ref, task]));
  const allTaskRuns = input.graph.runs();
  const taskRunByRef = new Map(allTaskRuns.map((run) => [run.ref, run]));
  const workflowRunRefByChild = new Map<RunRef, RunRef>();
  const childRunRefs = new Set<RunRef>();
  for (const workflowRun of input.workflowRuns) {
    for (const childRunRef of workflowRun.taskRunRefs) {
      if (
        input.targetRunRef &&
        input.targetRunRef !== workflowRun.ref &&
        input.targetRunRef !== childRunRef
      )
        continue;
      workflowRunRefByChild.set(childRunRef, workflowRun.ref);
      childRunRefs.add(childRunRef);
    }
  }
  for (const process of input.activeProcesses) childRunRefs.add(process.runRef);
  if (input.targetRunRef && !input.workflowRuns.some((run) => run.ref === input.targetRunRef))
    childRunRefs.add(input.targetRunRef);
  for (const task of allTasks) {
    if (input.projectRef && task.projectRef !== input.projectRef) continue;
    if (input.targetTaskRef && task.ref !== input.targetTaskRef) continue;
    if (task.claim?.runRef) childRunRefs.add(task.claim.runRef);
  }
  for (const run of allTaskRuns) {
    if (input.projectRef && run.projectRef !== input.projectRef) continue;
    if (input.targetTaskRef && run.taskRef !== input.targetTaskRef) continue;
    if (input.targetRunRef && run.ref !== input.targetRunRef) continue;
    if (input.targetTaskRef || input.targetRunRef) childRunRefs.add(run.ref);
  }
  const activeByRunRef = new Map(input.activeProcesses.map((process) => [process.runRef, process]));
  const views = [...childRunRefs].flatMap((runRef): SparkBackgroundChildRunView[] => {
    const taskRun = taskRunByRef.get(runRef);
    const activeProcess = activeByRunRef.get(runRef);
    const task = taskRun
      ? taskByRef.get(taskRun.taskRef)
      : allTasks.find((candidate) => candidate.claim?.runRef === runRef);
    if (input.projectRef && task && task.projectRef !== input.projectRef) return [];
    if (input.projectRef && taskRun && taskRun.projectRef !== input.projectRef) return [];
    if (input.targetTaskRef && task?.ref !== input.targetTaskRef) return [];
    const status: SparkBackgroundChildStatus = activeProcess
      ? "active"
      : (taskRun?.status ?? (task?.status === "running" ? "running" : "unknown"));
    const view: SparkBackgroundChildRunView = {
      runRef,
      workflowRunRef: workflowRunRefByChild.get(runRef),
      taskRef: task?.ref ?? taskRun?.taskRef,
      taskName: task?.name,
      taskTitle: task?.title,
      taskStatus: task?.status,
      roleRef: activeProcess?.roleRef ?? taskRun?.roleRef ?? task?.claim?.roleRef,
      runName: activeProcess?.runName ?? taskRun?.runName ?? task?.claim?.runName,
      ownerSessionId: taskRun?.ownerSessionId ?? task?.claim?.sessionId,
      claimKind: task?.claim?.runRef === runRef ? task.claim.kind : undefined,
      pid: activeProcess?.pid,
      cwd: activeProcess?.cwd,
      startedAt: activeProcess?.startedAt ?? taskRun?.startedAt,
      finishedAt: taskRun?.finishedAt,
      timedOutAt: activeProcess?.timedOutAt,
      activeProcess: Boolean(activeProcess),
      status,
      summary: taskRun?.completionSummary?.summary,
      errorMessage: taskRun?.errorMessage,
      artifactRefs: [
        ...(taskRun?.completionSummary?.artifactRefs ?? []),
        ...(taskRun?.outputArtifacts ?? []).filter(
          (artifactRef) => !(taskRun?.completionSummary?.artifactRefs ?? []).includes(artifactRef),
        ),
      ],
    };
    view.nextAction = backgroundChildNextAction(view);
    return [view];
  });
  return views.sort((a, b) => {
    const byStatus = taskRunStatusRank(a.status) - taskRunStatusRank(b.status);
    if (byStatus !== 0) return byStatus;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });
}

export async function enrichBackgroundChildRunsWithRoleRunArtifacts(input: {
  cwd: string;
  childRuns: SparkBackgroundChildRunView[];
}): Promise<SparkBackgroundChildRunView[]> {
  return Promise.all(
    input.childRuns.map(async (child) => {
      if (child.artifactRefs.length === 0) return child;
      const roleRunArtifacts = await Promise.all(
        child.artifactRefs.map((artifactRef) => readRoleRunArtifactPreview(input.cwd, artifactRef)),
      );
      const compact = roleRunArtifacts.find(
        (artifact) => artifact.summary || artifact.transcriptRef,
      );
      return {
        ...child,
        summary: child.summary ?? compact?.summary,
        transcriptRef: compact?.transcriptRef,
        stdoutTail: compact?.stdout,
        stderrTail: compact?.stderr,
        jsonEventsTail: compact?.jsonEvents,
        roleRunArtifacts,
      };
    }),
  );
}

function backgroundChildNextAction(child: SparkBackgroundChildRunView): string | undefined {
  if (child.activeProcess)
    return `wait for completion, or kill ${child.runRef} if this child is non-responsive`;
  if (child.status === "failed")
    return "inspect failed task/run evidence, fix the cause, then rerun";
  if (child.status === "queued" || child.status === "running")
    return "reconcile; no active process is currently tracked for this child";
  return undefined;
}

function taskRunStatusRank(status: SparkBackgroundChildStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "running":
      return 1;
    case "queued":
      return 2;
    case "failed":
      return 3;
    case "cancelled":
      return 4;
    case "succeeded":
      return 5;
    case "unknown":
      return 6;
  }
}
