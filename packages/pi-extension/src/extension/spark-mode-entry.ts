import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  renderSparkImplementationModePrompt,
  renderSparkPhaseVisibleMessage,
  renderSparkPlanningModePrompt,
} from "./mode/index.ts";
import { roadmapPlanningContext } from "../flows/roadmap-flow.ts";
import {
  clearCurrentProjectRef,
  currentSparkProject,
  saveSparkGraphAndTodos,
  saveSparkPhase,
  type SparkPlanningModeSource,
} from "./session-state.ts";
import { sparkActiveLens } from "./spark-drive-state.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkModeMessageApi {
  isIdle?(): boolean;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
      authority?: "runtime_control" | "runtime_data";
      trust?: "trusted" | "untrusted";
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
  sendUserMessage?(
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp" | "nextTurn";
      streamingBehavior?: "steer" | "followUp";
    },
  ): void;
}

export interface SparkModeEntryDeps {
  queueSparkAgentInstruction: (
    ctx: SparkToolContext,
    instruction: string,
    options?: { goalId?: string },
  ) => void;
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  ensureWorkflowRunManager: (cwd: string, ctx: SparkToolContext) => void;
}

export function dispatchSparkAgentInstruction(
  piApi: SparkModeMessageApi,
  _deps: Pick<SparkModeEntryDeps, "queueSparkAgentInstruction">,
  _ctx: SparkToolContext,
  instruction: string,
  visibleMessage: string,
): void {
  const idle = piApi.isIdle?.() ?? false;
  piApi.sendMessage(
    {
      customType: "spark-mode-request",
      content: instruction,
      display: false,
      authority: "runtime_control",
      trust: "trusted",
      details: { visible: visibleMessage },
    },
    idle ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true },
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
  ctx.sparkActiveLens = sparkActiveLens("plan", "assist");
  if (project) await saveSparkPhase(ctx.cwd, ctx, { phase: "plan", projectRef: project.ref });
  else {
    await saveSparkPhase(ctx.cwd, ctx, { phase: "plan" });
    await clearCurrentProjectRef(ctx.cwd, ctx);
  }
  if (roadmapResult?.mutated) await saveSparkGraphAndTodos(ctx.cwd, graph, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.(
    "Spark plan phase: investigate, answer, and plan durable work when needed.",
    "info",
  );
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkPlanningModePrompt(graph, project?.ref, focus, source, roadmapResult?.context),
    renderSparkPhaseVisibleMessage("plan", project?.title, focus),
  );
}

export async function enterSparkImplementationMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  ctx.sparkActiveLens = sparkActiveLens("implement", "assist");
  if (project) await saveSparkPhase(ctx.cwd, ctx, { phase: "implement", projectRef: project.ref });
  else {
    await saveSparkPhase(ctx.cwd, ctx, { phase: "implement" });
    await clearCurrentProjectRef(ctx.cwd, ctx);
  }
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark implement phase: work until the next blocker.", "info");
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkImplementationModePrompt(graph, project?.ref, focus),
    renderSparkPhaseVisibleMessage("implement", project?.title, focus),
  );
}
