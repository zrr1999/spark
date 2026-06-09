import type { TaskGraph } from "pi-tasks";
import {
  renderSparkExecutionModePrompt,
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
  queueSparkAgentInstruction: (ctx: SparkToolContext, instruction: string) => void;
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
  piApi.sendMessage(
    {
      customType: "spark-mode-request",
      content: visibleMessage,
      display: true,
    },
    { deliverAs: "followUp", triggerTurn: true },
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

export async function enterSparkExecutionMode(
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
    await saveSparkExecutionMode(ctx.cwd, ctx, project.ref, focus, "execute", strategy, {
      workflowName: persistedWorkflowSelector,
    });
  else await clearSparkExecutionMode(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark execute mode: " + strategy + " strategy selected.", "info");
  const savedWorkflows =
    strategy === "workflow" ? await discoverSparkSavedWorkflows(ctx.cwd) : undefined;
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkExecutionModePrompt(
      graph,
      project?.ref,
      focus,
      strategy,
      savedWorkflows,
      workflowSelector,
    ),
    renderSparkModeVisibleMessage(
      "execute",
      project?.title,
      focus,
      strategy,
      persistedWorkflowSelector,
    ),
  );
}
