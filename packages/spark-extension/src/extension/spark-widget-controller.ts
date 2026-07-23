import {
  SparkWidgetController as SparkHostWidgetController,
  type SparkWidgetControllerContext,
  type SparkWidgetControllerDeps,
} from "@zendev-lab/spark-host/spark-widget-controller";
import { projectSparkDynamicWorkflowRuns } from "./spark-dynamic-workflow-run-rendering.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { defaultSparkDynamicWorkflowEventStore } from "./spark-dynamic-workflow-event-store.ts";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { ensureLocalSparkDirectory } from "./spark-activation.ts";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkPhase,
  saveSparkGraphAndTodos,
  sparkSessionKey,
  sparkSessionOwnerKey,
  sparkStateCwd,
} from "./session-state.ts";
import {
  assignTodoDisplayNumber,
  loadIndependentTodos,
  loadTodoDisplayNumberState,
  saveTodoDisplayNumberState,
  taskTodoDisplayKey,
} from "./session-todos.ts";
import { independentTodoDisplayKey } from "@zendev-lab/spark-tasks";
import { renderSparkProjectKindDisplay } from "./project-kind-registry.ts";
import { deriveSparkDriveMode, sparkActiveLens } from "./spark-drive-state.ts";
import { ensureSparkGraphInvariants, isPlaceholderProjectTitle } from "./spark-graph-invariants.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import { clearSessionLoop, loadSessionLoop } from "./spark-session-loops.ts";
import { readSessionRepro } from "./spark-session-repro.ts";
import { latestRunsByTaskRef, taskPlanSummary } from "./task-display.ts";
import { deriveTaskRoleLabel, isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";

export type { SparkWidgetControllerContext };

const piExtensionWidgetControllerDeps: SparkWidgetControllerDeps = {
  ensureLocalSparkDirectory,
  defaultTaskGraphStore: (cwd, ctx) => defaultTaskGraphStore(sparkStateCwd(cwd, ctx)),
  loadSparkGraph: (cwd, ctx) => loadSparkGraph(cwd, ctx),
  ensureSparkGraphInvariants,
  saveSparkGraphAndTodos: (cwd, graph, ctx, store) =>
    saveSparkGraphAndTodos(cwd, graph, ctx, store),
  sparkSessionKey: (ctx) => sparkSessionKey(ctx),
  sparkSessionOwnerKey: (ctx) => sparkSessionOwnerKey(ctx),
  activeSparkRoleRunProcessesForCwd,
  defaultSparkWorkflowRunStore: (cwd) => defaultSparkWorkflowRunStore(cwd),
  listDynamicWorkflowRuns: async (cwd) =>
    projectSparkDynamicWorkflowRuns({
      runs: await defaultSparkDynamicWorkflowEventStore(cwd).listRuns(),
      includeHistory: false,
    }),
  loadTodoDisplayNumberState: (cwd, ctx) => loadTodoDisplayNumberState(cwd, ctx),
  saveTodoDisplayNumberState: (cwd, ctx, state) => saveTodoDisplayNumberState(cwd, ctx, state),
  loadIndependentTodos: (cwd, ctx) => loadIndependentTodos(cwd, ctx),
  currentSparkProject: (cwd, ctx, graph) => currentSparkProject(cwd, ctx, graph),
  loadSessionGoal: (cwd, ctx) => loadSessionGoal(cwd, ctx),
  loadSessionLoop: (cwd, ctx) => loadSessionLoop(cwd, ctx),
  clearSessionLoop: (cwd, ctx) => clearSessionLoop(cwd, ctx),
  readSessionRepro: (cwd, ctx) => readSessionRepro(cwd, ctx),
  loadSparkPhase: (cwd, ctx) => loadSparkPhase(cwd, ctx),
  sparkActiveLens,
  deriveSparkDriveMode,
  renderSparkProjectKindDisplay,
  isPlaceholderProjectTitle,
  latestRunsByTaskRef,
  taskPlanSummary,
  deriveTaskRoleLabel: (input) => deriveTaskRoleLabel(input),
  isClaimOwnedBySession,
  taskClaimedBy,
  assignTodoDisplayNumber,
  taskTodoDisplayKey,
  independentTodoDisplayKey,
};

/** Compatibility shim: widget rendering/controller logic lives in spark-host. */
export class SparkWidgetController extends SparkHostWidgetController {
  constructor() {
    super(piExtensionWidgetControllerDeps);
  }
}
