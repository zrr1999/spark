import type { ProjectRef } from "pi-extension-api";
import type { TaskGraph } from "pi-tasks";
import type { SparkEntryMode } from "./spark-entry.ts";
import type { RoadmapPlanningContext } from "../flows/roadmap-flow.ts";
import { renderRoadmapPlanningContext } from "../flows/roadmap-flow.ts";
import type { SparkExecuteStrategy, SparkPlanningModeSource } from "./session-state.ts";
import {
  renderSparkWorkflowGuidance,
  type SparkSavedWorkflowDiscovery,
} from "./spark-workflow-builtins.ts";

const PLANNING_AFFECTING_CHOICES =
  "scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order";

const ASK_BEFORE_GUESSING = `Do not guess user intent. Unless the user explicitly asks you to infer or research, if a user-facing open question or decision would change ${PLANNING_AFFECTING_CHOICES}, call ask with context-specific questions before narrowing scope, planning durable work, or finishing execution.`;

const DURABLE_PLANNING_RULES =
  'Use task({ action: "plan" }) only for concrete executable/review/validation/research work with success criteria and evidence expectations. Never create standalone design/planning tasks; discuss design in conversation first, then embed the chosen design, rationale, constraints, alternatives, and success evidence inside each concrete task.plan.';

const NO_CANNED_ASKS =
  "Keep asks dynamic and grounded in inspected context; do not use canned intake templates or ask questions whose answers would not change the task plan.";

export function renderSparkResearchModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
): string {
  return renderModePrompt(
    graph,
    selectedProjectRef,
    focus,
    "Research",
    selectedProjectRef
      ? [
          "Investigate the repository, current project, task graph, artifacts, context providers, and external references needed to answer the focus.",
          "Report findings directly; do not change files or durable Spark task state in research mode unless the user explicitly asks for that change.",
          'Do not call task({ action: "plan" | "claim" | "finish" }) in research mode.',
          "When research changes task scope, suggests new work, or exposes multiple implementation directions, summarize findings and ask whether the user wants design options, durable task planning, or execution toward completing the project.",
          ASK_BEFORE_GUESSING,
        ]
      : [
          'Select a current project with task({ action: "project_use" }) before project-scoped research; use task({ action: "status" }) or context preview to inspect available projects first if needed.',
          ASK_BEFORE_GUESSING,
        ],
  );
}

export function renderSparkPlanningModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  source: SparkPlanningModeSource,
  roadmapContext?: RoadmapPlanningContext,
): string {
  const roadmapLine = renderRoadmapPlanningContext(roadmapContext);
  const requirements = [
    source === "direct"
      ? "Treat this /plan request as a high-priority planning prompt, not as a permission gate and not as an answer-only research turn."
      : "Research and clarify the project context first, then choose the lightest appropriate action from the actual request.",
    "Before generating or changing a durable plan, brainstorm the plan shape and keep clarifying until every material planning-affecting choice is either clear from inspected context or answered through context-specific ask questions.",
    "Ask when the user may want design options only, durable task planning, or execution toward completing all project tasks.",
    'Answer directly for a simple research/read-and-comment turn; call task({ action: "project_update" }) only when context shows the bootstrap title is stale/generic and a better label is obvious.',
    DURABLE_PLANNING_RULES,
    'When readiness checks pass, call task({ action: "plan" }) directly; refine by calling task({ action: "plan" }) again with concrete updates rather than using a separate dry-run/apply phase.',
    NO_CANNED_ASKS,
    ASK_BEFORE_GUESSING,
    "Do not execute tasks yet unless the user explicitly asks to switch to execution.",
  ];
  return renderModePrompt(graph, selectedProjectRef, focus, "Planning", requirements, roadmapLine);
}

export function renderSparkExecutionModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  strategy: SparkExecuteStrategy = "default",
  savedWorkflows: SparkSavedWorkflowDiscovery = { workflows: [], errors: [] },
  workflowSelector?: string,
): string {
  const workflowGuidance =
    selectedProjectRef && strategy === "workflow"
      ? renderSparkWorkflowGuidance(focus, savedWorkflows, workflowSelector)
      : undefined;
  const requirements = selectedProjectRef
    ? [
        `Execution strategy: ${strategy}.`,
        ...(workflowSelector && workflowSelector !== "agent:auto"
          ? [`Workflow selector: ${workflowSelector}.`]
          : []),
        strategy === "goal"
          ? renderGoalAction(Boolean(focus?.trim()))
          : strategy === "workflow"
            ? renderWorkflowAction(workflowSelector)
            : 'Read the current project/task plan and inspect ready tasks with task({ action: "status" }). Claim at most one concrete task with task({ action: "claim" }), execute it, verify the required evidence with artifact/learning/context as needed, then call task({ action: "finish" }). Stop after that task finishes; do not auto-claim another task or dispatch continuous work from /execute.',
        strategy === "goal"
          ? "Goal mode is non-interactive: do not call ask_user/ask_flow. Canonical ask may be used only when the host supplies reviewer auto-answer. If a blocker appears, resolve the blocker by doing or planning the blocking work; do not pause or weaken the goal autonomously."
          : "If the user wants autonomous completion of all ready work, suggest /goal. If the user wants a scripted saved workflow, suggest /workflow.",
        strategy === "goal" ? SPARK_GOAL_DECISION_RULE : ASK_BEFORE_GUESSING,
        ...(workflowGuidance ? [workflowGuidance] : []),
      ]
    : [
        strategy === "goal"
          ? 'No current project is selected for goal mode. Inspect projects with task({ action: "status" }) or task({ action: "project_list" }), select the obvious active project with task({ action: "project_use" }) when the state is unambiguous, or stop and report when multiple active projects or scopes could be the intended goal.'
          : 'Select a current project with task({ action: "project_use" }) before claiming project-bound work; use task({ action: "status" }) to inspect available projects first if needed.',
        "Do not claim project-bound work until a current project is selected.",
        ASK_BEFORE_GUESSING,
      ];
  return renderModePrompt(graph, selectedProjectRef, focus, "Execution", requirements);
}

const SPARK_GOAL_DECISION_RULE = `Goal objectives should normally describe the selected project's substantive intended outcome from its purpose, description, title, task plans, evidence requirements, and blockers; do not reduce the goal to task counts or merely stopping at a plan unless the user explicitly says planning-only/readiness-only/仅规划. Autonomous goal edits require a strong reason and may only correct materially wrong description or direction; never lower difficulty, narrow required outcomes, or convert implementation work into planning-only/readiness-only work. If task decomposition is wrong, missing, or blocks the goal, create or revise concrete tasks with task({ action: "plan" }); if a missing user decision would change ${PLANNING_AFFECTING_CHOICES} and cannot be inferred from context, use canonical ask only when reviewer auto-answer is available; otherwise stop and report the blocker without pausing or weakening the goal.`;

function renderGoalAction(hasExplicitGoal: boolean): string {
  const goalSource = hasExplicitGoal
    ? "Use the explicit goal focus as the target objective."
    : "Infer the target objective from the current project purpose, description, title, task plans, required evidence, recent artifacts, and blockers.";
  return (
    'Run Spark goal mode: read the current project/task plan and inspect ready tasks with task({ action: "status" }). ' +
    goalSource +
    ' If a single next goal is obvious, state that derived goal briefly and work toward it by claiming one ready concrete task at a time with task({ action: "claim" }), executing it, verifying required evidence, and calling task({ action: "finish" }). Continue to the next ready task after each successful finish until the goal is complete, no ready task remains, validation fails, or a required user decision blocks progress.'
  );
}

function renderWorkflowAction(workflowSelector: string | undefined): string {
  if (workflowSelector?.startsWith("workspace:") || workflowSelector?.startsWith("user:")) {
    return "Run the selected saved scripted workflow through Spark workflow runtime boundaries: use Spark-owned workflow script metadata, route agent steps through the Spark workflow role-run adapter, preserve project attribution and evidence, and do not bypass Spark tasks as durable project truth.";
  }
  return "Select or start the appropriate saved workflow for the focus. Use workflow for saved-script discovery/preview, run workflow-owned steps only through Spark workflow/runtime plumbing, keep artifacts attributed to the project, and stop/report when workflow selection, scope, or approval is required.";
}

function renderModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  mode: "Research" | "Planning" | "Execution",
  requirements: string[],
  extraContext?: string,
): string {
  const sections = [
    renderSparkProjectSummary(graph, selectedProjectRef),
    renderModeFocus(mode, focus),
    extraContext?.trim() || undefined,
    [`## ${mode} mode requirements`, ...requirements.map((item) => `- ${item}`)].join("\n"),
  ].filter((section): section is string => Boolean(section));
  return sections.join("\n\n");
}

function renderModeFocus(mode: string, focus: string | undefined): string | undefined {
  const trimmed = focus?.trim();
  if (!trimmed) return undefined;
  return `## ${mode} focus\n${trimmed}`;
}

function renderSparkProjectSummary(graph: TaskGraph, selectedProjectRef?: ProjectRef): string {
  const projects = graph.projects();
  const project = selectedProjectRef
    ? projects.find((candidate) => candidate.ref === selectedProjectRef)
    : undefined;
  if (!project) {
    const activeCount = projects.filter((candidate) => candidate.status !== "done").length;
    return [
      "## Spark project summary",
      "- Current project: none selected for this session",
      `- Projects: ${projects.length} total / ${activeCount} active`,
      '- Guidance: use task({ action: "project_use" }) to select or create a current project before project-bound planning or execution.',
    ].join("\n");
  }
  const tasks = graph.tasks(project.ref);
  const unfinished = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
  return [
    "## Spark project summary",
    `- Current project: ${project.title} (${project.ref})`,
    `- Status: ${project.status}`,
    `- Tasks: ${tasks.length} total / ${unfinished.length} unfinished`,
  ].join("\n");
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
