import type { TaskGraph } from "spark-tasks";
import { roadmapPlanningContext } from "../flows/roadmap-flow.ts";
import {
  renderSparkExecutionModePrompt,
  renderSparkModeVisibleMessage,
  renderSparkPlanningModePrompt,
  renderSparkRunSequentialModePrompt,
} from "./spark-mode-prompts.ts";
import {
  clearSparkExecutionMode,
  currentSparkProject,
  saveSparkExecutionMode,
  saveSparkPlanningMode,
  saveSparkRunMode,
  type SparkPlanningModeSource,
  type SparkRunStrategy,
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

export async function enterSparkPlanningMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
  source: SparkPlanningModeSource = "auto",
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const roadmapContext = await roadmapPlanningContext(ctx.cwd, focus);
  if (project) await saveSparkPlanningMode(ctx.cwd, ctx, project.ref, focus, source);
  else await clearSparkExecutionMode(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark planning mode: research, clarify, and add projects/tasks.", "info");
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkPlanningModePrompt(graph, project?.ref, focus, roadmapContext, source),
    renderSparkModeVisibleMessage("planning", project?.title, focus),
  );
}

export async function enterSparkExecutionMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  if (project) await saveSparkExecutionMode(ctx.cwd, ctx, project.ref, focus);
  else await clearSparkExecutionMode(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark execution mode: execute one task, then stop.", "info");
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkExecutionModePrompt(graph, project?.ref, focus),
    renderSparkModeVisibleMessage("execution", project?.title, focus),
  );
}

export async function enterSparkRunMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus: string | undefined,
  strategy: SparkRunStrategy,
): Promise<void> {
  if (strategy === "sequential") {
    return enterSparkRunSequentialMode(piApi, deps, ctx, graph, focus);
  }
  return enterSparkRunParallelMode(piApi, deps, ctx, graph, focus);
}

async function enterSparkRunSequentialMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus: string | undefined,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  if (project) await saveSparkExecutionMode(ctx.cwd, ctx, project.ref, focus, "execute", "goal");
  else await clearSparkExecutionMode(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.(
    project
      ? "Spark sequential run mode: foreground loop starting in this session."
      : "Spark sequential run mode: select a project before starting.",
    "info",
  );
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkRunSequentialModePrompt(graph, project?.ref, focus),
    renderSparkModeVisibleMessage("run", project?.title, focus, "sequential"),
  );
}

async function enterSparkRunParallelMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus: string | undefined,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const runMode = project
    ? await saveSparkRunMode(ctx.cwd, ctx, project.ref, focus, "parallel")
    : undefined;
  if (!project) await clearSparkExecutionMode(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  if (runMode) deps.ensureDagManager(ctx.cwd, ctx);
  ctx.ui?.notify?.(
    runMode
      ? `Spark parallel run mode: background orchestrator ${runMode.runRef} started for current project.`
      : "Spark parallel run mode: select a project before starting a background run.",
    "info",
  );
  piApi.sendMessage(
    {
      customType: "spark-mode-request",
      content: renderSparkModeVisibleMessage("run", project?.title, focus, "parallel"),
      display: true,
      details: {
        runModeStarted: Boolean(runMode),
        runModeRef: runMode?.runRef,
        projectRef: project?.ref,
        runStrategy: "parallel",
        backgroundOrchestrator: runMode
          ? "started_or_resumed_without_agent_turn"
          : "project_required",
      },
    },
    { deliverAs: "followUp", triggerTurn: false },
  );
}
