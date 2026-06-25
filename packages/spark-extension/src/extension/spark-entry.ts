import type { ProjectRef } from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import type { SparkPlanningModeSource } from "./session-state.ts";

export type SparkCommandProjectStateKind = "empty_project" | "existing_project" | "initialized";

export interface SparkCommandProjectState {
  kind: SparkCommandProjectStateKind;
  hasCurrentProject: boolean;
  unfinishedTaskCount: number;
}

export type SparkEntryPhase = "research" | "plan" | "implement";
/** @deprecated Use SparkEntryPhase. */
export type SparkEntryMode = SparkEntryPhase;
export type SparkEntryPhaseChoice = SparkEntryPhase | "new_project";
/** @deprecated Use SparkEntryPhaseChoice. */
export type SparkEntryModeChoice = SparkEntryPhaseChoice;
export type SparkEntryConfidence = "high" | "ambiguous" | "conflicting";

export interface SparkEntryPhaseAnalysis {
  recommendation: SparkEntryPhaseChoice;
  confidence: SparkEntryConfidence;
  reasons: string[];
  prompt: string;
  currentProjectTitle: string;
  projectCount: number;
  unfinishedTaskCount: number;
  readyTaskCount: number;
  pendingTaskCount: number;
}

export type SparkEntryIntent =
  | { kind: "auto"; prompt: string }
  | {
      kind: "direct";
      phase: SparkEntryPhase;
      /** @deprecated Use phase. */
      mode?: SparkEntryPhase;
      prompt: string;
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
      action: "enter_phase";
      phase: SparkEntryPhase;
      focus?: string;
      planningSource?: SparkPlanningModeSource;
    }
  | {
      /** @deprecated Use enter_phase. */
      action: "enter_mode";
      mode: SparkEntryPhase;
      focus?: string;
      planningSource?: SparkPlanningModeSource;
    }
  | { action: "blocked"; message: string }
  | { action: "none" };

export interface SparkEntryModeAnalysis extends SparkEntryPhaseAnalysis {}

export function analyzeSparkEntryPhase(
  graph: TaskGraph,
  projectState: SparkCommandProjectState,
  prompt: string,
  selectedProject: { ref: ProjectRef; title: string } | undefined,
): SparkEntryPhaseAnalysis {
  const currentProjectTitle =
    selectedProject?.title ?? graph.projects()[0]?.title ?? "current Spark workspace";
  const tasks = graph.tasks(selectedProject?.ref);
  const pendingTaskCount = tasks.filter(
    (task) => task.status === "pending" || task.status === "ready",
  ).length;
  const readyTaskCount = graph.readyTasks(selectedProject?.ref).length;
  const normalizedPrompt = prompt.trim();
  const signalPrompt = normalizePromptForSparkSignalDetection(normalizedPrompt);
  const hasRunSignal =
    /(持续|连续|自动推进|一直做|跑完|直到完成|run\b|keep going|until done|continue until|work through)/i.test(
      signalPrompt,
    );
  const hasExecutionSignal =
    /(执行|运行|完成|继续做|认领|修复|修一下|claim|execute|run ready|dispatch|work through|finish|fix\b)/i.test(
      signalPrompt,
    );
  const hasResearchSignal =
    /(调研|研究|查一下|查看|了解|审阅|\b(?:inspect|investigate|research|read|review|audit)\b)/i.test(
      signalPrompt,
    );
  const hasPlanningSignal =
    /(计划|规划|梳理|拆分|增加.*task|新增.*task|project|plan|clarify|break down)/i.test(
      signalPrompt,
    );
  const hasErrorReportSignal =
    /(TypeError|ReferenceError|SyntaxError|RangeError|Error:|Traceback|stack trace|报错|错误|异常|bug)/i.test(
      signalPrompt,
    );
  const hasNewProjectSignal = /(新项目|新想法|另一个|new project|new idea|start over)/i.test(
    signalPrompt,
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
  if (hasExecutionSignal && pendingTaskCount === 0)
    return {
      recommendation: "plan",
      confidence: "high",
      reasons: [
        ...reasons,
        "The prompt asks for a fix or implementation, but no pending/ready project task exists, so Spark should first plan a concrete task.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasErrorReportSignal && !hasExecutionSignal && !hasPlanningSignal)
    return {
      recommendation: "research",
      confidence: "high",
      reasons: [
        ...reasons,
        "The prompt looks like an error report or stack trace, so Spark should inspect before changing tasks.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasRunSignal)
    return {
      recommendation: "implement",
      confidence: "conflicting",
      reasons: [
        ...reasons,
        "The prompt asks for continuous or until-done progress, so Spark should enter implementation and keep broader goal/workflow scope explicit.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasResearchSignal && hasExecutionSignal)
    return {
      recommendation: readyTaskCount > 0 ? "implement" : "research",
      confidence: "conflicting",
      reasons: [
        ...reasons,
        "The prompt contains both research and implementation signals; Spark should choose the safest route from current task readiness.",
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
      recommendation: readyTaskCount > 0 ? "implement" : "plan",
      confidence: "conflicting",
      reasons: [
        ...reasons,
        "The prompt contains both planning and implementation signals; Spark should choose the safest route from current task readiness.",
      ],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasResearchSignal && hasPlanningSignal)
    return {
      recommendation: "plan",
      confidence: "conflicting",
      reasons: [
        ...reasons,
        "The prompt contains both research and planning signals; the planning phase can inspect first and update tasks only when needed.",
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
      recommendation: "implement",
      confidence: "high",
      reasons: [...reasons, "The prompt asks to implement, claim, dispatch, run, or finish work."],
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
      reasons: [...reasons, "The prompt asks to plan, clarify, split, or organize tasks."],
      prompt: normalizedPrompt,
      currentProjectTitle,
      projectCount: graph.projects().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  if (hasResearchSignal)
    return {
      recommendation: "research",
      confidence: "high",
      reasons: [
        ...reasons,
        "The prompt asks to research, inspect, review, or audit without an explicit task-planning or execution request.",
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
    recommendation: readyTaskCount > 0 ? "implement" : "plan",
    confidence: "ambiguous",
    reasons: [
      ...reasons,
      normalizedPrompt
        ? "The prompt does not clearly choose planning or execution; Spark should infer the next phase from task readiness."
        : "No explicit phase prompt was provided in an initialized workspace; Spark should infer the next phase from task readiness.",
    ],
    prompt: normalizedPrompt,
    currentProjectTitle,
    projectCount: graph.projects().length,
    unfinishedTaskCount: projectState.unfinishedTaskCount,
    readyTaskCount,
    pendingTaskCount,
  };
}

/** @deprecated Use analyzeSparkEntryPhase. */
export const analyzeSparkEntryMode = analyzeSparkEntryPhase;

function normalizePromptForSparkSignalDetection(prompt: string): string {
  return prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !/^at\s/u.test(line))
    .join("\n");
}
