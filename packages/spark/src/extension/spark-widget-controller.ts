import type { Task, ProjectRef } from "pi-extension-api";
import type { WorkflowRunStatusSummary } from "pi-workflows";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { defaultTaskGraphStore } from "pi-tasks";
import { independentTodoDisplayKey, isActiveSessionTodo, type SessionTodoEntry } from "pi-tasks";
import { SparkWidget, type SparkWidgetState, type TaskEntry } from "../ui/spark-widget.ts";
import { ensureLocalSparkDirectory } from "./spark-activation.ts";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import {
  currentSparkProject,
  loadCurrentProjectState,
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkSessionKey,
  sparkSessionOwnerKey,
  type SparkSessionContext,
  type SparkRunModeState,
} from "./session-state.ts";
import {
  assignTodoDisplayNumber,
  loadIndependentTodos,
  loadTodoDisplayNumberState,
  saveTodoDisplayNumberState,
  taskTodoDisplayKey,
} from "./session-todos.ts";
import { ensureSparkGraphInvariants, isPlaceholderProjectTitle } from "./spark-graph-invariants.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import { latestRunsByTaskRef, taskPlanSummary } from "./task-display.ts";
import { deriveTaskRoleLabel, isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";

export interface SparkWidgetControllerContext extends SparkSessionContext {
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
    const dagRunStore = defaultSparkWorkflowRunStore(cwd);
    if (graph && activeRunRefs.size > 0) await dagRunStore.reconcile({ graph, activeRunRefs });
    const dagStatus = await dagRunStore.status();
    const independentTodos = (await loadIndependentTodos(cwd, ctx)).filter(isActiveSessionTodo);
    const todoDisplayNumbers = await loadTodoDisplayNumberState(cwd, ctx);
    const numberedIndependentTodos = independentTodos.map((todo) => ({
      ...todo,
      displayNumber: assignTodoDisplayNumber(todoDisplayNumbers, independentTodoDisplayKey(todo)),
    }));
    const project = graph ? await currentSparkProject(cwd, ctx, graph) : undefined;
    const currentState = await loadCurrentProjectState(cwd, ctx);
    const sessionGoal = await loadSessionGoal(cwd, ctx);
    if (!graph || !project) {
      this.state = {
        dag: sparkDagWidgetEntry(dagStatus),
        run: sparkRunWidgetEntry(currentState?.runMode),
        goal: sparkGoalWidgetEntry(sessionGoal),
        tasks: [],
        independentTodos: numberedIndependentTodos,
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
      dag: sparkDagWidgetEntry(dagStatus, project.ref),
      run: sparkRunWidgetEntry(currentState?.runMode, project.ref),
      goal: sparkGoalWidgetEntry(sessionGoal),
      tasks: allTasks.map((task) => ({
        title: task.title,
        status: mapTaskStatus(task.status),
        claim: mapTaskClaim(task, sessionKey),
        agentLabel: deriveTaskRoleLabel({
          task,
          currentSessionKey: sessionKey,
          latestRun: lastRunsByTaskRef.get(task.ref),
        }),
        planSummary: taskPlanSummary(task),
        backgroundOwner:
          task.claim?.kind === "role-run" &&
          task.claim.sessionId === ownerSessionKey &&
          task.claim.runRef &&
          activeRunRefs.has(task.claim.runRef)
            ? "session"
            : undefined,
        todos: (taskTodosByRef.get(task.ref) ?? []).map((todo) => ({
          id: todo.id,
          displayNumber: assignTodoDisplayNumber(
            todoDisplayNumbers,
            taskTodoDisplayKey(task.ref, todo.id),
          ),
          content: todo.content,
          status: mapTodoStatus(todo.status),
        })),
      })),
      independentTodos: numberedIndependentTodos,
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

function sparkGoalWidgetEntry(sessionGoal: Awaited<ReturnType<typeof loadSessionGoal>>) {
  return sessionGoal
    ? {
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

function sparkRunWidgetEntry(
  runMode: SparkRunModeState | undefined,
  projectRef?: ProjectRef,
): SparkWidgetState["run"] {
  if (!runMode) return undefined;
  if (projectRef && runMode.projectRef !== projectRef) return undefined;
  return { status: runMode.status, runRef: runMode.runRef, focus: runMode.focus };
}

function sparkDagWidgetEntry(
  dagStatus: WorkflowRunStatusSummary,
  projectRef?: ProjectRef,
): SparkWidgetState["dag"] {
  const activeRun = dagStatus.activeRun;
  if (activeRun && (!projectRef || activeRun.projectRef === projectRef)) {
    return {
      status: activeRun.status,
      runRef: activeRun.ref,
      scheduled: activeRun.scheduled,
      completed: activeRun.completed,
      active: true,
    };
  }
  const actionableRun = dagStatus.actionableRun;
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
