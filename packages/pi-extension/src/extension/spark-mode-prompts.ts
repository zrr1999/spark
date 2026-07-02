import type { ProjectRef } from "@zendev-lab/spark-extension-api";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import type { SparkEntryPhase } from "./spark-entry.ts";
import {
  ASK_BEFORE_GUESSING,
  PARALLEL_EXECUTION_WORKFLOW_STRATEGY,
  WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
  renderModePrompt,
  renderSparkPlanningModePrompt,
  renderSparkResearchModePrompt,
} from "./mode/index.ts";
import {
  renderSparkUltracodeWorkflowGuidance,
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

export function renderSparkGoalDriverPhasePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  phase: SparkEntryPhase,
): string {
  const phasePrompt =
    phase === "research"
      ? renderSparkResearchModePrompt(graph, selectedProjectRef, focus)
      : phase === "plan"
        ? renderSparkPlanningModePrompt(graph, selectedProjectRef, focus, "auto")
        : renderSparkGoalModePrompt(graph, selectedProjectRef, focus);
  return [phasePrompt, renderGoalDriverGuidance(focus)].join("\n\n");
}

/** @deprecated Use renderSparkGoalDriverPhasePrompt. */
export const renderSparkGoalDriverModePrompt = renderSparkGoalDriverPhasePrompt;

function renderGoalDriverGuidance(focus: string | undefined): string {
  const goal = focus?.trim() || "the active Spark goal";
  return [
    "## Goal driver guidance",
    `- Active goal objective: ${goal}`,
    "- Work toward the objective using the selected phase's concrete tool policy. The main session requests completion, the reviewer audits, and Spark applies any approved state transition.",
    "- Goal turns may use canonical ask only with reviewer auto-answer; if the reviewer cannot answer, record or report the blocker and keep the objective unchanged.",
    '- Request goal({ action: "complete" }) only after evidence covers every requirement in the objective.',
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
        "Goal driver decisions use canonical ask with reviewer auto-answer for material decisions. If reviewer auto-answer is blocked, record or report the blocker and resolve it through concrete work or planning while keeping the goal objective unchanged.",
        SPARK_GOAL_DECISION_RULE,
      ]
    : [
        'No current project is selected for goal driver execution. Inspect projects with task_read({ action: "workspace_status" }) or task_read({ action: "project_list" }), select a current project only when the inspected state identifies a single intended project, or stop and report when multiple projects or scopes could be the intended goal.',
        "Do not claim project-bound work until a current project is selected.",
        ASK_BEFORE_GUESSING,
      ];
  return renderModePrompt(graph, selectedProjectRef, focus, "Implementation", requirements);
}

const PLANNING_AFFECTING_CHOICES =
  "scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order";

const SPARK_GOAL_DECISION_RULE = `Goal objectives should normally describe the selected project's substantive intended outcome from its purpose, description, title, task plans, evidence requirements, and blockers; do not reduce the goal to task counts or merely stopping at a plan unless the user explicitly says planning-only/readiness-only/仅规划. Autonomous goal edits require a strong reason and may only correct materially wrong description or direction; never lower difficulty, narrow required outcomes, or convert implementation work into planning-only/readiness-only work. If task decomposition is wrong, missing, or blocks the goal, create or revise concrete tasks with task_write({ action: "plan" }); if a missing user decision would change ${PLANNING_AFFECTING_CHOICES} and cannot be inferred from context, use canonical ask only when reviewer auto-answer is available. A reviewer auto-answer may resolve the local decision; request reviewer-gated goal completion separately after evidence covers the objective. Otherwise stop and report the blocker without pausing or weakening the goal.`;

function renderGoalAction(hasExplicitGoal: boolean): string {
  const goalSource = hasExplicitGoal
    ? "Use the explicit goal focus as the target objective."
    : "Infer the target objective from the current project purpose, description, title, task plans, required evidence, recent artifacts, and blockers.";
  return (
    'Run the Spark goal drive using the selected phase: read the current project/task plan and inspect ready tasks with task_read({ action: "project_status" }). ' +
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
    "## Workflow driver requirements",
    focus?.trim() ? `Focus: ${focus.trim()}` : undefined,
    ...requirements.map((line) => "- " + line),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderSparkUltracodeWorkflowPrompt(
  focus: string | undefined,
  savedWorkflows: SparkSavedWorkflowDiscovery = { workflows: [], errors: [] },
): string {
  return renderStandaloneWorkflowDriverPrompt(focus, [
    "Ultracode high-effort workflow generation is explicitly requested. Do not trigger this path for ordinary prompts; it is opt-in only.",
    'If an existing saved workflow clearly satisfies the request, run it with workflow_run({ selector, args }) after reading/previewing it through workflow({ action: "read" }).',
    "If no saved workflow fits, generate one metadata-first JavaScript workflow script and execute it with workflow_run({ script, args, concurrency, maxAgents, tokenBudget }). Do not run ad hoc shell/filesystem steps outside workflow_run.",
    "Use bounded defaults unless the user explicitly asks otherwise: concurrency <= 4, maxAgents <= 12, clear stages, and a visible tokenBudget when the workflow may fan out.",
    "Generated scripts should use quality helpers such as verify, judgePanel, completenessCheck, retry, gate, and artifactRecord where they improve confidence, and should synthesize a compact final result.",
    "Reuse workflow_run approval, persistence, resume, telemetry, and Graft isolation paths; do not duplicate approval or run-manager state.",
    "Keep workflow output standalone unless the user explicitly asks to attach results to Spark project/task state.",
    renderSparkUltracodeWorkflowGuidance(focus, savedWorkflows),
  ]);
}

export function renderSparkUltracodeWorkflowVisibleMessage(focus: string | undefined): string {
  const parts = ["Spark ultracode workflow requested"];
  if (focus?.trim()) parts.push(`focus: ${focus.trim()}`);
  return parts.join(" · ");
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
