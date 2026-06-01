import type { ProjectRef } from "spark-core";
import type { TaskGraph } from "spark-tasks";
import {
  renderRoadmapPlanningContext,
  type RoadmapPlanningContext,
} from "../flows/roadmap-flow.ts";
import type { SparkEntryMode } from "./spark-entry.ts";
import type { SparkPlanningModeSource, SparkRunStrategy } from "./session-state.ts";

const PLANNING_AFFECTING_CHOICES =
  "scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order";

const SPARK_ASK_PLANNING_REMINDER = `Reminder for planning mode: if a user-facing open question or decision would change ${PLANNING_AFFECTING_CHOICES}, call spark_ask with context-specific questions before spark_plan_tasks; do not leave those questions as prose or plan.openQuestions.`;

const SPARK_ASK_EXECUTION_REMINDER = `Reminder: if a missing user decision blocks execution or would change ${PLANNING_AFFECTING_CHOICES}, stop and call spark_ask instead of guessing, inventing scope, or finishing the task.`;

export function renderSparkPlanningModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  roadmapContext: RoadmapPlanningContext | undefined,
  source: SparkPlanningModeSource,
): string {
  const summary = renderExistingSparkSummary(graph, selectedProjectRef);
  const focusLine = focus?.trim() ? `\n\nPlanning focus: ${focus.trim()}` : "";
  const roadmapLine = renderRoadmapPlanningContext(roadmapContext);
  if (source === "direct") {
    return `${summary}${focusLine}${roadmapLine}\n\nEnter Spark planning mode from /plan. Treat this as a high-priority planning prompt, not as a permission gate and not as an answer-only research turn. First do a short context scan, then brainstorm the plan shape and keep clarifying until every material planning-affecting choice is either clear from inspected context or answered through context-specific spark_ask questions, including target project selection, whether the user wants design options only or durable task planning, desired outcome, constraints, priority, scope, success evidence, architecture, dependency choices, and implementation order. Do not call spark_plan_tasks while those choices remain unresolved. If you are about to list user-facing open questions or decision points that would change the task plan, do not leave them as prose: group them into spark_ask questions first. Keep asks dynamic and grounded in the inspected context; do not use canned intake templates or ask questions whose answers would not change the task plan. ${SPARK_ASK_PLANNING_REMINDER} Once planning-affecting uncertainty is resolved, call spark_plan_tasks directly to create or refine concrete plan-bound tasks with dependencies and evidence expectations. Refine plans by calling spark_plan_tasks again with concrete updates rather than using a separate dry-run/apply phase. Be strict: never create standalone “design”, “规划”, or “planning” tasks; discuss design/architecture with the user in this conversation first, then embed the chosen design, rationale, constraints, alternatives, and success evidence inside each concrete task.plan. Do not execute tasks yet unless the user explicitly asks to switch to execution.`;
  }
  return `${summary}${focusLine}${roadmapLine}\n\nEnter Spark planning mode. Research and clarify the project context first, then choose the lightest appropriate action from the actual request: answer directly for a simple research/read-and-comment turn, call spark_rename_project when context shows the bootstrap title is only an action/request or a better project label is available, and call spark_plan_tasks only when there are concrete plan-bound tasks (executable/review/validation work) to organize; never create standalone design/planning tasks, and instead put confirmed design inside task.plan. Before generating or changing a durable plan, brainstorm the plan shape and keep clarifying through context-specific spark_ask questions until every material task-scope, dependency, priority, success-criteria, evidence, architecture, dependency-choice, or implementation-order uncertainty is resolved. Do not use generic intake templates. ${SPARK_ASK_PLANNING_REMINDER} spark_plan_tasks writes directly after readiness checks pass; refine plans by calling it again with concrete updates rather than using a separate dry-run/apply phase. Do not execute tasks yet unless the user explicitly asks to switch to execution.`;
}

export function renderSparkExecutionModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
): string {
  const summary = renderExistingSparkSummary(graph, selectedProjectRef);
  const focusLine = focus?.trim()
    ? `\n\nExecution focus: ${focus.trim()}\nUse this focus to filter ready tasks and pre-flight questions; do not auto-dispatch solely because a focus was provided.`
    : "";
  const action = selectedProjectRef
    ? "Read the current project/task plan and inspect ready tasks with spark_status. Claim at most one concrete task with spark_claim_task, execute it, verify the required evidence, then call spark_finish_task. Stop after that task finishes; do not auto-claim another task or dispatch a continuous DAG run from /execute. If the user wants continuous foreground progress through multiple tasks, suggest /run-sequential (or /run for inferred strategy). If the user wants background parallel progress, suggest /run-parallel."
    : "Select a current project with spark_use_project before claiming project-bound work; use spark_status view=summary/full to inspect available projects first if needed.";
  return `${summary}${focusLine}\n\nEnter Spark execution mode. ${action} ${SPARK_ASK_EXECUTION_REMINDER}`;
}

export function renderSparkRunSequentialModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
): string {
  const summary = renderExistingSparkSummary(graph, selectedProjectRef);
  const focusLine = focus?.trim()
    ? `\n\nRun focus: ${focus.trim()}\nUse this focus to filter and prioritize which ready tasks to execute next.`
    : "";
  const action = selectedProjectRef
    ? "Continuously claim and execute ready tasks in the current project one at a time, in this same session (foreground loop). For each iteration: inspect ready tasks with spark_status, claim the next ready task with spark_claim_task, execute it fully, verify the required evidence, then call spark_finish_task. After finishing a task, immediately move to the next ready task without waiting for an extra user prompt. Stop the loop and report clearly when any of the following happens: no ready tasks remain, a task becomes blocked, a context-specific spark_ask requires a user decision, validation fails, or the user interrupts. Do not call spark_run_ready_tasks and do not start a background DAG run; execute everything in this session. /run-sequential is a foreground loop, not a background process."
    : "Select a current project with spark_use_project before running; use spark_status view=summary/full to inspect available projects first if needed.";
  return `${summary}${focusLine}\n\nEnter Spark sequential run mode (foreground loop in this session). ${action} ${SPARK_ASK_EXECUTION_REMINDER}`;
}

export function renderSparkModeVisibleMessage(
  mode: SparkEntryMode,
  projectTitle: string | undefined,
  focus: string | undefined,
  runStrategy?: SparkRunStrategy,
): string {
  const title =
    mode === "planning"
      ? "Spark planning mode requested"
      : mode === "execution"
        ? "Spark execution mode requested"
        : runStrategy === "sequential"
          ? "Spark run mode requested (sequential, foreground loop)"
          : runStrategy === "parallel"
            ? "Spark run mode requested (parallel, background)"
            : "Spark run mode requested";
  const parts = [title];
  if (projectTitle?.trim()) parts.push(`project: ${projectTitle.trim()}`);
  if (mode === "run" && runStrategy) parts.push(`strategy: ${runStrategy}`);
  if (focus?.trim()) parts.push(`focus: ${focus.trim()}`);
  return parts.join(" · ");
}

function renderExistingSparkSummary(graph: TaskGraph, selectedProjectRef?: ProjectRef): string {
  const projects = graph.projects();
  const project = selectedProjectRef
    ? projects.find((candidate) => candidate.ref === selectedProjectRef)
    : undefined;
  if (!project) {
    const activeCount = projects.filter((candidate) => candidate.status !== "done").length;
    return [
      "Spark is already initialized; existing state was not overwritten.",
      "- Spark available: no project selected for this session.",
      `- Projects: ${projects.length} total / ${activeCount} active`,
      "- Use spark_use_project to select or create a current project before planning or claiming project-bound tasks.",
    ].join("\n");
  }
  return [
    "Spark is already initialized; existing state was not overwritten.",
    `- Current project for this session: ${project.title} (${project.ref})`,
    `- Tasks: ${graph.tasks(project.ref).length}`,
  ].join("\n");
}
