import type { Task, ProjectRef } from "@zendev-lab/pi-extension-api";
import type { WorkflowRunStatusSummary } from "@zendev-lab/pi-workflows";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { defaultTaskGraphStore } from "@zendev-lab/pi-tasks";
import type { SessionTodoEntry } from "@zendev-lab/pi-tasks";
import {
  SparkWidget,
  type SparkWidgetActiveLens,
  type SparkWidgetState,
  type TaskEntry,
} from "../ui/spark-widget.ts";
import { ensureLocalSparkDirectory } from "./spark-activation.ts";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkSessionKey,
  sparkSessionOwnerKey,
  type SparkSessionContext,
} from "./session-state.ts";
import {
  assignTodoDisplayNumber,
  loadTodoDisplayNumberState,
  saveTodoDisplayNumberState,
  taskTodoDisplayKey,
} from "./session-todos.ts";
import { ensureSparkGraphInvariants, isPlaceholderProjectTitle } from "./spark-graph-invariants.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import { loadSessionLoop } from "./spark-session-loops.ts";
import { latestRunsByTaskRef, taskPlanSummary } from "./task-display.ts";
import { deriveTaskRoleLabel, isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";

export interface SparkWidgetControllerContext extends SparkSessionContext {
  sparkActiveLens?: SparkWidgetActiveLens;
  ui?: unknown;
}

export class SparkWidgetController {
  private state: SparkWidgetState | undefined;
  private ctx: SparkWidgetControllerContext | undefined;
  private ui: unknown;

  private readonly widget = new SparkWidget(
    () => this.state,
    (key, cb) => {
      (
        this.ctx?.ui as { setWidget?: (...args: unknown[]) => void } | null | undefined
      )?.setWidget?.(key, cb, { placement: "aboveEditor" });
    },
  );

  async refresh(cwd: string, ctx?: SparkWidgetControllerContext): Promise<void> {
    if (ctx?.ui !== this.ui) {
      this.widget.dispose();
      this.ctx = ctx;
      this.ui = ctx?.ui;
    } else {
      this.ctx = ctx;
    }

    await ensureLocalSparkDirectory(cwd);
    const store = defaultTaskGraphStore(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    if (graph && ensureSparkGraphInvariants(graph))
      await saveSparkGraphAndTodos(cwd, graph, ctx, store);
    const sessionKey = sparkSessionKey(ctx);
    const ownerSessionKey = sparkSessionOwnerKey(ctx);
    const activeProcesses = activeSparkRoleRunProcessesForCwd(cwd);
    const activeRunRefs = new Set(activeProcesses.map((process) => process.runRef));
    const runStore = defaultSparkWorkflowRunStore(cwd);
    if (graph && activeRunRefs.size > 0) await runStore.reconcile({ graph, activeRunRefs });
    const workflowRunStatus = await runStore.status();
    const todoDisplayNumbers = await loadTodoDisplayNumberState(cwd, ctx);
    const project = graph ? await currentSparkProject(cwd, ctx, graph) : undefined;
    const sessionGoal = await loadSessionGoal(cwd, ctx);
    const sessionLoop = await loadSessionLoop(cwd, ctx);
    if (!graph || !project) {
      this.state = {
        workflowRun: sparkWorkflowRunWidgetEntry(workflowRunStatus),
        goal: sparkGoalWidgetEntry(sessionGoal, sessionLoop),
        activeLens: ctx?.sparkActiveLens,
        tasks: [],
        independentTodos: [],
        taskCountTotal: 0,
        taskCountClaimed: 0,
        taskCountClaimedBySession: 0,
        outputLanguage: "en",
      };
      if (todoDisplayNumbers.changed)
        await saveTodoDisplayNumberState(cwd, ctx, todoDisplayNumbers);
      this.widget.update();
      return;
    }

    const allTasks = graph.tasks(project.ref);
    const claimedTasks = allTasks.filter((task) => taskClaimedBy(task));
    const sessionTasks = claimedTasks.filter((task) => isClaimOwnedBySession(task, sessionKey));
    const taskTodosByRef = new Map(allTasks.map((task) => [task.ref, graph.taskTodos(task.ref)]));
    const lastRunsByTaskRef = latestRunsByTaskRef(graph.runs(project.ref));
    this.state = {
      projectTitle: isPlaceholderProjectTitle(project.title) ? undefined : project.title,
      workflowRun: sparkWorkflowRunWidgetEntry(workflowRunStatus, project.ref),
      goal: sparkGoalWidgetEntry(sessionGoal, sessionLoop),
      activeLens: ctx?.sparkActiveLens,
      tasks: allTasks.map((task) => {
        const backgroundOwner =
          task.claim?.kind === "role-run" &&
          task.claim.sessionId === ownerSessionKey &&
          task.claim.runRef &&
          activeRunRefs.has(task.claim.runRef)
            ? "session"
            : undefined;
        const showTodos = shouldExposeTaskTodosInWidget(task, sessionKey, backgroundOwner);
        return {
          title: task.title,
          status: mapTaskStatus(task.status),
          claim: mapTaskClaim(task, sessionKey),
          agentLabel: deriveTaskRoleLabel({
            task,
            currentSessionKey: sessionKey,
            latestRun: lastRunsByTaskRef.get(task.ref),
          }),
          planSummary: taskPlanSummary(task),
          backgroundOwner,
          todos: showTodos
            ? (taskTodosByRef.get(task.ref) ?? []).map((todo) => ({
                id: todo.id,
                displayNumber: assignTodoDisplayNumber(
                  todoDisplayNumbers,
                  taskTodoDisplayKey(task.ref, todo.id),
                ),
                content: todo.content,
                status: mapTodoStatus(todo.status),
              }))
            : [],
        };
      }),
      independentTodos: [],
      taskCountTotal: allTasks.length,
      taskCountClaimed: claimedTasks.length,
      taskCountClaimedBySession: sessionTasks.length,
      outputLanguage: (project.outputLanguage as "zh" | "en" | undefined) ?? "en",
    };

    if (todoDisplayNumbers.changed) await saveTodoDisplayNumberState(cwd, ctx, todoDisplayNumbers);
    this.widget.update();
  }
}

function mapTaskStatus(status: string): TaskEntry["status"] {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "blocked";
    default:
      return "pending";
  }
}

function mapTaskClaim(task: Task, sessionKey: string): TaskEntry["claim"] {
  if (task.claim?.kind === "role-run") return "role-run";
  const claimedBy = taskClaimedBy(task);
  if (!claimedBy) return undefined;
  return isClaimOwnedBySession(task, sessionKey) ? "mine" : "other";
}

function shouldExposeTaskTodosInWidget(
  task: Task,
  sessionKey: string,
  backgroundOwner: TaskEntry["backgroundOwner"],
): boolean {
  if (task.status === "done" || task.status === "cancelled") return false;
  if (isClaimOwnedBySession(task, sessionKey)) return true;
  return task.claim?.kind === "role-run" && backgroundOwner === "session";
}

function mapTodoStatus(status: string): SessionTodoEntry["status"] {
  switch (status) {
    case "in_progress":
    case "done":
    case "blocked":
    case "cancelled":
    case "pending":
      return status;
    default:
      return "pending";
  }
}

function sparkGoalWidgetEntry(
  sessionGoal: Awaited<ReturnType<typeof loadSessionGoal>>,
  sessionLoop: Awaited<ReturnType<typeof loadSessionLoop>>,
) {
  if (sessionGoal && sessionGoal.status !== "complete") {
    return {
      kind: "goal" as const,
      status: sessionGoal.status,
      objective: compactGoalObjective(sessionGoal.objective),
    };
  }
  if (sessionLoop) {
    return {
      kind: "loop" as const,
      status: sessionLoop.status,
      objective: compactGoalObjective(sessionLoop.objective),
    };
  }
  return sessionGoal
    ? {
        kind: "goal" as const,
        status: sessionGoal.status,
        objective: compactGoalObjective(sessionGoal.objective),
      }
    : undefined;
}

function compactGoalObjective(objective: string): string {
  const firstLine = objective
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const normalized = (firstLine ?? objective).replace(/\s+/gu, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function sparkWorkflowRunWidgetEntry(
  workflowRunStatus: WorkflowRunStatusSummary,
  projectRef?: ProjectRef,
): SparkWidgetState["workflowRun"] {
  const activeRun = workflowRunStatus.activeRun;
  if (activeRun && (!projectRef || activeRun.projectRef === projectRef)) {
    return {
      status: activeRun.status,
      runRef: activeRun.ref,
      scheduled: activeRun.scheduled,
      completed: activeRun.completed,
      active: true,
    };
  }
  const actionableRun = workflowRunStatus.actionableRun;
  if (actionableRun && (!projectRef || actionableRun.projectRef === projectRef)) {
    return {
      status: actionableRun.status,
      runRef: actionableRun.ref,
      scheduled: actionableRun.scheduled,
      completed: actionableRun.completed,
    };
  }
  return undefined;
}
