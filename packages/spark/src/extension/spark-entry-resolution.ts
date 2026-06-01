import { runSparkAskTool } from "spark-ask";
import { isUnfinishedTaskStatus, type TaskGraph } from "spark-tasks";
import { hasNonSparkProjectFiles } from "./spark-activation.ts";
import { sparkAskUi } from "./spark-ask-ui.ts";
import {
  analyzeSparkEntryMode,
  inferSparkRunStrategy,
  type SparkCommandProjectState,
  type SparkEntryIntent,
  type SparkEntryModeChoice,
  type SparkEntryResolution,
} from "./spark-entry.ts";
import {
  sparkModeAsk,
  sparkModeFromAskDetails,
  sparkRunStrategyAsk,
  sparkRunStrategyFromAskDetails,
} from "./spark-entry-asks.ts";
import { currentSparkProject, type SparkRunStrategy } from "./session-state.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export type SparkEntryResolutionContext = Pick<SparkToolContext, "cwd" | "sessionManager" | "ui">;

export async function detectSparkProjectState(
  cwd: string,
  graph: TaskGraph | null,
  ctx: SparkEntryResolutionContext,
): Promise<SparkCommandProjectState> {
  if (graph) {
    const project = await currentSparkProject(cwd, ctx, graph);
    return {
      kind: "initialized",
      hasCurrentProject: Boolean(project),
      unfinishedTaskCount: graph
        .tasks(project?.ref)
        .filter((task) => isUnfinishedTaskStatus(task.status)).length,
    };
  }
  return {
    kind: (await hasNonSparkProjectFiles(cwd)) ? "existing_project" : "empty_project",
    hasCurrentProject: false,
    unfinishedTaskCount: 0,
  };
}

export async function resolveSparkEntry(
  ctx: SparkEntryResolutionContext,
  intent: SparkEntryIntent,
  graph: TaskGraph | null,
  projectState: SparkCommandProjectState,
): Promise<SparkEntryResolution> {
  if (!graph) return resolveSparkEntryWithoutGraph(ctx, intent, projectState);

  const mode =
    intent.kind === "direct"
      ? intent.mode
      : intent.kind === "run_auto"
        ? "run"
        : await chooseInitializedSparkMode(ctx, graph, projectState, intent.prompt);
  if (!mode) return { action: "none" };
  if (mode === "new_project") {
    const idea = intent.prompt || (await promptSparkNewProjectIdea(ctx));
    return idea
      ? { action: "initialize_new_project", idea, enterPlanning: true, planningSource: "auto" }
      : { action: "none" };
  }
  const runStrategy =
    mode === "run"
      ? intent.kind === "direct" && intent.runStrategy
        ? intent.runStrategy
        : await chooseSparkRunStrategy(ctx, graph, projectState, intent.prompt)
      : undefined;
  if (mode === "run" && !runStrategy) return { action: "none" };
  return {
    action: "enter_mode",
    mode,
    focus: intent.prompt || undefined,
    planningSource: intent.kind === "direct" && mode === "planning" ? "direct" : "auto",
    runStrategy,
  };
}

async function resolveSparkEntryWithoutGraph(
  ctx: SparkEntryResolutionContext,
  intent: SparkEntryIntent,
  projectState: SparkCommandProjectState,
): Promise<SparkEntryResolution> {
  if (projectState.kind === "empty_project") {
    if (intent.kind === "auto") {
      const idea = intent.prompt || (await promptSparkNewProjectIdea(ctx));
      return idea
        ? { action: "initialize_new_project", idea, enterPlanning: false, planningSource: "auto" }
        : { action: "none" };
    }
    const modeLabel = intent.kind === "direct" ? intent.mode : "run";
    return {
      action: "blocked",
      message:
        modeLabel === "planning"
          ? "Spark planning mode needs an existing project or a Spark idea. Use /spark <idea> to initialize an empty project."
          : `Spark ${modeLabel} mode needs initialized Spark state. Use /spark <idea> or /plan first.`,
    };
  }

  if (
    intent.kind === "run_auto" ||
    (intent.kind === "direct" && (intent.mode === "execution" || intent.mode === "run"))
  ) {
    const modeLabel = intent.kind === "direct" ? intent.mode : "run";
    return {
      action: "blocked",
      message: `Spark ${modeLabel} mode needs initialized Spark state. Use /spark <idea> or /plan first.`,
    };
  }

  const idea = intent.prompt || (await inferExistingProjectSparkIdea(ctx));
  return idea
    ? {
        action: "initialize_existing_project",
        idea,
        planningSource: intent.kind === "direct" && intent.mode === "planning" ? "direct" : "auto",
      }
    : { action: "none" };
}

async function chooseInitializedSparkMode(
  ctx: SparkEntryResolutionContext,
  graph: TaskGraph,
  projectState: SparkCommandProjectState,
  prompt: string,
): Promise<SparkEntryModeChoice | undefined> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const analysis = analyzeSparkEntryMode(graph, projectState, prompt, project);
  if (analysis.confidence === "high") return analysis.recommendation;

  const response = await runSparkAskTool(sparkModeAsk(analysis), {
    cwd: ctx.cwd,
    ui: sparkAskUi(ctx),
  });
  return sparkModeFromAskDetails(response.details);
}

async function chooseSparkRunStrategy(
  ctx: SparkEntryResolutionContext,
  graph: TaskGraph,
  projectState: SparkCommandProjectState,
  prompt: string,
): Promise<SparkRunStrategy | undefined> {
  const inferred = inferSparkRunStrategy(prompt);
  if (inferred) return inferred;

  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const response = await runSparkAskTool(
    sparkRunStrategyAsk(graph, projectState, prompt, project),
    {
      cwd: ctx.cwd,
      ui: sparkAskUi(ctx),
    },
  );
  return sparkRunStrategyFromAskDetails(response.details);
}

async function inferExistingProjectSparkIdea(
  ctx: SparkEntryResolutionContext,
): Promise<string | undefined> {
  const idea = await ctx.ui?.input?.("What should Spark plan for this existing project?", "");
  const trimmed = idea?.trim();
  if (trimmed) return trimmed;
  ctx.ui?.notify?.(
    "Spark planning needs a concrete focus for this existing project. You can also run /spark <focus> or /plan <focus>.",
    "warning",
  );
  return undefined;
}

async function promptSparkNewProjectIdea(
  ctx: SparkEntryResolutionContext,
): Promise<string | undefined> {
  const idea = await ctx.ui?.input?.(
    "What new Spark project or idea should this workspace start?",
    "",
  );
  const trimmed = idea?.trim();
  if (trimmed) return trimmed;
  ctx.ui?.notify?.(
    "Spark new-project mode needs an idea. You can also run /spark <idea>.",
    "warning",
  );
  return undefined;
}
