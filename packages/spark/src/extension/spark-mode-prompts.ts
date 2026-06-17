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
  focus: string | undefined,
  savedWorkflows: SparkSavedWorkflowDiscovery = { workflows: [], errors: [] },
  workflowSelector?: string,
): string {
  const workflowGuidance = renderSparkWorkflowGuidance(focus, savedWorkflows, workflowSelector);
  const requirements = [
    ...(workflowSelector && workflowSelector !== "agent:auto"
      ? [`Workflow selector: ${workflowSelector}.`]
      : []),
    renderWorkflowDriverAction(workflowSelector),
    "Workflow is an independent tool/runtime boundary, not an implement-mode strategy and not a project/task prerequisite. Do not create, select, or mutate a Spark project merely to run a workflow.",
    "Run workflow-owned steps without Spark project attribution; only switch to project/task tools if the user explicitly asks to turn workflow results into durable project planning or implementation.",
    workflowGuidance,
  ];
  return renderStandaloneWorkflowDriverPrompt(focus, requirements);
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
    "- Goal is the foreground driver for this turn; it supplies objective, idle-loop cadence, reviewer-backed auto-decision/auto-ask policy, and reviewer-gated completion flow: the main session requests completion, the reviewer audits, and Spark applies the approved state transition. The selected mode supplies concrete tool policy.",
    "- Goal turns are allowed to use canonical ask only with reviewer auto-answer; if the reviewer cannot answer, treat that as a blocker to resolve or report. Do not wait for raw human input, pause, weaken, or complete the goal autonomously.",
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
        "Goal driver is non-interactive and auto-decision capable: do not call ask_user/ask_flow. Use canonical ask only with reviewer auto-answer for material decisions; if reviewer auto-answer is blocked, record/report the blocker instead of waiting for raw human input. If a blocker appears, resolve the blocker by doing or planning the blocking work; do not pause or weaken the goal autonomously.",
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

const SPARK_GOAL_DECISION_RULE = `Goal objectives should normally describe the selected project's substantive intended outcome from its purpose, description, title, task plans, evidence requirements, and blockers; do not reduce the goal to task counts or merely stopping at a plan unless the user explicitly says planning-only/readiness-only/仅规划. Autonomous goal edits require a strong reason and may only correct materially wrong description or direction; never lower difficulty, narrow required outcomes, or convert implementation work into planning-only/readiness-only work. If task decomposition is wrong, missing, or blocks the goal, create or revise concrete tasks with task_write({ action: "plan" }); if a missing user decision would change ${PLANNING_AFFECTING_CHOICES} and cannot be inferred from context, use canonical ask only when reviewer auto-answer is available. A reviewer auto-answer is a goal-local decision aid, not final completion approval; otherwise stop and report the blocker without pausing or weakening the goal.`;

function renderGoalAction(hasExplicitGoal: boolean): string {
  const goalSource = hasExplicitGoal
    ? "Use the explicit goal focus as the target objective."
    : "Infer the target objective from the current project purpose, description, title, task plans, required evidence, recent artifacts, and blockers.";
  return (
    'Run Spark goal mode: read the current project/task plan and inspect ready tasks with task_read({ action: "status" }). ' +
    goalSource +
    ' If the inspected state identifies a single next goal, state that derived goal briefly and work toward it by claiming one ready concrete task at a time with task_write({ action: "claim" }), executing it, verifying required evidence, and calling task_write({ action: "finish" }). Continue to the next ready task after each successful finish until the goal is complete, no ready task remains, validation fails, or a required decision cannot be resolved by reviewer auto-answer.'
  );
}

function renderWorkflowDriverAction(workflowSelector: string | undefined): string {
  if (workflowSelector?.startsWith("workspace:") || workflowSelector?.startsWith("user:")) {
    return "Run the selected saved scripted workflow through Spark workflow runtime boundaries: use Spark-owned workflow script metadata, route agent steps through the Spark workflow role-run adapter, and keep workflow output standalone unless the user explicitly asks to attach it to a Spark project.";
  }
  return "Select or start the appropriate saved workflow for the focus. Use workflow for saved-script discovery/preview, run workflow-owned steps only through Spark workflow/runtime plumbing, keep workflow output standalone unless the user explicitly asks to attach it to a Spark project, and stop/report when workflow selection, scope, or approval is required.";
}

function renderStandaloneWorkflowDriverPrompt(
  focus: string | undefined,
  requirements: readonly string[],
): string {
  return [
    "## Workflow driver mode requirements",
    focus?.trim() ? `Focus: ${focus.trim()}` : undefined,
    ...requirements.map((line) => "- " + line),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderSparkWorkflowDriverVisibleMessage(
  focus: string | undefined,
  workflowSelector?: string,
): string {
  const parts = ["Spark workflow driver requested"];
  if (workflowSelector && workflowSelector !== "agent:auto")
    parts.push(`workflow: ${workflowSelector}`);
  if (focus?.trim()) parts.push(`focus: ${focus.trim()}`);
  return parts.join(" · ");
}
