import type { SparkAskToolParams } from "./spark-ask-tool.ts";
import type { SparkExecuteStrategy } from "./session-state.ts";
import type { SparkWorkflowRegistryListing } from "./spark-workflow-registry.ts";
import type {
  SparkEntryModeAnalysis,
  SparkEntryModeChoice,
  SparkExecuteStrategyAnalysis,
} from "./spark-entry.ts";
import { truncateInline } from "./tool-rendering.ts";

export function sparkModeAsk(analysis: SparkEntryModeAnalysis): SparkAskToolParams {
  const title = analysis.currentProjectTitle;
  const reasonLines = analysis.reasons.map((reason) => `- ${reason}`);
  return {
    mode: "decision",
    flow: "spark-command-mode",
    title: `Choose the next Spark mode for “${truncateInline(title, 80)}”`,
    context: [
      `Spark could not choose a high-confidence automatic route for this /spark turn because the signal is ${analysis.confidence}.`,
      `Current workspace context: ${analysis.projectCount} project(s), ${analysis.unfinishedTaskCount} unfinished task(s) in the current project, ${analysis.readyTaskCount} execution-ready task(s), ${analysis.pendingTaskCount} pending/ready task(s).`,
      ...reasonLines,
    ].join("\n"),
    questions: [
      {
        id: "mode",
        prompt: `For “${truncateInline(title, 80)}”, should this turn research, plan tasks, or execute work? Recommended: ${analysis.recommendation}.`,
        type: "single",
        required: true,
        options: [
          {
            id: "research",
            label: `Research “${truncateInline(title, 32)}”`,
            description: `Use research mode now: inspect code, docs, artifacts, and external context without changing tasks, then summarize findings and ask whether to enter plan mode when new task work is needed.`,
          },
          {
            id: "plan",
            label: `Plan “${truncateInline(title, 32)}”`,
            description: `Use planning mode now: inspect the ${analysis.unfinishedTaskCount} unfinished task(s), ask context-specific clarification or decision questions when they change the task plan, and add or refine concrete plan-bound tasks before execution.`,
          },
          {
            id: "execute",
            label: `Execute “${truncateInline(title, 32)}”`,
            description: `Use execution mode now: inspect the ${analysis.readyTaskCount} execution-ready task(s), then claim and complete at most one concrete task without broad replanning or continuous background progress.`,
          },
          {
            id: "new_project",
            label: `Start a different Spark idea`,
            description: `Do not continue “${truncateInline(title, 80)}”; ask for a distinct idea and initialize it as separate Spark project context.`,
          },
        ],
      },
    ],
  };
}

export function sparkModeFromAskDetails(
  details: Record<string, unknown>,
): SparkEntryModeChoice | undefined {
  const modeAnswer = (details.answers as { mode?: { values?: unknown[] } } | undefined)?.mode;
  const value = modeAnswer?.values?.[0];
  return value === "new_project" || value === "research" || value === "plan" || value === "execute"
    ? value
    : undefined;
}

export function sparkExecuteStrategyAsk(
  analysis: SparkExecuteStrategyAnalysis,
): SparkAskToolParams {
  const title = analysis.currentProjectTitle;
  const reasonLines = analysis.reasons.map((reason) => "- " + reason);
  return {
    mode: "decision",
    flow: "spark-execute-strategy",
    title: "Choose execute strategy for “" + truncateInline(title, 80) + "”",
    context: [
      "/execute defaults to one bounded execution step. The prompt appears to request a broader execute strategy, so Spark needs an explicit decision before changing scope.",
      "Current execution context: " +
        analysis.readyTaskCount +
        " execution-ready task(s), " +
        analysis.pendingTaskCount +
        " pending/ready task(s).",
      ...reasonLines,
    ].join("\n"),
    questions: [
      {
        id: "executeStrategy",
        prompt:
          "For “" +
          truncateInline(title, 80) +
          "”, which execute strategy should this /execute turn use? Recommended: " +
          analysis.recommendation +
          ".",
        type: "single",
        required: true,
        options: [
          {
            id: "default",
            label: "Default “" + truncateInline(title, 32) + "”",
            description:
              "Use default execution now: claim and finish at most one concrete ready task, then stop and report the next suggested step.",
          },
          {
            id: "goal",
            label: "Goal “" + truncateInline(title, 32) + "”",
            description:
              "Use goal execution now: continue autonomous, verified progress across ready tasks until complete or blocked by a required decision.",
          },
          {
            id: "workflow",
            label: "Workflow “" + truncateInline(title, 32) + "”",
            description:
              "Use workflow execution now: select or start a Spark workflow such as deep research or adversarial review instead of a single task step.",
          },
        ],
      },
    ],
  };
}
export function sparkExecuteStrategyFromAskDetails(
  details: Record<string, unknown>,
): SparkExecuteStrategy | undefined {
  const answer = (details.answers as { executeStrategy?: { values?: unknown[] } } | undefined)
    ?.executeStrategy;
  const value = answer?.values?.[0];
  return value === "default" || value === "goal" || value === "workflow" ? value : undefined;
}

export interface SparkWorkflowSelectorAskInput {
  currentProjectTitle: string;
  focus?: string;
  listing: SparkWorkflowRegistryListing;
  requestedSelector?: string;
}

export function sparkWorkflowSelectorAsk(input: SparkWorkflowSelectorAskInput): SparkAskToolParams {
  const title = truncateInline(input.currentProjectTitle, 80);
  const focus = input.focus?.trim();
  const reason = input.requestedSelector
    ? "The requested workflow selector “" + input.requestedSelector + "” was not found."
    : "No workflow selector was provided.";
  const errors = input.listing.errors.map(
    (error) =>
      "- " + error.source + " workflow metadata error in " + error.path + ": " + error.error,
  );
  return {
    mode: "decision",
    flow: "spark-workflow-selector",
    title: "Choose workflow for “" + title + "”",
    context: [
      "/workflow runs a workspace or user Spark workflow. Spark needs an explicit selector before starting workflow execution.",
      reason,
      focus ? "Workflow focus: " + focus : undefined,
      ...errors,
    ]
      .filter(Boolean)
      .join("\n"),
    questions: [
      {
        id: "workflowSelector",
        prompt: "Which workflow should Spark use for “" + title + "”?",
        type: "single",
        required: true,
        options: [
          ...input.listing.workflows.map((workflow) => ({
            id: workflow.source + ":" + workflow.id,
            label: workflow.source + ":" + workflow.id + " — " + truncateInline(workflow.title, 40),
            description:
              "Use this " +
              workflow.source +
              " workflow now: " +
              workflow.description +
              (workflow.phases.length ? " Phases: " + workflow.phases.join(", ") + "." : ""),
          })),
          {
            id: "create_workspace",
            label: "Create workspace workflow",
            description:
              "Do not execute a workflow now. Start a new .spark/workflows/*.js workspace workflow draft for this project instead.",
          },
        ],
      },
    ],
  };
}

export function sparkWorkflowSelectorFromAskDetails(
  details: Record<string, unknown>,
): string | undefined {
  const answer = (details.answers as { workflowSelector?: { values?: unknown[] } } | undefined)
    ?.workflowSelector;
  const value = answer?.values?.[0];
  return typeof value === "string" ? value : undefined;
}
