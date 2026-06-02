import type { ProjectRef } from "spark-core";
import type { TaskGraph } from "spark-tasks";
import type { SparkExecuteStrategy, SparkPlanningModeSource } from "./session-state.ts";

export type SparkCommandProjectStateKind = "empty_project" | "existing_project" | "initialized";

export interface SparkCommandProjectState {
  kind: SparkCommandProjectStateKind;
  hasCurrentProject: boolean;
  unfinishedTaskCount: number;
}

export type SparkEntryMode = "research" | "plan" | "execute";
export type SparkEntryModeChoice = SparkEntryMode | "new_project";
export type SparkEntryConfidence = "high" | "ambiguous" | "conflicting";

export interface SparkEntryModeAnalysis {
  recommendation: SparkEntryModeChoice;
  confidence: SparkEntryConfidence;
  reasons: string[];
  prompt: string;
  currentProjectTitle: string;
  projectCount: number;
  unfinishedTaskCount: number;
  readyTaskCount: number;
  pendingTaskCount: number;
}

export interface SparkExecuteStrategyAnalysis {
  recommendation: SparkExecuteStrategy;
  confidence: SparkEntryConfidence;
  reasons: string[];
  prompt: string;
  currentProjectTitle: string;
  readyTaskCount: number;
  pendingTaskCount: number;
}

export type SparkEntryIntent =
  | { kind: "auto"; prompt: string }
  | {
      kind: "direct";
      mode: SparkEntryMode;
      prompt: string;
      executeStrategy?: SparkExecuteStrategy;
      workflowSelector?: string;
    };

export type SparkEntryResolution =
  | {
      action: "initialize_new_project";
      idea: string;
      enterPlanning: boolean;
      planningSource?: SparkPlanningModeSource;
    }
  | { action: "initialize_existing_project"; idea: string; planningSource: SparkPlanningModeSource }
  | {
      action: "enter_mode";
      mode: SparkEntryMode;
      focus?: string;
      planningSource?: SparkPlanningModeSource;
      executeStrategy?: SparkExecuteStrategy;
      workflowSelector?: string;
    }
  | { action: "blocked"; message: string }
  | { action: "none" };

export function analyzeSparkEntryMode(
  graph: TaskGraph,
  projectState: SparkCommandProjectState,
  prompt: string,
  selectedProject: { ref: ProjectRef; title: string } | undefined,
): SparkEntryModeAnalysis {
  const currentProjectTitle =
    selectedProject?.title ?? graph.projects()[0]?.title ?? "current Spark workspace";
  const tasks = graph.tasks(selectedProject?.ref);
  const pendingTaskCount = tasks.filter(
    (task) => task.status === "pending" || task.status === "ready",
  ).length;
  const readyTaskCount = graph.readyTasks(selectedProject?.ref).length;
  const normalizedPrompt = prompt.trim();
  const hasRunSignal =
    /(持续|连续|自动推进|一直做|跑完|直到完成|run\b|keep going|until done|continue until|work through)/i.test(
      normalizedPrompt,
    );
  const hasExecutionSignal =
    /(执行|运行|完成|继续做|认领|claim|execute|run ready|dispatch|work through|finish)/i.test(
      normalizedPrompt,
    );
  const hasPlanningSignal =
    /(计划|规划|调研|梳理|拆分|增加.*task|新增.*task|project|plan|research|clarify|break down)/i.test(
      normalizedPrompt,
    );
  const hasNewProjectSignal = /(新项目|新想法|另一个|new project|new idea|start over)/i.test(
    normalizedPrompt,
  );
  const reasons = [
    `Current project “${currentProjectTitle}” has ${projectState.unfinishedTaskCount} unfinished task(s).`,
    `Ready frontier has ${readyTaskCount} execution-ready task(s) out of ${pendingTaskCount} pending/ready task(s).`,
  ];
  if (normalizedPrompt) reasons.push(`Prompt: ${normalizedPrompt}`);
  if (hasNewProjectSignal && !hasPlanningSignal && !hasExecutionSignal && !hasRunSignal)
    return {
      recommendation: "new_project",
      confidence: "high",
      reasons: [...reasons, "The prompt asks to start a distinct Spark idea."],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasRunSignal)
    return {
      recommendation: "execute",
      confidence: "conflicting",
      reasons: [
        ...reasons,
        "The prompt asks for continuous or until-done progress, so Spark should ask before choosing goal or workflow execution.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasPlanningSignal && hasExecutionSignal)
    return {
      recommendation: readyTaskCount > 0 ? "execute" : "plan",
      confidence: "conflicting",
      reasons: [
        ...reasons,
        "The prompt contains both planning and execution signals, so the mode needs confirmation.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasExecutionSignal)
    return {
      recommendation: "execute",
      confidence: "high",
      reasons: [...reasons, "The prompt asks to execute, claim, dispatch, run, or finish work."],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasPlanningSignal)
    return {
      recommendation: "plan",
      confidence: "high",
      reasons: [
        ...reasons,
        "The prompt asks to plan, research, clarify, split, or organize tasks.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (!projectState.hasCurrentProject || projectState.unfinishedTaskCount === 0)
    return {
      recommendation: "plan",
      confidence: "high",
      reasons: [...reasons, "No active unfinished current project work needs execution."],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  return {
    recommendation: readyTaskCount > 0 ? "execute" : "plan",
    confidence: "ambiguous",
    reasons: [
      ...reasons,
      normalizedPrompt
        ? "The prompt does not clearly choose planning or execution."
        : "Bare /spark in an initialized workspace should confirm the next mode.",
    ],
    prompt: normalizedPrompt,
    currentProjectTitle,
    projectCount: graph.projects().length,
    unfinishedTaskCount: projectState.unfinishedTaskCount,
    readyTaskCount,
    pendingTaskCount,
  };
}

export function analyzeSparkExecuteStrategy(
  graph: TaskGraph,
  prompt: string,
  selectedProject: { ref: ProjectRef; title: string } | undefined,
): SparkExecuteStrategyAnalysis {
  const currentProjectTitle =
    selectedProject?.title ?? graph.projects()[0]?.title ?? "current Spark workspace";
  const tasks = graph.tasks(selectedProject?.ref);
  const pendingTaskCount = tasks.filter(
    (task) => task.status === "pending" || task.status === "ready",
  ).length;
  const readyTaskCount = graph.readyTasks(selectedProject?.ref).length;
  const normalizedPrompt = prompt.trim();
  const hasWorkflowSignal =
    /(workflow|工作流|deep research|深度调研|adversarial review|对抗审查|review workflow|pipeline|phase)/i.test(
      normalizedPrompt,
    );
  const hasGoalSignal =
    /(goal|目标模式|持续|连续|自动推进|一直做|跑完|直到完成|keep going|until done|continue until|work through|finish all|run through|autonomous)/i.test(
      normalizedPrompt,
    );
  const reasons = [
    "Current project “" +
      currentProjectTitle +
      "” has " +
      readyTaskCount +
      " execution-ready task(s).",
    "Ready frontier has " +
      readyTaskCount +
      " execution-ready task(s) out of " +
      pendingTaskCount +
      " pending/ready task(s).",
  ];
  if (normalizedPrompt) reasons.push("Prompt: " + normalizedPrompt);
  if (hasWorkflowSignal && hasGoalSignal)
    return {
      recommendation: "workflow",
      confidence: "conflicting",
      reasons: [
        ...reasons,
        "The prompt asks for workflow-style execution and autonomous/until-done progress, so Spark must ask before broadening beyond default execution.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasWorkflowSignal)
    return {
      recommendation: "workflow",
      confidence: "conflicting",
      reasons: [
        ...reasons,
        "The prompt appears to request a workflow strategy, so Spark must ask before entering workflow execution from /execute.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasGoalSignal)
    return {
      recommendation: "goal",
      confidence: "conflicting",
      reasons: [
        ...reasons,
        "The prompt appears to request autonomous or until-done progress, so Spark must ask before entering goal execution from /execute.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      readyTaskCount,
      pendingTaskCount,
    };
  return {
    recommendation: "default",
    confidence: "high",
    reasons: [
      ...reasons,
      "No autonomous goal or workflow signal was detected, so default execution is safest.",
    ],
    prompt: normalizedPrompt,
    currentProjectTitle,
    readyTaskCount,
    pendingTaskCount,
  };
}
