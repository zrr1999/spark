import type { ProjectRef } from "spark-core";
import type { TaskGraph } from "spark-tasks";
import {
  renderRoadmapPlanningContext,
  type RoadmapPlanningContext,
} from "../flows/roadmap-flow.ts";
import type { SparkEntryMode } from "./spark-entry.ts";
import type { SparkExecuteStrategy, SparkPlanningModeSource } from "./session-state.ts";
import {
  renderSparkWorkflowGuidance,
  type SparkSavedWorkflowDiscovery,
} from "./spark-workflow-builtins.ts";

const PLANNING_AFFECTING_CHOICES =
  "scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order";

const SPARK_ASK_PLANNING_REMINDER = `Reminder for planning mode: if a user-facing open question or decision would change ${PLANNING_AFFECTING_CHOICES}, call spark_ask with context-specific questions before spark_plan_tasks; do not leave those questions as prose or plan.openQuestions.`;

const SPARK_ASK_EXECUTION_REMINDER = `Reminder: if a missing user decision blocks execution or would change ${PLANNING_AFFECTING_CHOICES}, stop and call spark_ask instead of guessing, inventing scope, or finishing the task.`;

export function renderSparkResearchModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
): string {
  const summary = renderExistingSparkSummary(graph, selectedProjectRef);
  const focusLine = focus?.trim() ? "\n\nResearch focus: " + focus.trim() : "";
  const action = selectedProjectRef
    ? "Investigate the repository, current project, task graph, artifacts, and external references needed to answer the focus. Do not call spark_plan_tasks, spark_claim_task, or spark_finish_task in research mode. When research changes task scope or suggests new work, summarize findings and ask whether to enter /plan."
    : "Select a current project with spark_use_project before project-scoped research; use spark_status view=summary/full to inspect available projects first if needed.";
  return (
    summary +
    focusLine +
    "\n\nEnter Spark research mode. " +
    action +
    " " +
    SPARK_ASK_EXECUTION_REMINDER
  );
}

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
  strategy: SparkExecuteStrategy = "default",
  savedWorkflows: SparkSavedWorkflowDiscovery = { workflows: [], errors: [] },
  workflowSelector?: string,
): string {
  const summary = renderExistingSparkSummary(graph, selectedProjectRef);
  const focusLine = renderExecutionFocusLine(strategy, focus);
  const strategyLine = "Execution strategy: " + strategy + ".";
  const workflowSelectorLine =
    strategy === "workflow" && workflowSelector
      ? "\n\nWorkflow selector: " + workflowSelector + "."
      : "";
  const workflowGuidance =
    selectedProjectRef && strategy === "workflow"
      ? "\n\n" + renderSparkWorkflowGuidance(focus, savedWorkflows, workflowSelector)
      : "";
  const action = selectedProjectRef
    ? strategy === "goal"
      ? renderGoalAction(Boolean(focus?.trim()))
      : strategy === "workflow"
        ? renderWorkflowAction(workflowSelector)
        : "Read the current project/task plan and inspect ready tasks with spark_status. Claim at most one concrete task with spark_claim_task, execute it, verify the required evidence, then call spark_finish_task. Stop after that task finishes; do not auto-claim another task or dispatch continuous work from /execute. If the user wants autonomous completion of all ready work, suggest /goal. If the user wants a scripted fan-out/subagent process, suggest /workflow."
    : strategy === "goal"
      ? "No current project is selected for goal mode. Inspect Spark projects with spark_status, select the obvious active project with spark_use_project when the state is unambiguous, or ask with spark_ask when multiple active projects or scopes could be the intended goal. Do not claim project-bound work until a current project is selected."
      : "Select a current project with spark_use_project before claiming project-bound work; use spark_status view=summary/full to inspect available projects first if needed.";
  return (
    summary +
    focusLine +
    workflowSelectorLine +
    "\n\nEnter Spark execution mode. " +
    strategyLine +
    " " +
    action +
    " " +
    SPARK_ASK_EXECUTION_REMINDER +
    workflowGuidance
  );
}

function renderExecutionFocusLine(
  strategy: SparkExecuteStrategy,
  focus: string | undefined,
): string {
  const trimmed = focus?.trim();
  if (trimmed) {
    if (strategy === "goal") {
      return `\n\nGoal focus: ${trimmed}\nUse this as the user-provided goal to verify and pursue across ready tasks.`;
    }
    return `\n\nExecution focus: ${trimmed}\nUse this focus to filter ready tasks and pre-flight questions; do not auto-dispatch solely because a focus was provided.`;
  }
  if (strategy === "goal") {
    return "\n\nGoal focus: none provided. Derive the concrete goal from the current Spark project/task state before claiming work; ask with spark_ask if the goal, project, or scope is ambiguous.";
  }
  return "";
}

function renderGoalAction(hasExplicitGoal: boolean): string {
  const goalSource = hasExplicitGoal
    ? "Use the explicit goal focus as the target objective."
    : "Infer the target objective from the active project title, unfinished task DAG, ready tasks, task plans, required evidence, recent artifacts, and blockers.";
  return (
    "Run Spark goal mode: read the current project/task plan and inspect ready tasks with spark_status. " +
    goalSource +
    " If a single next goal is obvious, state that derived goal briefly and work toward it by claiming one ready concrete task at a time with spark_claim_task, executing it, verifying required evidence, and calling spark_finish_task. If multiple plausible goals, missing scope, conflicting priorities, no selected project, no ready path, or a user-facing decision would change the goal or execution order, stop and ask with spark_ask instead of inventing the goal. Continue to the next ready task after each successful finish until the goal is complete, no ready task remains, validation fails, or a required user decision blocks progress."
  );
}

function renderWorkflowAction(workflowSelector: string | undefined): string {
  if (workflowSelector?.startsWith("workspace:") || workflowSelector?.startsWith("user:")) {
    return "Run the selected saved scripted workflow through Spark workflow runtime boundaries: use Spark-owned workflow script metadata, route agent steps through the Spark workflow role-run adapter, preserve project attribution and evidence, and do not bypass the task DAG for durable task truth.";
  }
  return "Select or start the appropriate Spark workflow for the focus. Use workflow-owned steps and child role-runs only through Spark workflow/runtime plumbing, keep artifacts attributed to the project, and stop for spark_ask whenever workflow selection, scope, or approval is required.";
}

export function renderSparkModeVisibleMessage(
  mode: SparkEntryMode,
  projectTitle: string | undefined,
  focus: string | undefined,
  executeStrategy?: SparkExecuteStrategy,
  workflowSelector?: string,
): string {
  const title =
    mode === "research"
      ? "Spark research mode requested"
      : mode === "plan"
        ? "Spark plan mode requested"
        : "Spark execute mode requested";
  const parts = [title];
  if (projectTitle?.trim()) parts.push(`project: ${projectTitle.trim()}`);
  if (mode === "execute" && executeStrategy) parts.push("strategy: " + executeStrategy);
  if (mode === "execute" && executeStrategy === "workflow" && workflowSelector)
    parts.push("workflow: " + workflowSelector);
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
