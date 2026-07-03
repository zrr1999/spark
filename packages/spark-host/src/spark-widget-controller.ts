import type { ProjectRef, Task } from "@zendev-lab/spark-extension-api";
import type { WorkflowRunStatusSummary } from "@zendev-lab/spark-workflows";
import type { SessionTodoEntry } from "@zendev-lab/spark-tasks";
import {
  SparkWidget,
  type SparkWidgetActiveLens,
  type SparkWidgetState,
  type TaskEntry,
} from "./spark-widget.ts";

export interface SparkWidgetControllerContext {
  sparkActiveLens?: SparkWidgetActiveLens;
  ui?: unknown;
}

export interface SparkWidgetControllerDeps {
  ensureLocalSparkDirectory: (cwd: string) => Promise<void>;
  defaultTaskGraphStore: (cwd: string) => unknown;
  loadSparkGraph: (cwd: string, ctx?: any) => Promise<any>;
  ensureSparkGraphInvariants: (graph: any) => boolean;
  saveSparkGraphAndTodos: (cwd: string, graph: any, ctx: any, store: any) => Promise<void>;
  sparkSessionKey: (ctx?: any) => string;
  sparkSessionOwnerKey: (ctx?: any) => string;
  activeSparkRoleRunProcessesForCwd: (cwd: string) => Array<{ runRef?: string }>;
  defaultSparkWorkflowRunStore: (cwd: string) => {
    reconcile(input: any): Promise<unknown>;
    status(): Promise<WorkflowRunStatusSummary>;
  };
  listDynamicWorkflowRuns: (cwd: string) => Promise<SparkDynamicWorkflowRunProjection[]>;
  loadTodoDisplayNumberState: (cwd: string, ctx?: any) => Promise<any>;
  saveTodoDisplayNumberState: (cwd: string, ctx: any, state: any) => Promise<void>;
  currentSparkProject: (cwd: string, ctx: any, graph: any) => Promise<any>;
  loadSessionGoal: (cwd: string, ctx?: any) => Promise<any>;
  loadSessionLoop: (cwd: string, ctx?: any) => Promise<any>;
  clearSessionLoop: (cwd: string, ctx?: any) => Promise<void>;
  readSessionRepro: (cwd: string, ctx?: any) => Promise<any>;
  loadSparkPhase: (cwd: string, ctx?: any) => Promise<{ phase: "research" | "plan" | "implement" }>;
  sparkActiveLens: (phase: "research" | "plan" | "implement", drive?: any) => SparkWidgetActiveLens;
  deriveSparkDriveMode: (input: {
    activeLens?: SparkWidgetActiveLens;
    repro?: any;
    goal?: any;
    loop?: any;
  }) => unknown;
  renderSparkProjectKindDisplay: (project: any) => SparkWidgetState["projectKind"];
  isPlaceholderProjectTitle: (title: string) => boolean;
  latestRunsByTaskRef: (runs: any) => Map<string, any>;
  taskPlanSummary: (task: Task) => TaskEntry["planSummary"];
  deriveTaskRoleLabel: (input: {
    task: Task;
    currentSessionKey: string;
    latestRun?: any;
  }) => string | undefined;
  isClaimOwnedBySession: (task: Task, sessionKey: string) => boolean;
  taskClaimedBy: (task: Task) => unknown;
  assignTodoDisplayNumber: (state: any, key: string) => number;
  taskTodoDisplayKey: (taskRef: string, todoId: string) => string;
}

export interface SparkDynamicWorkflowRunProjection {
  ref: string;
  name: string;
  status: "running" | "paused" | "succeeded" | "failed" | "stale" | "stopped";
  completedNodes: number;
  totalNodes: number;
  active?: boolean;
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

  private readonly deps: SparkWidgetControllerDeps;

  constructor(deps: SparkWidgetControllerDeps) {
    this.deps = deps;
  }

  async refresh(cwd: string, ctx?: SparkWidgetControllerContext): Promise<void> {
    if (ctx?.ui !== this.ui) {
      this.widget.dispose();
      this.ctx = ctx;
      this.ui = ctx?.ui;
    } else {
      this.ctx = ctx;
    }

    await this.deps.ensureLocalSparkDirectory(cwd);
    const store = this.deps.defaultTaskGraphStore(cwd);
    const graph = await this.deps.loadSparkGraph(cwd, ctx);
    if (graph && this.deps.ensureSparkGraphInvariants(graph))
      await this.deps.saveSparkGraphAndTodos(cwd, graph, ctx, store);
    const sessionKey = this.deps.sparkSessionKey(ctx);
    const ownerSessionKey = this.deps.sparkSessionOwnerKey(ctx);
    const activeProcesses = this.deps.activeSparkRoleRunProcessesForCwd(cwd);
    const activeRunRefs = new Set(
      activeProcesses
        .map((process) => process.runRef)
        .filter((runRef): runRef is string => typeof runRef === "string"),
    );
    const runStore = this.deps.defaultSparkWorkflowRunStore(cwd);
    if (graph && activeRunRefs.size > 0) await runStore.reconcile({ graph, activeRunRefs });
    const workflowRunStatus = await runStore.status();
    const dynamicWorkflowRuns = await this.deps
      .listDynamicWorkflowRuns(cwd)
      .catch(() => [] as SparkDynamicWorkflowRunProjection[]);
    const dynamicWorkflowRun = sparkDynamicWorkflowRunWidgetEntry(dynamicWorkflowRuns);
    const todoDisplayNumbers = await this.deps.loadTodoDisplayNumberState(cwd, ctx);
    const project = graph ? await this.deps.currentSparkProject(cwd, ctx, graph) : undefined;
    const sessionGoal = await this.deps.loadSessionGoal(cwd, ctx);
    let sessionLoop = await this.deps.loadSessionLoop(cwd, ctx);
    if (sessionLoop?.status === "paused") {
      await this.deps.clearSessionLoop(cwd, ctx);
      sessionLoop = undefined;
    }
    const sessionRepro = await this.deps.readSessionRepro(cwd, ctx);
    const foregroundDriver = sparkForegroundDriverWidgetEntries(
      sessionGoal,
      sessionLoop,
      sessionRepro,
    );
    const phase = (await this.deps.loadSparkPhase(cwd, ctx)).phase;
    const activeLens = this.deps.sparkActiveLens(
      phase,
      this.deps.deriveSparkDriveMode({
        activeLens: ctx?.sparkActiveLens,
        repro: sessionRepro,
        goal: sessionGoal,
        loop: sessionLoop,
      }),
    );
    if (!graph || !project) {
      this.state = {
        workflowRun: sparkWorkflowRunWidgetEntry(workflowRunStatus),
        dynamicWorkflowRun,
        ...foregroundDriver,
        activeLens,
        tasks: [],
        independentTodos: [],
        taskCountTotal: 0,
        taskCountClaimed: 0,
        taskCountClaimedBySession: 0,
        outputLanguage: "en",
      };
      if (todoDisplayNumbers.changed)
        await this.deps.saveTodoDisplayNumberState(cwd, ctx, todoDisplayNumbers);
      this.widget.update();
      return;
    }

    const allTasks = graph.tasks(project.ref) as Task[];
    const claimedTasks = allTasks.filter((task: Task) => this.deps.taskClaimedBy(task));
    const sessionTasks = claimedTasks.filter((task: Task) =>
      this.deps.isClaimOwnedBySession(task, sessionKey),
    );
    const taskTodosByRef = new Map(
      allTasks.map((task) => [task.ref, graph.taskTodos(task.ref) as SessionTodoEntry[]]),
    );
    const lastRunsByTaskRef = this.deps.latestRunsByTaskRef(graph.runs(project.ref));
    this.state = {
      projectTitle: this.deps.isPlaceholderProjectTitle(project.title) ? undefined : project.title,
      workflowRun: sparkWorkflowRunWidgetEntry(workflowRunStatus, project.ref),
      dynamicWorkflowRun,
      ...foregroundDriver,
      projectKind: this.deps.renderSparkProjectKindDisplay(project),
      activeLens,
      tasks: allTasks.map((task: Task) => {
        const backgroundOwner =
          task.claim?.kind === "role-run" &&
          task.claim.sessionId === ownerSessionKey &&
          task.claim.runRef &&
          activeRunRefs.has(task.claim.runRef)
            ? "session"
            : undefined;
        const showTodos = shouldExposeTaskTodosInWidget(
          task,
          sessionKey,
          backgroundOwner,
          this.deps,
        );
        return {
          title: task.title,
          status: mapTaskStatus(task.status),
          claim: mapTaskClaim(task, sessionKey, this.deps),
          agentLabel: this.deps.deriveTaskRoleLabel({
            task,
            currentSessionKey: sessionKey,
            latestRun: lastRunsByTaskRef.get(task.ref),
          }),
          planSummary: this.deps.taskPlanSummary(task),
          backgroundOwner,
          todos: showTodos
            ? (taskTodosByRef.get(task.ref) ?? []).map((todo: SessionTodoEntry) => ({
                id: todo.id,
                displayNumber: this.deps.assignTodoDisplayNumber(
                  todoDisplayNumbers,
                  this.deps.taskTodoDisplayKey(task.ref, String(todo.id)),
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

    if (todoDisplayNumbers.changed)
      await this.deps.saveTodoDisplayNumberState(cwd, ctx, todoDisplayNumbers);
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

function mapTaskClaim(
  task: Task,
  sessionKey: string,
  deps: Pick<SparkWidgetControllerDeps, "taskClaimedBy" | "isClaimOwnedBySession">,
): TaskEntry["claim"] {
  if (task.claim?.kind === "role-run") return "role-run";
  const claimedBy = deps.taskClaimedBy(task);
  if (!claimedBy) return undefined;
  return deps.isClaimOwnedBySession(task, sessionKey) ? "mine" : "other";
}

function shouldExposeTaskTodosInWidget(
  task: Task,
  sessionKey: string,
  backgroundOwner: TaskEntry["backgroundOwner"],
  deps: Pick<SparkWidgetControllerDeps, "isClaimOwnedBySession">,
): boolean {
  if (task.status === "done" || task.status === "cancelled") return false;
  if (deps.isClaimOwnedBySession(task, sessionKey)) return true;
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

function sparkForegroundDriverWidgetEntries(
  sessionGoal: any,
  sessionLoop: any,
  sessionRepro?: any,
): Pick<SparkWidgetState, "goal" | "loop" | "repro"> {
  if (sessionRepro?.status === "active") {
    const stage = sessionRepro.stages[sessionRepro.currentStageIndex];
    return {
      repro: {
        status: sessionRepro.status,
        stageName: stage.name,
        stageIndex: sessionRepro.currentStageIndex,
        totalStages: sessionRepro.stages.length,
        phase: sessionRepro.currentPhase,
        acceptance: stage.acceptance.map((c: { description: string; satisfied: boolean }) => ({
          description: c.description,
          satisfied: c.satisfied,
        })),
        gate: stage.gate ? { id: stage.gate.id, passed: stage.gate.passed } : undefined,
      },
    };
  }
  if (sessionGoal && sessionGoal.status !== "complete") {
    return {
      goal: {
        status: sessionGoal.status,
        objective: compactGoalObjective(sessionGoal.objective),
      },
    };
  }
  if (sessionLoop?.status === "active") {
    return {
      loop: {
        status: sessionLoop.status,
        objective: compactGoalObjective(sessionLoop.objective),
        schedule: sessionLoop.schedule
          ? sparkLoopScheduleWidgetEntry(sessionLoop.schedule)
          : undefined,
      },
    };
  }
  return sessionGoal
    ? {
        goal: {
          status: sessionGoal.status,
          objective: compactGoalObjective(sessionGoal.objective),
        },
      }
    : {};
}

function sparkLoopScheduleWidgetEntry(schedule: {
  scheduledAt: string;
  nextRunAt: string;
  delayMs: number;
}) {
  const scheduledAtMs = Date.parse(schedule.scheduledAt);
  const nextRunAtMs = Date.parse(schedule.nextRunAt);
  if (!Number.isFinite(scheduledAtMs) || !Number.isFinite(nextRunAtMs)) return undefined;
  return {
    label: formatLoopScheduleLabel(schedule.delayMs),
    scheduledAtMs,
    nextRunAtMs,
  };
}

function formatLoopScheduleLabel(delayMs: number): string {
  if (delayMs >= 24 * 60 * 60_000 && delayMs % (24 * 60 * 60_000) === 0)
    return `${delayMs / (24 * 60 * 60_000)}d`;
  if (delayMs >= 3_600_000 && delayMs % 3_600_000 === 0) return `${delayMs / 3_600_000}h`;
  if (delayMs >= 60_000 && delayMs % 60_000 === 0) return `${delayMs / 60_000}m`;
  if (delayMs >= 1_000 && delayMs % 1_000 === 0) return `${delayMs / 1_000}s`;
  return `${delayMs}ms`;
}

function compactGoalObjective(objective: string): string {
  const firstLine = objective
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const normalized = (firstLine ?? objective).replace(/\s+/gu, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function sparkDynamicWorkflowRunWidgetEntry(
  runs: SparkDynamicWorkflowRunProjection[],
): SparkWidgetState["dynamicWorkflowRun"] {
  const run =
    runs.find((candidate) => candidate.active) ??
    runs.find((candidate) => candidate.status === "succeeded" || candidate.status === "failed") ??
    runs[0];
  if (!run) return undefined;
  return {
    status: run.status,
    runRef: run.ref,
    name: run.name,
    completedNodes: run.completedNodes,
    totalNodes: run.totalNodes,
    active: run.active,
    ...(run.status === "succeeded" ? { delivery: "result" as const } : {}),
    ...(run.status === "failed" ? { delivery: "error" as const } : {}),
  };
}

function sparkWorkflowRunWidgetEntry(
  workflowRunStatus: WorkflowRunStatusSummary,
  projectRef?: ProjectRef,
): SparkWidgetState["workflowRun"] {
  const activeRun = workflowRunStatus.activeRun;
  if (
    !activeRun ||
    activeRun.status !== "running" ||
    (projectRef && activeRun.projectRef !== projectRef)
  )
    return undefined;
  return {
    status: activeRun.status,
    runRef: activeRun.ref,
    scheduled: activeRun.scheduled,
    completed: activeRun.completed,
    active: true,
  };
}
