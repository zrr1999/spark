import type { TaskGraph, SessionTodoEntry } from "pi-tasks";
import { isUnfinishedTaskStatus } from "pi-tasks";
import type { TaskRunCompletionSummary, TaskStatus } from "pi-extension-api";
import type { SparkDagStatusSummary } from "pi-workflows";
import type { SparkRunModeState } from "./current-project-state.ts";
import { appendRecentRoleRunCompletionLines } from "./role-run-completions.ts";
import type { SparkSessionGoal } from "./spark-session-goals.ts";
import { sparkRunStrategyForMaxConcurrency } from "./session-state.ts";
import { visibleIndependentTodos } from "./session-todos.ts";
import {
  appendCompactSparkDagStatusLines,
  appendSparkDagRunNextStepLines,
  appendSparkDagStatusLines,
  formatSparkDagRun,
} from "./spark-dag-status-rendering.ts";
import {
  compactProjectStatusSummaries,
  countTaskStatuses,
  formatTaskStatusCounts,
  isImportantStatus,
  shouldRenderProjectInSparkStatus,
  sortTasksForStatusVisibility,
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
import { truncateInline } from "./tool-rendering.ts";

export const DEFAULT_SPARK_STATUS_ACTIVE_LIMIT = 20;
export const DEFAULT_SPARK_STATUS_TODO_LIMIT = 3;
export const DEFAULT_SPARK_STATUS_RECENT_COMPLETIONS_LIMIT = 5;

export interface SparkStatusRenderInput {
  graph: TaskGraph;
  view: SparkStatusView;
  taskLimit: number | undefined;
  sessionKey: string;
  currentProject?: ReturnType<TaskGraph["projects"]>[number];
  dagStatus: SparkDagStatusSummary;
  runMode?: SparkRunModeState;
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
  const lines = [
    `Spark tasks (${input.view} view${typeof input.taskLimit === "number" ? `, limit=${input.taskLimit}` : ""}):`,
  ];
  if (input.runMode) lines.push(sparkRunModeStatusLine(input.runMode));
  appendDagStatusLines(lines, input.view, input.dagStatus);
  if (input.recentRoleRunCompletions.length > 0)
    appendRecentRoleRunCompletionLines(lines, input.recentRoleRunCompletions);
  if (input.view === "active" && !input.currentProject)
    lines.push(
      '\nSpark available: no project selected for this session. Use task({ action: "project_use" }) to select a project, or request summary/full history to inspect all projects.',
    );

  const renderedProjectDetails = renderProjectStatusLines(lines, input);
  if (renderedProjectDetails.length === 0) lines.push("\nNo Spark projects matched this view.");
  const independentTodoDetails = appendIndependentTodoStatusLines(lines, input);
  if (input.state) appendSparkStateHousekeepingLines(lines, input.state);

  const details = {
    found: true,
    view: input.view,
    limit: input.taskLimit,
    activeProjectRef: input.currentProject?.ref,
    renderedProjects: renderedProjectDetails,
    independentTodos: independentTodoDetails,
    projects: compactProjectStatusSummaries(input.graph, input.sessionKey),
    dag: input.dagStatus,
    runMode: input.runMode,
    sessionGoal: input.sessionGoal,
    recentRoleRunCompletions: input.recentRoleRunCompletions,
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
  const readyTasks = importantCurrentTasks.filter((task) => task.status === "ready");
  return {
    found: true,
    compact: true,
    view: input.view,
    limit: input.taskLimit,
    activeProjectRef: input.currentProject?.ref,
    activeProject: input.currentProject
      ? compactProjectDecisionDetail(input, currentProjectTasks)
      : undefined,
    currentClaim: currentClaim ? compactTaskDecisionDetail(input, currentClaim) : undefined,
    ready: readyTasks.slice(0, taskLimit).map((task) => compactTaskDecisionDetail(input, task)),
    renderedProjects: renderedProjectDetails.map(compactRenderedProjectDecisionDetail),
    independentTodos: compactIndependentTodoDecisionDetail(independentTodoDetails),
    dag: compactDagDecisionDetail(input.dagStatus),
    runMode: input.runMode
      ? {
          status: input.runMode.status,
          runRef: input.runMode.runRef,
          projectRef: input.runMode.projectRef,
          focus: input.runMode.focus,
          maxConcurrency: input.runMode.policy.maxConcurrency,
          timeoutMs: input.runMode.policy.timeoutMs,
        }
      : undefined,
    sessionGoal: input.sessionGoal
      ? {
          status: input.sessionGoal.status,
          scope: input.sessionGoal.scope,
          projectRef: input.sessionGoal.projectRef,
          objective: truncateInline(input.sessionGoal.objective, 180),
          tokenBudget: input.sessionGoal.tokenBudget,
          usage: input.sessionGoal.usage,
        }
      : undefined,
    hints: [
      'Use view="full" or includeDetails=true for full project/task/DAG details.',
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
  const ready = tasks.filter((task) => task.status === "ready").length;
  return {
    ref: input.currentProject?.ref,
    title: input.currentProject?.title,
    status: input.currentProject?.status,
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
    status: project.status,
    current: project.current,
    taskCounts: taskCounts
      ? {
          total: taskCounts.total,
          unfinished: taskCounts.unfinished,
          claimed: taskCounts.claimed,
          claimedByCurrentSession: taskCounts.claimedByCurrentSession,
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

function compactDagDecisionDetail(dagStatus: SparkDagStatusSummary): Record<string, unknown> {
  return {
    manager: dagStatus.manager,
    counts: {
      running: dagStatus.running,
      succeeded: dagStatus.succeeded,
      failed: dagStatus.failed,
      stale: dagStatus.stale,
      timedOut: dagStatus.timedOut,
      acknowledged: dagStatus.acknowledged,
      actionable: dagStatus.actionable,
    },
    activeRun: dagStatus.activeRun ? compactDagRunDecisionDetail(dagStatus.activeRun) : undefined,
    actionableRun: dagStatus.actionableRun
      ? compactDagRunDecisionDetail(dagStatus.actionableRun)
      : undefined,
    lastRun: dagStatus.lastRun ? compactDagRunDecisionDetail(dagStatus.lastRun) : undefined,
    nextSteps: dagStatus.nextSteps.map((step) => ({
      runRef: step.runRef,
      status: step.status,
      summary: truncateInline(step.summary, 200),
      nextActions: step.nextActions.slice(0, 3),
    })),
  };
}

function compactDagRunDecisionDetail(
  run: NonNullable<SparkDagStatusSummary["lastRun"]>,
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

function appendDagStatusLines(
  lines: string[],
  view: SparkStatusView,
  dagStatus: SparkDagStatusSummary,
): void {
  if (view === "active") {
    const compactDagRun = appendCompactSparkDagStatusLines(lines, dagStatus);
    if (compactDagRun) {
      const label = compactDagRun.ref === dagStatus.activeRun?.ref ? "Active" : "Actionable";
      lines.push(`  ${label} workflow run: ${formatSparkDagRun(compactDagRun)}`);
      appendSparkDagRunNextStepLines(lines, compactDagRun, "  ");
    }
  } else if (view === "summary") {
    appendCompactSparkDagStatusLines(lines, dagStatus);
  } else appendSparkDagStatusLines(lines, dagStatus);
}

function renderProjectStatusLines(
  lines: string[],
  input: SparkStatusRenderInput,
): Array<Record<string, unknown>> {
  const renderedProjectDetails: Array<Record<string, unknown>> = [];
  for (const project of input.graph.projects()) {
    const tasks = input.graph.tasks(project.ref);
    const claimed = tasks.filter((task) => taskClaimedBy(task));
    const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, input.sessionKey));
    const statusCounts = countTaskStatuses(tasks);
    const allVisibleTasks = sortTasksForStatusVisibility(
      tasks.filter((task) => isImportantStatus(task.status)),
    );
    if (
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
    const statusSuffix = project.status === "done" ? " [done]" : "";
    const projectPrefix = input.view === "active" ? "Project" : `Project ${project.ref}:`;
    lines.push(`\n${projectPrefix} ${project.title}${currentSuffix}${statusSuffix}`);
    if (input.view !== "active") lines.push(`  Project status: ${project.status}`);
    lines.push(
      `  Tasks: ${tasks.length} total | ${claimed.length} claimed | ${sessionClaimed.length} current_session_claimed | ${formatTaskStatusCounts(statusCounts)}`,
    );
    if (isCurrent && input.sessionGoal) {
      const reason =
        input.sessionGoal.pauseReason ??
        input.sessionGoal.budgetLimitedReason ??
        input.sessionGoal.completedReason;
      const reasonText = reason ? ` | reason: ${truncateInline(reason, 120)}` : "";
      const usageText = ` | usage: ${formatSessionGoalUsage(input.sessionGoal)}`;
      lines.push(
        `  ${formatGoalScopeLabel(input.sessionGoal)} goal: ${input.sessionGoal.status} | ${truncateInline(input.sessionGoal.objective, 180)}${usageText}${reasonText}`,
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
      status: project.status,
      current: isCurrent,
      taskCounts: {
        total: tasks.length,
        unfinished: tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length,
        claimed: claimed.length,
        claimedByCurrentSession: sessionClaimed.length,
        statusCounts,
      },
      hiddenFinishedTasks: hiddenByView,
      hiddenByLimit,
      sessionGoal: isCurrent ? input.sessionGoal : undefined,
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
    });
    if (visibleTasks.length === 0) lines.push("  - none");
    renderedProjectDetails.push(renderedProjectDetail);
  }
  return renderedProjectDetails;
}

function formatSessionGoalUsage(goal: NonNullable<SparkStatusRenderInput["sessionGoal"]>): string {
  const usedText = formatCompactTokenCount(goal.usage.tokensUsed);
  if (goal.tokenBudget === null)
    return `${usedText} tokens used, ${goal.usage.activeSeconds}s active`;
  return `${usedText}/${formatCompactTokenCount(goal.tokenBudget)} tokens, ${goal.usage.activeSeconds}s active`;
}

function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const count = Math.max(0, Math.round(value));
  if (count < 10_000) return count.toLocaleString("en-US");
  if (count < 1_000_000) return `${Math.round(count / 1_000).toLocaleString("en-US")}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
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
        `  - [${task.status}] @${task.name}: ${task.title} owner=@${owner}${planSuffix}${lifecycleSuffix}`,
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
      `  - [${task.status}] @${task.name}: ${task.title} (${task.ref}) kind=${task.kind} owner=@${owner} claimed=${taskClaimSummary(task)} todos=${taskSummary.total}/${taskSummary.inProgress}/${taskSummary.pending}/${taskSummary.done}${planSuffix}${lifecycleSuffix}`,
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

function formatGoalScopeLabel(goal: SparkSessionGoal): string {
  return goal.scope === "project" ? `Project(${goal.projectRef})` : "Session";
}

function sparkRunModeStatusLine(runMode: SparkRunModeState): string {
  const focusSuffix = runMode.focus ? ` focus=${runMode.focus}` : "";
  const strategy = sparkRunStrategyForMaxConcurrency(runMode.policy.maxConcurrency);
  return (
    "Spark workflow mode: " +
    runMode.status +
    " " +
    runMode.runRef +
    " project=" +
    runMode.projectRef +
    focusSuffix +
    " strategy=" +
    strategy +
    " maxConcurrency=" +
    runMode.policy.maxConcurrency +
    " timeoutMs=" +
    runMode.policy.timeoutMs
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
