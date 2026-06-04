import { runSparkAskTool } from "./spark-ask-tool.ts";
import { isUnfinishedTaskStatus, type TaskGraph } from "spark-tasks";
import { hasNonSparkProjectFiles } from "./spark-activation.ts";
import { sparkAskUi } from "./spark-ask-ui.ts";
import {
  analyzeSparkEntryMode,
  analyzeSparkExecuteStrategy,
  type SparkCommandProjectState,
  type SparkEntryIntent,
  type SparkEntryModeChoice,
  type SparkEntryResolution,
} from "./spark-entry.ts";
import {
  sparkExecuteStrategyAsk,
  sparkExecuteStrategyFromAskDetails,
  sparkModeAsk,
  sparkModeFromAskDetails,
  sparkWorkflowSelectorAsk,
  sparkWorkflowSelectorFromAskDetails,
} from "./spark-entry-asks.ts";
import { currentSparkProject, type SparkExecuteStrategy } from "./session-state.ts";
import { listSparkWorkflowRegistry, normalizeSparkWorkflowId } from "./spark-workflow-registry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export type SparkEntryResolutionContext = Pick<
  SparkToolContext,
  "cwd" | "sessionManager" | "ui"
> & {
  setEditorText?: (text: string) => void;
};

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
      : await chooseInitializedSparkMode(ctx, graph, projectState, intent.prompt);
  if (!mode) return { action: "none" };
  if (mode === "new_project") {
    const idea = intent.prompt || (await promptSparkNewProjectIdea(ctx));
    return idea
      ? { action: "initialize_new_project", idea, enterPlanning: true, planningSource: "auto" }
      : { action: "none" };
  }
  const executeStrategy =
    mode === "execute"
      ? await resolveExecuteStrategy(ctx, graph, intent.prompt, intent)
      : undefined;
  const workflowSelector =
    executeStrategy === "workflow"
      ? await resolveWorkflowSelector(ctx, graph, intent.prompt, intent)
      : undefined;
  if (executeStrategy === "workflow" && workflowSelector === false) return { action: "none" };
  return {
    action: "enter_mode",
    mode,
    focus: intent.prompt || undefined,
    planningSource: intent.kind === "direct" && mode === "plan" ? "direct" : "auto",
    executeStrategy,
    workflowSelector: workflowSelector || undefined,
  };
}

async function resolveExecuteStrategy(
  ctx: SparkEntryResolutionContext,
  graph: TaskGraph,
  prompt: string,
  intent: SparkEntryIntent,
): Promise<SparkExecuteStrategy> {
  if (intent.kind === "direct" && intent.executeStrategy && intent.executeStrategy !== "default")
    return intent.executeStrategy;
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const analysis = analyzeSparkExecuteStrategy(graph, prompt, project);
  if (analysis.confidence === "high") return analysis.recommendation;

  const response = await runSparkAskTool(sparkExecuteStrategyAsk(analysis), {
    cwd: ctx.cwd,
    ui: sparkAskUi(ctx),
  });
  return sparkExecuteStrategyFromAskDetails(response.details) ?? "default";
}

async function resolveWorkflowSelector(
  ctx: SparkEntryResolutionContext,
  graph: TaskGraph,
  prompt: string,
  intent: SparkEntryIntent,
): Promise<string | false | undefined> {
  const requested = intent.kind === "direct" ? intent.workflowSelector : undefined;
  const listing = await listSparkWorkflowRegistry(ctx.cwd);
  const normalizedRequested = normalizeWorkflowSelector(requested);
  if (
    normalizedRequested &&
    listing.workflows.some(
      (workflow) => workflow.source + ":" + workflow.id === normalizedRequested,
    )
  ) {
    return normalizedRequested;
  }
  if (!requested && prompt.trim()) return undefined;

  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const response = await runSparkAskTool(
    sparkWorkflowSelectorAsk({
      currentProjectTitle: project?.title ?? "Spark project",
      focus: prompt,
      listing,
      requestedSelector: normalizedRequested,
    }),
    { cwd: ctx.cwd, ui: sparkAskUi(ctx) },
  );
  const selected = sparkWorkflowSelectorFromAskDetails(response.details);
  if (selected === "create_workspace") {
    ctx.setEditorText?.(renderWorkspaceWorkflowTemplate(prompt));
    ctx.ui?.notify?.(
      "Drafted a workspace workflow template. Save it under .spark/workflows/<name>.js, then run /workflow workspace:<name>.",
      "info",
    );
    return false;
  }
  return normalizeWorkflowSelector(selected) ?? false;
}

function normalizeWorkflowSelector(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  const match = /^(builtin|workspace|user):(.+)$/u.exec(selector.trim());
  if (!match) return undefined;
  try {
    return match[1] + ":" + normalizeSparkWorkflowId(match[2]);
  } catch {
    return undefined;
  }
}

function renderWorkspaceWorkflowTemplate(focus: string): string {
  const summary = focus.trim() || "Describe what this workspace workflow should accomplish";
  return [
    "export const meta = {",
    '  name: "workspace_workflow",',
    "  description: " + JSON.stringify(summary) + ",",
    "  phases: [",
    '    { id: "first", title: "First phase", model: "inherit" },',
    "  ],",
    "};",
    "",
    "export default async function workflow({ phase, agent }) {",
    '  await phase("first", async () => {',
    '    await agent("worker", "Implement the first workflow phase.");',
    "  });",
    "}",
    "",
  ].join("\n");
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
    if (intent.mode === "plan") {
      return {
        action: "blocked",
        message:
          "Spark plan mode needs an existing project or a Spark idea. Use /spark <idea> to initialize an empty project.",
      };
    }
    return {
      action: "blocked",
      message: `Spark ${intent.mode} mode needs initialized Spark state. Use /spark <idea> or /plan first.`,
    };
  }

  if (intent.kind === "direct" && (intent.mode === "execute" || intent.mode === "research")) {
    return {
      action: "blocked",
      message: `Spark ${intent.mode} mode needs initialized Spark state. Use /spark <idea> or /plan first.`,
    };
  }

  const idea = intent.prompt || (await inferExistingProjectSparkIdea(ctx));
  return idea
    ? {
        action: "initialize_existing_project",
        idea,
        planningSource: intent.kind === "direct" && intent.mode === "plan" ? "direct" : "auto",
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
