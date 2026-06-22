import type { TaskGraph, SessionTodoEntry } from "@zendev-lab/pi-tasks";
import { isUnfinishedTaskStatus } from "@zendev-lab/pi-tasks";
import type {
  ProjectRef,
  TaskRef,
  TaskRunCompletionSummary,
  TaskStatus,
} from "@zendev-lab/pi-extension-api";
import type { WorkflowRunControl, WorkflowRunStatusSummary } from "@zendev-lab/pi-workflows";
import { appendRecentRoleRunCompletionLines } from "./role-run-completions.ts";
import type { SparkSessionGoal } from "./spark-session-goals.ts";
import { sparkRunStrategyForMaxConcurrency } from "./session-state.ts";
import { visibleIndependentTodos } from "./session-todos.ts";
import {
  appendCompactSparkWorkflowRunStatusLines,
  appendSparkWorkflowRunNextStepLines,
  appendSparkWorkflowRunStatusLines,
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
  runControl?: WorkflowRunControl;
  sessionGoal?: SparkSessionGoal;
  independentTodos: SessionTodoEntry[];
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
  if (includeWorkspaceSummary && input.runControl)
    lines.push(sparkRunControlStatusLine(input.runControl));
  if (includeWorkspaceSummary)
    appendWorkflowRunStatusLines(lines, input.view, input.workflowRunStatus);
  if (includeWorkspaceSummary && input.recentRoleRunCompletions.length > 0)
    appendRecentRoleRunCompletionLines(lines, input.recentRoleRunCompletions);
  if (input.view === "active" && !input.currentProject)
    lines.push(
      '\nSpark available: no project selected for this session. Use task_write({ action: "project_use" }) to select a project, or request summary/full history to inspect all projects.',
    );

  const renderedProjectDetails = renderProjectLines(lines, input);
  if (renderedProjectDetails.length === 0) lines.push("\nNo Spark projects matched this view.");
  const independentTodoDetails = includeWorkspaceSummary
    ? appendIndependentTodoStatusLines(lines, input)
    : emptyIndependentTodoDetails();
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
    ...(includeWorkspaceSummary ? { independentTodos: independentTodoDetails } : {}),
    ...(includeWorkspaceSummary
      ? { projects: compactProjectSummaries(input.graph, input.sessionKey) }
      : {}),
    ...(includeWorkspaceSummary ? { workflowRunStatus: input.workflowRunStatus } : {}),
    ...(includeWorkspaceSummary ? { runControl: input.runControl } : {}),
    sessionGoal: input.sessionGoal,
    ...(includeWorkspaceSummary
      ? { recentRoleRunCompletions: input.recentRoleRunCompletions }
      : {}),
    ...(input.state ? { state: input.state } : {}),
  };
  return {
    lines,
    details,
    compactDetails: compactSparkStatusDetails(
      input,
      renderedProjectDetails,
      independentTodoDetails,
    ),
  };
}

function compactSparkStatusDetails(
  input: SparkStatusRenderInput,
  renderedProjectDetails: Array<Record<string, unknown>>,
  independentTodoDetails: Record<string, unknown>,
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
      ? { independentTodos: compactIndependentTodoDecisionDetail(independentTodoDetails) }
      : {}),
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
    sessionGoal: input.sessionGoal
      ? {
          status: input.sessionGoal.status,
          objective: truncateInline(input.sessionGoal.objective, 180),
        }
      : undefined,
    hints: [
      'Use view="full" or includeDetails=true for full project/task/workflow-run details.',
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

function compactIndependentTodoDecisionDetail(
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const todos = Array.isArray(detail.todos) ? detail.todos : [];
  return {
    total: detail.total,
    hidden: detail.hidden,
    todos: todos.map((todo) => {
      if (!isRecord(todo)) return todo;
      return {
        id: todo.id,
        content:
          typeof todo.content === "string" ? truncateInline(todo.content, 160) : todo.content,
        status: todo.status,
      };
    }),
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
  } else if (view === "summary") {
    appendCompactSparkWorkflowRunStatusLines(lines, workflowRunStatus);
  } else appendSparkWorkflowRunStatusLines(lines, workflowRunStatus);
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
    const projectPrefix = input.view === "active" ? "Project" : `Project ${project.ref}:`;
    lines.push(`\n${projectPrefix} ${project.title}${currentSuffix}`);
    lines.push(
      `  Tasks: ${tasks.length} total | ${claimed.length} claimed | ${sessionClaimed.length} current_session_claimed | ready_frontier=${readyTasks.length} | ${formatTaskStatusCounts(statusCounts)}`,
    );
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
    if (hiddenByView > 0)
      lines.push(`  Completed tasks: ${formatCompletedTaskCounts(statusCounts)}`);
    if (hiddenByLimit > 0)
      lines.push(
        `  Hidden by limit: ${hiddenByLimit} (increase limit or use view=full without limit)`,
      );
    const renderedProjectDetail = {
      ref: project.ref,
      title: project.title,
      current: isCurrent,
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
  lines.push(input.view === "full" ? "  Durable active tasks:" : "  Active tasks:");
  for (const task of input.visibleTasks) {
    const owner = deriveTaskRoleLabel({
      task,
      currentSessionKey: input.sessionKey,
      latestRun: input.lastRunsByTaskRef.get(task.ref),
    });
    const planSummary = taskPlanSummary(task);
    const planSuffix = planSummary ? ` plan=${planSummary}` : "";
    const lifecycleSuffix = taskLifecycleSuffix(task);
    const taskOwnedBySession = isClaimOwnedBySession(task, input.sessionKey);
    const readyFrontierSuffix = input.readyTaskRefs.has(task.ref) ? " ready_frontier=yes" : "";
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
        `  - [${task.status}] @${task.name}: ${task.title} owner=@${owner}${readyFrontierSuffix}${planSuffix}${lifecycleSuffix}`,
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
      `  - [${task.status}] @${task.name}: ${task.title} (${task.ref}) kind=${task.kind} owner=@${owner} claimed=${taskClaimSummary(task)} todos=${taskSummary.total}/${taskSummary.inProgress}/${taskSummary.pending}/${taskSummary.done}${readyFrontierSuffix}${planSuffix}${lifecycleSuffix}`,
    );
    if (taskOwnedBySession) {
      for (const todo of visibleTaskTodos)
        lines.push(`    - [${todo.status}] ${todo.id} ${todo.content}`);
    }
  }
}

function appendIndependentTodoStatusLines(
  lines: string[],
  input: SparkStatusRenderInput,
): Record<string, unknown> {
  const displayedIndependentTodos = visibleIndependentTodos(input.independentTodos);
  const visibleIndependentTodoRows =
    input.view === "active"
      ? displayedIndependentTodos.slice(0, DEFAULT_SPARK_STATUS_TODO_LIMIT)
      : displayedIndependentTodos;
  const independentSuffix = input.view === "active" ? " active" : "";
  lines.push(
    `\nIndependent session TODOs: ${displayedIndependentTodos.length}${independentSuffix}`,
  );
  for (const todo of visibleIndependentTodoRows)
    lines.push(`  - [${todo.status}] ${todo.id ?? ""} ${truncateInline(todo.content, 160)}`);
  const hiddenIndependentTodos =
    displayedIndependentTodos.length - visibleIndependentTodoRows.length;
  if (hiddenIndependentTodos > 0)
    lines.push(`  - … ${hiddenIndependentTodos} more independent TODOs`);
  return {
    total: displayedIndependentTodos.length,
    hidden: hiddenIndependentTodos,
    todos: visibleIndependentTodoRows.map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
      notes: todo.notes,
    })),
  };
}

function emptyIndependentTodoDetails(): Record<string, unknown> {
  return { total: 0, hidden: 0, todos: [] };
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
