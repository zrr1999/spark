import type { ProjectRef } from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import type { SparkEntryMode } from "./spark-entry.ts";
import {
  ASK_BEFORE_GUESSING,
  PARALLEL_EXECUTION_WORKFLOW_STRATEGY,
  WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
  renderModePrompt,
  renderSparkPlanningModePrompt,
  renderSparkResearchModePrompt,
} from "./mode/index.ts";
import {
  renderSparkWorkflowGuidance,
  type SparkSavedWorkflowDiscovery,
} from "./spark-workflow-builtins.ts";

export function renderSparkWorkflowDriverPrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  savedWorkflows: SparkSavedWorkflowDiscovery = { workflows: [], errors: [] },
  workflowSelector?: string,
): string {
  const workflowGuidance = selectedProjectRef
    ? renderSparkWorkflowGuidance(focus, savedWorkflows, workflowSelector)
    : undefined;
  const requirements = selectedProjectRef
    ? [
        ...(workflowSelector && workflowSelector !== "agent:auto"
          ? [`Workflow selector: ${workflowSelector}.`]
          : []),
        renderWorkflowDriverAction(workflowSelector),
        "Workflow is a driver/tool boundary, not an implement-mode strategy. Select the governing mode per step, and run workflow-owned steps only through Spark workflow/runtime plumbing.",
        "Keep artifacts attributed to the current project and stop/report when workflow selection, scope, trust, or approval is required.",
        ...(workflowGuidance ? [workflowGuidance] : []),
      ]
    : [
        'No current project is selected for workflow driver execution. Inspect projects with task_read({ action: "status" }) or task_read({ action: "project_list" }) and select the intended project before running workflow-owned work.',
        ASK_BEFORE_GUESSING,
      ];
  return renderModePrompt(graph, selectedProjectRef, focus, "Workflow driver", requirements);
}

export function renderSparkGoalDriverModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  mode: SparkEntryMode,
): string {
  const modePrompt =
    mode === "research"
      ? renderSparkResearchModePrompt(graph, selectedProjectRef, focus)
      : mode === "plan"
        ? renderSparkPlanningModePrompt(graph, selectedProjectRef, focus, "auto")
        : renderSparkGoalModePrompt(graph, selectedProjectRef, focus);
  return [modePrompt, renderGoalDriverGuidance(focus)].join("\n\n");
}

function renderGoalDriverGuidance(focus: string | undefined): string {
  const goal = focus?.trim() || "the active Spark goal";
  return [
    "## Goal driver guidance",
    `- Active goal objective: ${goal}`,
    "- Goal is the foreground driver for this turn; it supplies objective, idle-loop cadence, and reviewer-gated completion flow: the main session requests completion, the reviewer audits, and Spark applies the approved state transition. The selected mode supplies concrete tool policy.",
    "- If a blocker appears, resolve the blocker by doing or planning the blocking work; do not pause, weaken, or complete the goal autonomously.",
  ].join("\n");
}

export function renderSparkGoalModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
): string {
  const requirements = selectedProjectRef
    ? [
        renderGoalAction(Boolean(focus?.trim())),
        WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
        PARALLEL_EXECUTION_WORKFLOW_STRATEGY,
        "Goal driver is non-interactive: do not call ask_user/ask_flow. Canonical ask may be used only when the host supplies reviewer auto-answer. If a blocker appears, resolve the blocker by doing or planning the blocking work; do not pause or weaken the goal autonomously.",
        SPARK_GOAL_DECISION_RULE,
      ]
    : [
        'No current project is selected for goal driver execution. Inspect projects with task_read({ action: "status" }) or task_read({ action: "project_list" }), select the active project only when the inspected state identifies a single intended project, or stop and report when multiple active projects or scopes could be the intended goal.',
        "Do not claim project-bound work until a current project is selected.",
        ASK_BEFORE_GUESSING,
      ];
  return renderModePrompt(graph, selectedProjectRef, focus, "Implementation", requirements);
}

const PLANNING_AFFECTING_CHOICES =
  "scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order";

const SPARK_GOAL_DECISION_RULE = `Goal objectives should normally describe the selected project's substantive intended outcome from its purpose, description, title, task plans, evidence requirements, and blockers; do not reduce the goal to task counts or merely stopping at a plan unless the user explicitly says planning-only/readiness-only/仅规划. Autonomous goal edits require a strong reason and may only correct materially wrong description or direction; never lower difficulty, narrow required outcomes, or convert implementation work into planning-only/readiness-only work. If task decomposition is wrong, missing, or blocks the goal, create or revise concrete tasks with task_write({ action: "plan" }); if a missing user decision would change ${PLANNING_AFFECTING_CHOICES} and cannot be inferred from context, use canonical ask only when reviewer auto-answer is available; otherwise stop and report the blocker without pausing or weakening the goal.`;

function renderGoalAction(hasExplicitGoal: boolean): string {
  const goalSource = hasExplicitGoal
    ? "Use the explicit goal focus as the target objective."
    : "Infer the target objective from the current project purpose, description, title, task plans, required evidence, recent artifacts, and blockers.";
  return (
    'Run Spark goal mode: read the current project/task plan and inspect ready tasks with task_read({ action: "status" }). ' +
    goalSource +
    ' If the inspected state identifies a single next goal, state that derived goal briefly and work toward it by claiming one ready concrete task at a time with task_write({ action: "claim" }), executing it, verifying required evidence, and calling task_write({ action: "finish" }). Continue to the next ready task after each successful finish until the goal is complete, no ready task remains, validation fails, or a required user decision blocks progress.'
  );
}

function renderWorkflowDriverAction(workflowSelector: string | undefined): string {
  if (workflowSelector?.startsWith("workspace:") || workflowSelector?.startsWith("user:")) {
    return "Run the selected saved scripted workflow through Spark workflow runtime boundaries: use Spark-owned workflow script metadata, route agent steps through the Spark workflow role-run adapter, preserve project attribution and evidence, and do not bypass Spark tasks as durable project truth.";
  }
  return "Select or start the appropriate saved workflow for the focus. Use workflow for saved-script discovery/preview, run workflow-owned steps only through Spark workflow/runtime plumbing, keep artifacts attributed to the project, and stop/report when workflow selection, scope, or approval is required.";
}

export function renderSparkWorkflowDriverVisibleMessage(
  projectTitle: string | undefined,
  focus: string | undefined,
  workflowSelector?: string,
): string {
  const parts = ["Spark workflow driver requested"];
  if (projectTitle?.trim()) parts.push(`project: ${projectTitle.trim()}`);
  if (workflowSelector && workflowSelector !== "agent:auto")
    parts.push(`workflow: ${workflowSelector}`);
  if (focus?.trim()) parts.push(`focus: ${focus.trim()}`);
  return parts.join(" · ");
}
