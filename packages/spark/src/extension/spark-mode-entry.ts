import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  renderSparkImplementationModePrompt,
  renderSparkResearchModePrompt,
  renderSparkModeVisibleMessage,
  renderSparkPlanningModePrompt,
} from "./spark-mode-prompts.ts";
import { discoverSparkSavedWorkflows } from "./spark-workflow-builtins.ts";
import { roadmapPlanningContext } from "../flows/roadmap-flow.ts";
import {
  clearSparkExecutionMode,
  currentSparkProject,
  saveSparkExecutionMode,
  saveSparkGraphAndTodos,
  saveSparkPlanningMode,
  type SparkExecuteStrategy,
  type SparkPlanningModeSource,
} from "./session-state.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkModeMessageApi {
  isIdle?(): boolean;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
}

export interface SparkModeEntryDeps {
  queueSparkAgentInstruction: (
    ctx: SparkToolContext,
    instruction: string,
    options?: { goalId?: string },
  ) => void;
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  ensureDagManager: (cwd: string, ctx: SparkToolContext) => void;
}

export function dispatchSparkAgentInstruction(
  piApi: SparkModeMessageApi,
  deps: Pick<SparkModeEntryDeps, "queueSparkAgentInstruction">,
  ctx: SparkToolContext,
  instruction: string,
  visibleMessage: string,
): void {
  deps.queueSparkAgentInstruction(ctx, instruction);
  const idle = piApi.isIdle?.() ?? false;
  piApi.sendMessage(
    {
      customType: "spark-mode-request",
      content: visibleMessage,
      display: true,
    },
    idle ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true },
  );
}

export async function enterSparkResearchMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  if (project) await saveSparkExecutionMode(ctx.cwd, ctx, project.ref, focus, "research");
  else await clearSparkExecutionMode(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark research mode: investigate without changing tasks.", "info");
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkResearchModePrompt(graph, project?.ref, focus),
    renderSparkModeVisibleMessage("research", project?.title, focus),
  );
}

export async function enterSparkPlanningMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
  source: SparkPlanningModeSource = "auto",
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const roadmapResult = project ? roadmapPlanningContext(graph, project.ref, focus) : undefined;
  if (project) await saveSparkPlanningMode(ctx.cwd, ctx, project.ref, focus, source);
  else await clearSparkExecutionMode(ctx.cwd, ctx);
  if (roadmapResult?.mutated) await saveSparkGraphAndTodos(ctx.cwd, graph, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark planning mode: research, clarify, and add projects/tasks.", "info");
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkPlanningModePrompt(graph, project?.ref, focus, source, roadmapResult?.context),
    renderSparkModeVisibleMessage("plan", project?.title, focus),
  );
}

export async function enterSparkImplementationMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
  strategy: SparkExecuteStrategy = "default",
  workflowSelector?: string,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const persistedWorkflowSelector =
    workflowSelector === "agent:auto" ? undefined : workflowSelector;
  if (project)
    await saveSparkExecutionMode(ctx.cwd, ctx, project.ref, focus, "implement", strategy, {
      workflowName: persistedWorkflowSelector,
    });
  else await clearSparkExecutionMode(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark implement mode: " + strategy + " strategy selected.", "info");
  const savedWorkflows =
    strategy === "workflow" ? await discoverSparkSavedWorkflows(ctx.cwd) : undefined;
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkImplementationModePrompt(
      graph,
      project?.ref,
      focus,
      strategy,
      savedWorkflows,
      workflowSelector,
    ),
    renderSparkModeVisibleMessage(
      "implement",
      project?.title,
      focus,
      strategy,
      persistedWorkflowSelector,
    ),
  );
}
