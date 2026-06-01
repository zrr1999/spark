import type { SparkAskToolParams } from "spark-ask";
import type { ProjectRef } from "spark-core";
import type { TaskGraph } from "spark-tasks";
import type {
  SparkCommandProjectState,
  SparkEntryModeAnalysis,
  SparkEntryModeChoice,
} from "./spark-entry.ts";
import type { SparkRunStrategy } from "./session-state.ts";
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
        prompt: `For “${truncateInline(title, 80)}”, should this turn organize tasks, execute one task, or run continuously? Recommended: ${analysis.recommendation}.`,
        type: "single",
        required: true,
        options: [
          {
            id: "planning",
            label: `Plan “${truncateInline(title, 32)}”`,
            description: `Use planning mode now: inspect the ${analysis.unfinishedTaskCount} unfinished task(s), ask context-specific clarification or decision questions when they change the task plan, and add or refine concrete plan-bound tasks before execution.`,
          },
          {
            id: "execution",
            label: `Execute “${truncateInline(title, 32)}”`,
            description: `Use execution mode now: inspect the ${analysis.readyTaskCount} execution-ready task(s), then claim and complete at most one concrete task without broad replanning or continuous background progress.`,
          },
          {
            id: "run",
            label: `Run “${truncateInline(title, 32)}”`,
            description: `Use sequential run mode now: continuously claim and execute ready tasks one at a time in this session (foreground loop) until done, blocked, or interrupted. Use /run-parallel for background parallel execution.`,
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
  return value === "new_project" || value === "planning" || value === "execution" || value === "run"
    ? value
    : undefined;
}

export function sparkRunStrategyAsk(
  graph: TaskGraph,
  projectState: SparkCommandProjectState,
  prompt: string,
  selectedProject: { ref: ProjectRef; title: string } | undefined,
): SparkAskToolParams {
  const title = selectedProject?.title ?? graph.projects()[0]?.title ?? "current Spark workspace";
  const readyTaskCount = graph.readyTasks(selectedProject?.ref).length;
  const promptLine = prompt.trim() ? `\nPrompt: ${prompt.trim()}` : "";
  return {
    mode: "decision",
    flow: "spark-run-strategy",
    title: `Choose run strategy for “${truncateInline(title, 80)}”`,
    context: [
      `Spark run mode can either execute ready tasks one at a time or keep the existing parallel frontier scheduler.`,
      `Current workspace context: ${projectState.unfinishedTaskCount} unfinished task(s), ${readyTaskCount} execution-ready task(s).${promptLine}`,
    ].join("\n"),
    questions: [
      {
        id: "strategy",
        prompt: `How should Spark continuously run “${truncateInline(title, 80)}”?`,
        type: "single",
        required: true,
        options: [
          {
            id: "sequential",
            label: "Sequential (foreground)",
            description:
              "Continuously execute ready tasks one at a time in this session (foreground loop). No background processes; the current session claims and finishes each task before moving to the next.",
          },
          {
            id: "parallel",
            label: "Parallel (background)",
            description:
              "Use the background parallel ready-frontier scheduler (default maxConcurrency=4), continuing until done or blocked. The current session observes; actual task work happens in spawned child role-runs.",
          },
        ],
      },
    ],
  };
}

export function sparkRunStrategyFromAskDetails(
  details: Record<string, unknown>,
): SparkRunStrategy | undefined {
  const answer = (details.answers as { strategy?: { values?: unknown[] } } | undefined)?.strategy;
  const value = answer?.values?.[0];
  return value === "sequential" || value === "parallel" ? value : undefined;
}
