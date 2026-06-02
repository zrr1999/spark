import type { TaskGraph, SessionTodoEntry } from "spark-tasks";
import { isUnfinishedTaskStatus } from "spark-tasks";
import type { TaskRunCompletionSummary } from "spark-core";
import type { SparkDagStatusSummary } from "spark-workflows";
import type { SparkRunModeState } from "./current-project-state.ts";
import { appendRecentRoleRunCompletionLines } from "./role-run-completions.ts";
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
  independentTodos: SessionTodoEntry[];
  recentRoleRunCompletions: TaskRunCompletionSummary[];
  state?: SparkStateHousekeepingSummary;
}

export function renderSparkStatus(input: SparkStatusRenderInput): {
  lines: string[];
  details: Record<string, unknown>;
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
      "\nSpark available: no project selected for this session. Use spark_use_project to select a project, or use view=summary/full to inspect all projects.",
    );

  const renderedProjectDetails = renderProjectStatusLines(lines, input);
  if (renderedProjectDetails.length === 0) lines.push("\nNo Spark projects matched this view.");
  const independentTodoDetails = appendIndependentTodoStatusLines(lines, input);
  if (input.state) appendSparkStateHousekeepingLines(lines, input.state);

  return {
    lines,
    details: {
      found: true,
      view: input.view,
      limit: input.taskLimit,
      activeProjectRef: input.currentProject?.ref,
      renderedProjects: renderedProjectDetails,
      independentTodos: independentTodoDetails,
      projects: compactProjectStatusSummaries(input.graph, input.sessionKey),
      dag: input.dagStatus,
      runMode: input.runMode,
      recentRoleRunCompletions: input.recentRoleRunCompletions,
      ...(input.state ? { state: input.state } : {}),
    },
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
      tasks.filter((task) => input.view === "full" || isImportantStatus(task.status)),
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
    const hiddenByView = tasks.length - allVisibleTasks.length;
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
    if (hiddenByView > 0)
      lines.push(`  Hidden finished tasks: ${hiddenByView} (use view=full to include)`);
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

function appendTaskStatusLines(
  lines: string[],
  input: SparkStatusRenderInput & {
    visibleTasks: ReturnType<TaskGraph["tasks"]>;
    lastRunsByTaskRef: ReturnType<typeof latestRunsByTaskRef>;
    renderedTaskDetails: Array<Record<string, unknown>>;
  },
): void {
  lines.push(input.view === "full" ? "  Durable tasks:" : "  Active tasks:");
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
