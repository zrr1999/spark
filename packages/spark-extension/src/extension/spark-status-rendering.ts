import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  formatPiTaskActiveStatusLine,
  formatPiTaskSummaryStatusLine,
  isUnfinishedTaskStatus,
} from "@zendev-lab/spark-tasks";
import type {
  ProjectRef,
  TaskRef,
  TaskRunCompletionSummary,
  TaskStatus,
} from "@zendev-lab/spark-extension-api";
import type { WorkflowRunControl, WorkflowRunStatusSummary } from "@zendev-lab/spark-workflows";
import { renderSparkProjectKindDisplay } from "./project-kind-registry.ts";
import { appendRecentRoleRunCompletionLines } from "./role-run-completions.ts";
import type { SparkDriveMode } from "./spark-drive-state.ts";
import type { SparkSessionGoal } from "./spark-session-goals.ts";
import type { SparkSessionLoop } from "./spark-session-loops.ts";
import { sparkRunStrategyForMaxConcurrency } from "./session-state.ts";
import {
  appendCompactSparkWorkflowRunStatusLines,
  appendSparkWorkflowRunNextStepLines,
  formatSparkWorkflowRun,
} from "./spark-workflow-run-status-rendering.ts";
import {
  compactProjectSummaries,
  countTaskStatuses,
  formatTaskStatusCounts,
  isImportantStatus,
  shouldRenderProjectInSparkStatus,
  sortTasksForStatusVisibility,
  type SparkStatusScope,
  type SparkStatusView,
} from "./spark-status.ts";
import type { SparkStateHousekeepingSummary } from "./state-housekeeping.ts";
import { appendSparkStateHousekeepingLines } from "./state-housekeeping-rendering.ts";
import {
  latestRunsByTaskRef,
  taskClaimSummary,
  taskLifecycleSuffix,
  taskPlanSummary,
} from "./task-display.ts";
import { deriveTaskRoleLabel, isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";
import { staleClaimStatusHint } from "./task-claim-recovery.ts";
import {
  projectSparkDynamicWorkflowRuns,
  type SparkDynamicWorkflowRunProjection,
} from "./spark-dynamic-workflow-run-rendering.ts";
import type { SparkDynamicWorkflowEventRunView } from "./spark-dynamic-workflow-event-store.ts";
import {
  appendSparkDynamicWorkflowResultInboxLines,
  projectSparkDynamicWorkflowResultDeliveries,
} from "./spark-dynamic-workflow-result-inbox.ts";
import { truncateInline } from "./tool-rendering.ts";

export const DEFAULT_SPARK_STATUS_ACTIVE_LIMIT = 8;
export const DEFAULT_SPARK_STATUS_TODO_LIMIT = 3;
export const DEFAULT_SPARK_STATUS_RECENT_COMPLETIONS_LIMIT = 5;

export interface SparkStatusRenderInput {
  graph: TaskGraph;
  scope?: SparkStatusScope;
  view: SparkStatusView;
  taskLimit: number | undefined;
  targetProjectRef?: ProjectRef;
  targetTaskRef?: TaskRef;
  includeWorkspaceSummary?: boolean;
  sessionKey: string;
  currentProject?: ReturnType<TaskGraph["projects"]>[number];
  workflowRunStatus: WorkflowRunStatusSummary;
  dynamicWorkflowRuns?: SparkDynamicWorkflowEventRunView[];
  runControl?: WorkflowRunControl;
  driveMode?: SparkDriveMode;
  sessionGoal?: SparkSessionGoal;
  sessionLoop?: SparkSessionLoop;
  recentRoleRunCompletions: TaskRunCompletionSummary[];
  state?: SparkStateHousekeepingSummary;
}

export function renderSparkStatus(input: SparkStatusRenderInput): {
  lines: string[];
  details: Record<string, unknown>;
  compactDetails: Record<string, unknown>;
} {
  const scope = input.scope ?? "workspace";
  const includeWorkspaceSummary = scope === "workspace" || input.includeWorkspaceSummary === true;
  const lines = [
    `Spark ${scope === "workspace" ? "tasks" : `${scope} status`} (${input.view} view${typeof input.taskLimit === "number" ? `, limit=${input.taskLimit}` : ""}):`,
  ];
  if (input.driveMode) lines.push(`Mode: ${input.driveMode} (derived from active drive state).`);
  if (includeWorkspaceSummary && input.runControl)
    lines.push(sparkRunControlStatusLine(input.runControl));
  if (includeWorkspaceSummary)
    appendWorkflowRunStatusLines(lines, input.view, input.workflowRunStatus);
  if (includeWorkspaceSummary && input.dynamicWorkflowRuns)
    appendDynamicWorkflowStatusLines(lines, input.dynamicWorkflowRuns);
  if (includeWorkspaceSummary && input.recentRoleRunCompletions.length > 0)
    appendRecentRoleRunCompletionLines(lines, input.recentRoleRunCompletions);
  if (input.view === "active" && !input.currentProject)
    lines.push(
      '\nSpark available: no project selected for this session. Use task_write({ action: "project_use" }) to select a project, or request summary view / project_list to inspect projects.',
    );

  const renderedProjectDetails = renderProjectLines(lines, input);
  if (renderedProjectDetails.length === 0) lines.push("\nNo Spark projects matched this view.");
  if (input.state) appendSparkStateHousekeepingLines(lines, input.state);

  const selectedProject = input.targetProjectRef
    ? renderedProjectDetails.find((project) => project.ref === input.targetProjectRef)
    : undefined;
  const selectedTask = input.targetTaskRef
    ? selectedProject?.tasks instanceof Array
      ? selectedProject.tasks.find(
          (task): task is Record<string, unknown> =>
            isRecord(task) && task.ref === input.targetTaskRef,
        )
      : undefined
    : undefined;
  const details = {
    found: true,
    scope,
    view: input.view,
    limit: input.taskLimit,
    activeProjectRef: input.currentProject?.ref,
    selectedProject,
    selectedTask,
    renderedProjects: renderedProjectDetails,
    ...(includeWorkspaceSummary
      ? { projects: compactProjectSummaries(input.graph, input.sessionKey) }
      : {}),
    ...(includeWorkspaceSummary ? { workflowRunStatus: input.workflowRunStatus } : {}),
    ...(includeWorkspaceSummary && input.dynamicWorkflowRuns
      ? { dynamicWorkflowRuns: compactDynamicWorkflowRuns(input.dynamicWorkflowRuns) }
      : {}),
    ...(includeWorkspaceSummary ? { runControl: input.runControl } : {}),
    driveMode: input.driveMode,
    sessionGoal: input.sessionGoal,
    sessionLoop: input.sessionLoop,
    ...(includeWorkspaceSummary
      ? { recentRoleRunCompletions: input.recentRoleRunCompletions }
      : {}),
    ...(input.state ? { state: input.state } : {}),
  };
  return {
    lines,
    details,
    compactDetails: compactSparkStatusDetails(input, renderedProjectDetails),
  };
}

function compactSparkStatusDetails(
  input: SparkStatusRenderInput,
  renderedProjectDetails: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const currentProjectTasks = input.currentProject
    ? input.graph.tasks(input.currentProject.ref)
    : [];
  const importantCurrentTasks = sortTasksForStatusVisibility(
    currentProjectTasks.filter((task) => isImportantStatus(task.status)),
  );
  const taskLimit = input.taskLimit ?? DEFAULT_SPARK_STATUS_ACTIVE_LIMIT;
  const currentClaim = importantCurrentTasks.find((task) =>
    isClaimOwnedBySession(task, input.sessionKey),
  );
  const readyTasks = input.currentProject
    ? input.graph
        .readyTasks(input.currentProject.ref)
        .filter((task) => isImportantStatus(task.status))
    : [];
  const scope = input.scope ?? "workspace";
  const includeWorkspaceSummary = scope === "workspace" || input.includeWorkspaceSummary === true;
  const selectedProject = input.targetProjectRef
    ? renderedProjectDetails.find((project) => project.ref === input.targetProjectRef)
    : undefined;
  const selectedTask = input.targetTaskRef
    ? selectedProject?.tasks instanceof Array
      ? selectedProject.tasks.find(
          (task): task is Record<string, unknown> =>
            isRecord(task) && task.ref === input.targetTaskRef,
        )
      : undefined
    : undefined;
  return {
    found: true,
    compact: true,
    scope,
    view: input.view,
    limit: input.taskLimit,
    activeProjectRef: input.currentProject?.ref,
    selectedProject: selectedProject
      ? compactRenderedProjectDecisionDetail(selectedProject)
      : undefined,
    selectedTask,
    activeProject: input.currentProject
      ? compactProjectDecisionDetail(input, currentProjectTasks)
      : undefined,
    currentClaim: currentClaim ? compactTaskDecisionDetail(input, currentClaim) : undefined,
    ready: readyTasks.slice(0, taskLimit).map((task) => compactTaskDecisionDetail(input, task)),
    renderedProjects: renderedProjectDetails.map(compactRenderedProjectDecisionDetail),
    ...(includeWorkspaceSummary
      ? { workflowRunStatus: compactWorkflowRunDecisionDetail(input.workflowRunStatus) }
      : {}),
    ...(includeWorkspaceSummary
      ? {
          runControl: input.runControl
            ? {
                status: input.runControl.status,
                projectRef: input.runControl.projectRef,
                focus: input.runControl.focus,
                maxConcurrency: input.runControl.policy.maxConcurrency,
                timeoutMs: input.runControl.policy.timeoutMs,
              }
            : undefined,
        }
      : {}),
    driveMode: input.driveMode,
    sessionGoal: input.sessionGoal
      ? {
          status: input.sessionGoal.status,
          objective: truncateInline(input.sessionGoal.objective, 180),
        }
      : undefined,
    sessionLoop: input.sessionLoop
      ? {
          status: input.sessionLoop.status,
          objective: truncateInline(input.sessionLoop.objective, 180),
          nextRunAt: input.sessionLoop.schedule?.nextRunAt,
        }
      : undefined,
    hints: [
      "Use projectRef/taskRef/limit for bounded status drill-down.",
      'Use task_read({ action: "run_status", runAction: "inspect", runRef/taskRef }) for targeted workflow-run details.',
      "Use text format for a human-readable active frontier.",
    ],
  };
}

function compactProjectDecisionDetail(
  input: SparkStatusRenderInput,
  tasks: ReturnType<TaskGraph["tasks"]>,
): Record<string, unknown> {
  const claimed = tasks.filter((task) => taskClaimedBy(task));
  const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, input.sessionKey));
  const ready = input.currentProject ? input.graph.readyTasks(input.currentProject.ref).length : 0;
  return {
    ref: input.currentProject?.ref,
    title: input.currentProject?.title,
    kind: input.currentProject?.kind ?? "generic",
    kindDisplay: input.currentProject
      ? renderSparkProjectKindDisplay(input.currentProject)
      : undefined,
    taskCounts: {
      total: tasks.length,
      unfinished: tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length,
      ready,
      claimed: claimed.length,
      claimedByCurrentSession: sessionClaimed.length,
      statusCounts: countTaskStatuses(tasks),
    },
  };
}

function compactRenderedProjectDecisionDetail(
  project: Record<string, unknown>,
): Record<string, unknown> {
  const taskCounts = project.taskCounts as Record<string, unknown> | undefined;
  return {
    ref: project.ref,
    title: project.title,
    current: project.current,
    kind: project.kind,
    kindDisplay: project.kindDisplay,
    taskCounts: taskCounts
      ? {
          total: taskCounts.total,
          unfinished: taskCounts.unfinished,
          claimed: taskCounts.claimed,
          claimedByCurrentSession: taskCounts.claimedByCurrentSession,
          ready: taskCounts.ready,
          statusCounts: taskCounts.statusCounts,
        }
      : undefined,
    hiddenFinishedTasks: project.hiddenFinishedTasks,
    hiddenByLimit: project.hiddenByLimit,
  };
}

function compactTaskDecisionDetail(
  input: SparkStatusRenderInput,
  task: ReturnType<TaskGraph["tasks"]>[number],
): Record<string, unknown> {
  const taskOwnedBySession = isClaimOwnedBySession(task, input.sessionKey);
  const taskTodos = taskOwnedBySession ? input.graph.taskTodos(task.ref) : [];
  const visibleTaskTodos = taskTodos.slice(0, DEFAULT_SPARK_STATUS_TODO_LIMIT);
  return {
    ref: task.ref,
    name: task.name,
    title: task.title,
    status: task.status,
    kind: task.kind,
    projectRef: task.projectRef,
    owner: deriveTaskRoleLabel({ task, currentSessionKey: input.sessionKey }),
    claimedByCurrentSession: taskOwnedBySession,
    plan: taskPlanSummary(task),
    todos: {
      total: taskTodos.length,
      hidden: taskTodos.length - visibleTaskTodos.length,
      items: visibleTaskTodos.map((todo) => ({
        id: todo.id,
        content: truncateInline(todo.content, 160),
        status: todo.status,
      })),
    },
  };
}

function compactWorkflowRunDecisionDetail(
  workflowRunStatus: WorkflowRunStatusSummary,
): Record<string, unknown> {
  return {
    manager: workflowRunStatus.manager,
    counts: {
      running: workflowRunStatus.running,
      succeeded: workflowRunStatus.succeeded,
      failed: workflowRunStatus.failed,
      stale: workflowRunStatus.stale,
      timedOut: workflowRunStatus.timedOut,
      acknowledged: workflowRunStatus.acknowledged,
      actionable: workflowRunStatus.actionable,
    },
    activeRun: workflowRunStatus.activeRun
      ? compactWorkflowRunRecordDecisionDetail(workflowRunStatus.activeRun)
      : undefined,
    actionableRun: workflowRunStatus.actionableRun
      ? compactWorkflowRunRecordDecisionDetail(workflowRunStatus.actionableRun)
      : undefined,
    lastRun: workflowRunStatus.lastRun
      ? compactWorkflowRunRecordDecisionDetail(workflowRunStatus.lastRun)
      : undefined,
    nextSteps: workflowRunStatus.nextSteps.map((step) => ({
      runRef: step.runRef,
      status: step.status,
      summary: truncateInline(step.summary, 200),
      nextActions: step.nextActions.slice(0, 3),
    })),
  };
}

function compactWorkflowRunRecordDecisionDetail(
  run: NonNullable<WorkflowRunStatusSummary["lastRun"]>,
): Record<string, unknown> {
  return {
    ref: run.ref,
    projectRef: run.projectRef,
    status: run.status,
    scheduled: run.scheduled,
    completed: run.completed,
    timedOut: run.timedOut,
    errorMessage: run.errorMessage ? truncateInline(run.errorMessage, 200) : undefined,
    acknowledgedAt: run.acknowledgedAt,
  };
}

function appendDynamicWorkflowStatusLines(
  lines: string[],
  runs: SparkDynamicWorkflowEventRunView[],
): void {
  const visible = projectSparkDynamicWorkflowRuns({ runs, includeHistory: false });
  const active = visible.find((run) => run.status === "running" || run.status === "paused");
  const problem = visible.find((run) => ["failed", "stale", "stopped"].includes(run.status));
  const deliveries = projectSparkDynamicWorkflowResultDeliveries({ runs, limit: 3 });
  const run = active ?? problem;
  if (!run && deliveries.length === 0) return;
  const counts = countDynamicWorkflowStatuses(
    projectSparkDynamicWorkflowRuns({ runs, includeHistory: true }),
  );
  lines.push(
    `Dynamic workflow runs: running=${counts.running} paused=${counts.paused} failed=${counts.failed} stale=${counts.stale} stopped=${counts.stopped} succeeded=${counts.succeeded}`,
  );
  if (run)
    lines.push(
      `  ${active ? "Active" : "Actionable"} dynamic workflow: ${run.ref} [${run.status}] ${run.name} nodes=${run.completedNodes}/${run.totalNodes}`,
    );
  appendSparkDynamicWorkflowResultInboxLines(lines, deliveries);
}

function compactDynamicWorkflowRuns(
  runs: SparkDynamicWorkflowEventRunView[],
): Record<string, unknown> {
  const projected = projectSparkDynamicWorkflowRuns({ runs, includeHistory: true });
  const counts = countDynamicWorkflowStatuses(projected);
  return {
    counts,
    active: projected
      .filter((run) => run.active && !run.acknowledgedAt)
      .map(compactDynamicWorkflowRun)
      .slice(0, 3),
    resultInbox: projectSparkDynamicWorkflowResultDeliveries({ runs, limit: 5 }),
    recent: projected.slice(0, 5).map(compactDynamicWorkflowRun),
  };
}

function compactDynamicWorkflowRun(
  run: SparkDynamicWorkflowRunProjection,
): Record<string, unknown> {
  return {
    ref: run.ref,
    status: run.status,
    name: run.name,
    sourceLabel: run.sourceLabel,
    updatedAt: run.updatedAt,
    acknowledgedAt: run.acknowledgedAt,
    completedNodes: run.completedNodes,
    totalNodes: run.totalNodes,
  };
}

function countDynamicWorkflowStatuses(
  runs: SparkDynamicWorkflowRunProjection[],
): Record<string, number> {
  return {
    running: runs.filter((run) => run.status === "running").length,
    paused: runs.filter((run) => run.status === "paused").length,
    failed: runs.filter((run) => run.status === "failed").length,
    stale: runs.filter((run) => run.status === "stale").length,
    stopped: runs.filter((run) => run.status === "stopped").length,
    succeeded: runs.filter((run) => run.status === "succeeded").length,
  };
}

function appendWorkflowRunStatusLines(
  lines: string[],
  view: SparkStatusView,
  workflowRunStatus: WorkflowRunStatusSummary,
): void {
  if (view === "active") {
    const compactRun = appendCompactSparkWorkflowRunStatusLines(lines, workflowRunStatus);
    if (compactRun) {
      const label = compactRun.ref === workflowRunStatus.activeRun?.ref ? "Active" : "Actionable";
      lines.push(`  ${label} workflow run: ${formatSparkWorkflowRun(compactRun)}`);
      appendSparkWorkflowRunNextStepLines(lines, compactRun, "  ");
    }
  } else {
    appendCompactSparkWorkflowRunStatusLines(lines, workflowRunStatus);
  }
}

function renderProjectLines(
  lines: string[],
  input: SparkStatusRenderInput,
): Array<Record<string, unknown>> {
  const renderedProjectDetails: Array<Record<string, unknown>> = [];
  for (const project of input.graph.projects()) {
    if (input.targetProjectRef && project.ref !== input.targetProjectRef) continue;
    const tasks = input.graph.tasks(project.ref);
    const claimed = tasks.filter((task) => taskClaimedBy(task));
    const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, input.sessionKey));
    const statusCounts = countTaskStatuses(tasks);
    const readyTasks = input.graph.readyTasks(project.ref);
    const readyTaskRefs = new Set(readyTasks.map((task) => task.ref));
    const allVisibleTasks = input.targetTaskRef
      ? tasks.filter((task) => task.ref === input.targetTaskRef)
      : sortTasksForStatusVisibility(tasks.filter((task) => isImportantStatus(task.status)));
    if (
      !input.targetProjectRef &&
      !shouldRenderProjectInSparkStatus({
        view: input.view,
        projectRef: project.ref,
        activeProjectRef: input.currentProject?.ref,
        sessionClaimedCount: sessionClaimed.length,
      })
    )
      continue;

    const visibleTasks =
      typeof input.taskLimit === "number"
        ? allVisibleTasks.slice(0, input.taskLimit)
        : allVisibleTasks;
    const renderedTaskDetails: Array<Record<string, unknown>> = [];
    const lastRunsByTaskRef = latestRunsByTaskRef(input.graph.runs(project.ref));
    const completedTaskCount = tasks.filter((task) => !isImportantStatus(task.status)).length;
    const hiddenByView = completedTaskCount;
    const hiddenByLimit = allVisibleTasks.length - visibleTasks.length;
    const currentSuffix = project.ref === input.currentProject?.ref ? " [current]" : "";
    const isCurrent = project.ref === input.currentProject?.ref;
    const projectKind = renderSparkProjectKindDisplay(project);
    const projectPrefix = input.view === "active" ? "Project" : `Project ${project.ref}:`;
    const kindSuffix = projectKind.badge ? ` [${projectKind.badge}]` : "";
    lines.push(`\n${projectPrefix} ${project.title}${kindSuffix}${currentSuffix}`);
    lines.push(
      `  Tasks: ${tasks.length} total | ${claimed.length} claimed | ${sessionClaimed.length} current_session_claimed | ready_frontier=${readyTasks.length} | ${formatTaskStatusCounts(statusCounts)}`,
    );
    for (const panel of projectKind.panels) {
      lines.push(`  ${panel.label}: ${truncateInline(panel.text, 160)}`);
    }
    const workflowIdle =
      input.workflowRunStatus.running === 0 && !input.workflowRunStatus.activeRun;
    const claimRecoveryHints = tasks.flatMap((task) => {
      const hint = staleClaimStatusHint({
        task,
        currentSessionKey: input.sessionKey,
        workflowIdle,
      });
      return hint ? [hint] : [];
    });
    if (isCurrent && readyTasks.length === 0 && claimRecoveryHints.length > 0) {
      lines.push(
        `  Recovery: ready_frontier is blocked by ${claimRecoveryHints.length} other-session claimed task(s) while background work is ${workflowIdle ? "idle" : "active"}.`,
      );
      for (const hint of claimRecoveryHints.slice(0, 3)) {
        const name = typeof hint.name === "string" ? hint.name : "unknown";
        const claimedBy = typeof hint.claimedBy === "string" ? hint.claimedBy : "unknown";
        const expiresAt = typeof hint.expiresAt === "string" ? hint.expiresAt : "unknown";
        const expired = hint.expired === true ? " expired=yes" : "";
        lines.push(
          `    - @${name} claimed_by=${claimedBy} expires=${expiresAt}${expired}; retry claim for @${name}`,
        );
      }
      lines.push(
        '    Next: if owner is inactive, review failed with needs_changes, or claim expired, reclaim with task_write({ action: "claim", task: "@name" }); Spark will refuse active/recent owners and record recovery evidence.',
      );
    }
    if (isCurrent && input.sessionGoal) {
      const reason = input.sessionGoal.pauseReason ?? input.sessionGoal.completedReason;
      const reasonText = reason ? ` | reason: ${truncateInline(reason, 120)}` : "";
      lines.push(
        `  Session goal: ${input.sessionGoal.status} | ${truncateInline(input.sessionGoal.objective, 180)}${reasonText}`,
      );
    } else if (isCurrent) {
      lines.push(
        '  Session goal: none in durable session state; historical compact summaries are hints only. Use goal({ action: "start" }) to bind a goal to this project when needed.',
      );
    }
    if (isCurrent && input.sessionLoop) {
      const nextRun = input.sessionLoop.schedule?.nextRunAt
        ? ` | next=${input.sessionLoop.schedule.nextRunAt}`
        : "";
      lines.push(
        `  Session loop: ${input.sessionLoop.status} | ${truncateInline(input.sessionLoop.objective, 180)}${nextRun}`,
      );
    }
    if (hiddenByView > 0)
      lines.push(`  Completed tasks: ${formatCompletedTaskCounts(statusCounts)}`);
    if (hiddenByLimit > 0)
      lines.push(
        `  Hidden by limit: ${hiddenByLimit} (increase limit for a larger bounded sample)`,
      );
    const renderedProjectDetail = {
      ref: project.ref,
      title: project.title,
      current: isCurrent,
      kind: project.kind ?? "generic",
      kindDisplay: projectKind,
      taskCounts: {
        total: tasks.length,
        unfinished: tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length,
        claimed: claimed.length,
        claimedByCurrentSession: sessionClaimed.length,
        ready: readyTasks.length,
        statusCounts,
      },
      hiddenFinishedTasks: hiddenByView,
      hiddenByLimit,
      sessionGoal: isCurrent ? input.sessionGoal : undefined,
      claimRecovery: claimRecoveryHints,
      tasks: renderedTaskDetails,
    };
    if (input.view === "summary") {
      renderedProjectDetails.push(renderedProjectDetail);
      continue;
    }

    appendTaskStatusLines(lines, {
      ...input,
      visibleTasks,
      lastRunsByTaskRef,
      renderedTaskDetails,
      readyTaskRefs,
    });
    if (visibleTasks.length === 0) lines.push("  - none");
    renderedProjectDetails.push(renderedProjectDetail);
  }
  return renderedProjectDetails;
}

function formatCompletedTaskCounts(counts: Partial<Record<TaskStatus, number>>): string {
  const done = counts.done ?? 0;
  const cancelled = counts.cancelled ?? 0;
  const total = done + cancelled;
  const parts = [`${total} total`];
  if (done > 0) parts.push(`done=${done}`);
  if (cancelled > 0) parts.push(`cancelled=${cancelled}`);
  return parts.join(" | ");
}

function appendTaskStatusLines(
  lines: string[],
  input: SparkStatusRenderInput & {
    visibleTasks: ReturnType<TaskGraph["tasks"]>;
    lastRunsByTaskRef: ReturnType<typeof latestRunsByTaskRef>;
    renderedTaskDetails: Array<Record<string, unknown>>;
    readyTaskRefs: ReadonlySet<string>;
  },
): void {
  lines.push("  Active tasks:");
  for (const task of input.visibleTasks) {
    const owner = deriveTaskRoleLabel({
      task,
      currentSessionKey: input.sessionKey,
      latestRun: input.lastRunsByTaskRef.get(task.ref),
    });
    const planSummary = taskPlanSummary(task);
    const lifecycleSuffix = taskLifecycleSuffix(task);
    const taskOwnedBySession = isClaimOwnedBySession(task, input.sessionKey);
    const taskTodos = taskOwnedBySession ? input.graph.taskTodos(task.ref) : [];
    const visibleTaskTodos =
      input.view === "active" ? taskTodos.slice(0, DEFAULT_SPARK_STATUS_TODO_LIMIT) : taskTodos;
    input.renderedTaskDetails.push({
      ref: task.ref,
      name: task.name,
      title: task.title,
      description: task.description,
      status: task.status,
      kind: task.kind,
      roleRef: task.roleRef,
      projectRef: task.projectRef,
      cancellation: task.cancellation,
      supersededBy: task.supersededBy,
      owner,
      claimed: taskClaimSummary(task),
      claimedByCurrentSession: taskOwnedBySession,
      plan: planSummary,
      todos: {
        total: taskTodos.length,
        hidden: taskTodos.length - visibleTaskTodos.length,
        items: visibleTaskTodos.map((todo) => ({
          id: todo.id,
          content: todo.content,
          status: todo.status,
          notes: todo.notes,
        })),
      },
    });
    if (input.view === "active") {
      lines.push(
        `  ${formatPiTaskActiveStatusLine({
          task,
          owner,
          readyFrontier: input.readyTaskRefs.has(task.ref),
          plan: planSummary,
          lifecycleSuffix,
        })}`,
      );
      if (taskOwnedBySession) {
        for (const todo of visibleTaskTodos)
          lines.push(`    - [${todo.status}] ${todo.id} ${truncateInline(todo.content, 160)}`);
        const hiddenTodos = taskTodos.length - DEFAULT_SPARK_STATUS_TODO_LIMIT;
        if (hiddenTodos > 0) lines.push(`    - … ${hiddenTodos} more TODOs`);
      }
      continue;
    }
    const taskSummary = input.graph.todoSummary(task.ref);
    lines.push(
      `  ${formatPiTaskSummaryStatusLine({
        task,
        owner,
        ref: task.ref,
        kind: task.kind,
        claimed: taskClaimSummary(task),
        todos: `${taskSummary.total}/${taskSummary.inProgress}/${taskSummary.pending}/${taskSummary.done}`,
        readyFrontier: input.readyTaskRefs.has(task.ref),
        plan: planSummary,
        lifecycleSuffix,
      })}`,
    );
    if (taskOwnedBySession) {
      for (const todo of visibleTaskTodos)
        lines.push(`    - [${todo.status}] ${todo.id} ${todo.content}`);
    }
  }
}

function sparkRunControlStatusLine(control: WorkflowRunControl): string {
  const focusSuffix = control.focus ? ` focus=${control.focus}` : "";
  const strategy = sparkRunStrategyForMaxConcurrency(control.policy.maxConcurrency);
  return (
    "Spark workflow run: " +
    control.status +
    " project=" +
    control.projectRef +
    focusSuffix +
    " strategy=" +
    strategy +
    " maxConcurrency=" +
    control.policy.maxConcurrency +
    " timeoutMs=" +
    control.policy.timeoutMs
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
