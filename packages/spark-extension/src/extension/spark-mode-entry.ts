import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  renderSparkImplementationModePrompt,
  renderSparkModeVisibleMessage,
  renderSparkPlanningModePrompt,
  renderSparkResearchModePrompt,
} from "./mode/index.ts";
import { roadmapPlanningContext } from "../flows/roadmap-flow.ts";
import {
  clearCurrentProjectRef,
  currentSparkProject,
  saveCurrentProjectRef,
  saveSparkGraphAndTodos,
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
  const sendUserMessage = piApi.sendUserMessage?.bind(piApi);
  const queuedAsUserMessage = Boolean(sendUserMessage);
  sendUserMessage?.(instruction, {
    deliverAs: idle ? "steer" : "followUp",
    streamingBehavior: "followUp",
  });
  piApi.sendMessage(
    {
      customType: "spark-mode-request",
      content: instruction,
      display: false,
      details: { visible: visibleMessage },
    },
    queuedAsUserMessage
      ? { deliverAs: "nextTurn", triggerTurn: true }
      : idle
        ? { triggerTurn: true }
        : { deliverAs: "followUp", triggerTurn: true },
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
  ctx.sparkActiveLens = { mode: "research", driver: "interactive" };
  if (project) await saveCurrentProjectRef(ctx.cwd, ctx, project.ref);
  else await clearCurrentProjectRef(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark default research: investigate without changing tasks.", "info");
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
  ctx.sparkActiveLens = { mode: "plan", driver: "interactive" };
  if (project) await saveCurrentProjectRef(ctx.cwd, ctx, project.ref);
  else await clearCurrentProjectRef(ctx.cwd, ctx);
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
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  ctx.sparkActiveLens = { mode: "implement", driver: "interactive" };
  if (project) await saveCurrentProjectRef(ctx.cwd, ctx, project.ref);
  else await clearCurrentProjectRef(ctx.cwd, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark implement mode: work until the next blocker.", "info");
  dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkImplementationModePrompt(graph, project?.ref, focus),
    renderSparkModeVisibleMessage("implement", project?.title, focus),
  );
}
