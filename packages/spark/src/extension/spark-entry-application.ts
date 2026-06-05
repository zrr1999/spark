import { detectCopyLanguage, type CopyLanguage } from "pi-extension-api";
import type { ProjectRef } from "pi-extension-api";
import type { TaskGraph } from "pi-tasks";
import type { SparkEntryResolution } from "./spark-entry.ts";
import { titleFromIdea, type SparkInitClarificationData } from "./spark-md-rendering.ts";
import { renderSparkInitFollowUp, renderSparkInitSummary } from "./spark-init-rendering.ts";
import { initializeSparkIdea } from "./spark-initialization.ts";
import {
  loadSparkGraph,
  saveCurrentProjectRef,
  type SparkPlanningModeSource,
} from "./session-state.ts";
import {
  dispatchSparkAgentInstruction,
  enterSparkExecutionMode,
  enterSparkPlanningMode,
  enterSparkResearchMode,
  type SparkModeEntryDeps,
  type SparkModeMessageApi,
} from "./spark-mode-entry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkEntryApplicationDeps extends SparkModeEntryDeps {}

export async function applySparkEntryResolution(
  piApi: SparkModeMessageApi,
  deps: SparkEntryApplicationDeps,
  ctx: SparkToolContext,
  graph: TaskGraph | null,
  resolution: SparkEntryResolution,
): Promise<void> {
  switch (resolution.action) {
    case "initialize_new_project":
      await startSparkNewProject(piApi, deps, ctx, resolution.idea, {
        enterPlanning: resolution.enterPlanning,
        planningSource: resolution.planningSource,
      });
      return;
    case "initialize_existing_project":
      await startSparkNewProject(piApi, deps, ctx, resolution.idea, {
        enterPlanning: true,
        planningSource: resolution.planningSource,
        materializeSparkMd: resolution.planningSource !== "direct",
      });
      return;
    case "enter_mode":
      if (!graph) {
        ctx.ui?.notify?.("Spark mode needs initialized Spark state.", "warning");
        return;
      }
      if (resolution.mode === "research")
        await enterSparkResearchMode(piApi, deps, ctx, graph, resolution.focus);
      else if (resolution.mode === "plan")
        await enterSparkPlanningMode(
          piApi,
          deps,
          ctx,
          graph,
          resolution.focus,
          resolution.planningSource,
        );
      else
        await enterSparkExecutionMode(
          piApi,
          deps,
          ctx,
          graph,
          resolution.focus,
          resolution.executeStrategy,
          resolution.workflowSelector,
        );
      return;
    case "blocked":
      ctx.ui?.notify?.(resolution.message, "warning");
      return;
    case "none":
      return;
  }
}

async function startSparkNewProject(
  piApi: SparkModeMessageApi,
  deps: SparkEntryApplicationDeps,
  ctx: SparkToolContext,
  idea: string,
  options: {
    enterPlanning?: boolean;
    planningSource?: SparkPlanningModeSource;
    materializeSparkMd?: boolean;
  } = {},
): Promise<void> {
  const existing = await loadSparkGraph(ctx.cwd, ctx);
  if (existing) {
    ctx.ui?.notify?.(
      "Spark is already initialized for this workspace; entering planning mode instead.",
      "info",
    );
    await enterSparkPlanningMode(piApi, deps, ctx, existing, idea, options.planningSource);
    return;
  }

  const language = detectCopyLanguage(idea);
  const workingTitle = titleFromIdea(idea);
  const outputLanguage: CopyLanguage = language;
  const clarification = {
    workingTitle,
    outputLanguage,
    objective: idea,
    nextAction: "analyze_then_targeted_ask",
  } satisfies SparkInitClarificationData;

  const result = await initializeSparkIdea(ctx.cwd, idea, {
    projectTitle: clarification.workingTitle,
    outputLanguage: clarification.outputLanguage,
    clarification,
    materializeSparkMd: options.materializeSparkMd,
  });

  ctx.ui?.notify?.(
    language === "zh" ? "Spark 项目已初始化" : "Spark project initialized",
    "success",
  );
  if (!options.enterPlanning) {
    dispatchSparkAgentInstruction(
      piApi,
      deps,
      ctx,
      renderSparkInitFollowUp(result),
      renderSparkInitSummary(result),
    );
  }

  await saveCurrentProjectRef(ctx.cwd, ctx, result.projectRef as ProjectRef);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  deps.ensureDagManager(ctx.cwd, ctx);

  if (options.enterPlanning) {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    if (graph) await enterSparkPlanningMode(piApi, deps, ctx, graph, idea, options.planningSource);
  }
}
