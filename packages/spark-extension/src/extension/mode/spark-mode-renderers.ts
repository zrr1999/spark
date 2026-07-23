import type { ProjectRef } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import type { RoadmapPlanningContext } from "../../flows/roadmap-flow.ts";
import { renderRoadmapPlanningContext } from "../../flows/roadmap-flow.ts";
import type { SparkEntryPhase } from "../spark-entry.ts";
import type { SparkPlanningModeSource } from "../session-state.ts";

const PLANNING_AFFECTING_CHOICES =
  "scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order";

export const ASK_BEFORE_GUESSING = `Do not guess user intent. Unless the user explicitly asks you to infer or research, if a user-facing open question or decision would change ${PLANNING_AFFECTING_CHOICES}, call ask with context-specific questions before narrowing scope, planning durable work, or finishing execution.`;

/** Goal/repro: blockers and material unknowns must become canonical asks, not silent guesses or prose-only reports. */
export const MUST_ASK_ON_PROBLEMS =
  "When blocked by a missing user decision, ambiguous requirement, unclear success criterion, conflicting evidence, or any problem the user can unblock, call ask immediately with a concrete, context-specific question. Do not guess, invent defaults that change scope, or end the turn with only a prose blocker report when ask can resolve it.";

/** Goal/repro: keep orchestration on the main session unless the user explicitly wants fan-out. */
export const MAIN_SESSION_SCHEDULING_FIRST =
  'Prefer the main session for scheduling and execution. Do not default to role({ action: "call" }), session({ action: "call"|"send" }), assign, or workflow_run for ordinary goal/repro ticks. Use those only when the user explicitly requests multi-agent/workflow fan-out, or when a clearly parallelizable slice cannot be done safely in the main session.';

const DURABLE_PLANNING_RULES =
  'Use task_write({ action: "plan" }) only for concrete executable/review/validation/research work with high-bar, objectively verifiable success criteria and concrete evidence expectations. Every planned task must set a substantive outcome, each success/evidence/plan item must be checkable, and low-threshold wording such as basic/minimal/quick/best-effort/if possible/smoke-only is not acceptable. Never create standalone design/planning tasks; discuss design in conversation first, then embed the chosen design, rationale, constraints, alternatives, and success evidence inside each concrete task.plan.';

const NO_CANNED_ASKS =
  "Keep asks dynamic and grounded in inspected context; do not use canned intake templates or ask questions whose answers would not change the task plan.";

export const WORKFLOW_AND_SUBAGENT_ARE_TOOLS =
  "Workflow and subagent role runs are execution tools, not session phases. First select the governing phase (plan or implement), then use role/workflow only within that phase's responsibility and evidence boundaries.";

export const DURABLE_STATE_AUTHORITY =
  'Compact summaries, restored conversation history, and hidden phase text are historical hints only. Before planning, claiming, finishing, or deciding a goal/project transition, verify durable state with scoped tools: task_read({ action: "project_status" }) for the selected project, task_read({ action: "workspace_status" }) or task_read({ action: "project_list" }) before selecting a project, and goal({ action: "status" }) before relying on a goal.';

const RESEARCH_SUBAGENT_STRATEGY =
  'Default lightweight research should use anonymous role calls plus main-agent synthesis when parallel inspection, cross-checking, or specialist review materially improves coverage. Call role({ action: "call", role, instruction }) with focused read-only research briefs; use session({ action: "call", sessionId, instruction }) only when persistent conversation continuity is intentional. The main agent remains responsible for summarizing, reconciling, and qualifying the findings.';

export const PARALLEL_EXECUTION_WORKFLOW_STRATEGY =
  'For ordinary single-task implementation, work directly with focused tools. Use the workflow runtime only when the user asks for workflow/fan-out/multi-agent orchestration, or when the execution work is clearly parallelizable, repetitive, or suited to scripted orchestration. In those cases, discover saved workflows with workflow({ action: "list" }) and read candidates with workflow({ action: "read" }) before choosing workflow_run or a new trusted workflow script.';

export function renderSparkPlanningModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  source: SparkPlanningModeSource,
  roadmapContext?: RoadmapPlanningContext,
): string {
  const roadmapLine = renderRoadmapPlanningContext(roadmapContext);
  const openingRequirement =
    source === "direct"
      ? "Treat this explicit /plan request as planning intent: investigate first as needed, then produce or revise a durable plan when the request concerns executable project work."
      : "Investigate and answer directly by default; create or revise durable project state only when the user asks for planning or a concrete project progression need makes durable work necessary.";
  const sharedRequirements = [
    openingRequirement,
    "Inspect the repository, project state, artifacts, context providers, and external references needed to answer or plan the request.",
    WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
    RESEARCH_SUBAGENT_STRATEGY,
    'Ordinary investigation, explanation, review, and commentary do not require task_write({ action: "project_use" | "plan" }); report the answer directly without creating durable state.',
    "Before generating or changing a durable plan, outline the plan shape and keep clarifying until every material planning-affecting choice is either clear from inspected context or answered through context-specific ask questions.",
    DURABLE_PLANNING_RULES,
    'When durable planning is warranted and concrete executable/review/validation/research tasks meet the planning bar, call task_write({ action: "plan" }) directly; refine it with concrete updates rather than a separate dry-run/apply phase.',
    NO_CANNED_ASKS,
    ASK_BEFORE_GUESSING,
    "Do not execute tasks yet unless the user explicitly asks to switch to implementation.",
  ];
  const requirements = selectedProjectRef
    ? [
        ...sharedRequirements,
        'Call task_write({ action: "project_rename" }) only when inspected context clearly supports a more specific label than a stale or generic bootstrap title; use project_metadata_update for description/purpose/output language changes.',
      ]
    : [
        ...sharedRequirements,
        'No current project is selected. Continue read-only investigation and answer directly when no durable plan is needed. If durable planning is warranted and the intended project is clear, call task_write({ action: "project_use", title, description }) before task_write({ action: "plan" }); ask only when project identity or material scope remains ambiguous.',
      ];
  return renderModePrompt(graph, selectedProjectRef, focus, "Planning", requirements, roadmapLine);
}

export function renderSparkImplementationModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
): string {
  const requirements = selectedProjectRef
    ? [
        'Read the current project/task plan and inspect ready tasks with task_read({ action: "project_status" }). Claim one concrete ready task at a time with task_write({ action: "claim" }), execute it, verify the required evidence with artifact/learning/context as needed, then call task_write({ action: "finish" }). After each successful finish, inspect project_status again and continue with the next ready task until no ready task remains, validation fails, review/ask approval is pending, or a real blocker requires user input or external action. Projects are permanent records; do not use a Project finish/status lifecycle or request goal completion from /implement.',
        "Implementation phase is human-blocking: use canonical ask for material user decisions and wait for the answer; do not auto-answer asks, do not make goal-style autonomous policy decisions, and do not request reviewer-gated goal completion from /implement.",
        WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
        PARALLEL_EXECUTION_WORKFLOW_STRATEGY,
        "If work becomes open-ended with no natural completion condition, suggest /loop. If the user wants autonomous completion with auto-decision policy and reviewer-gated completion, suggest /goal. If the user wants a scripted saved workflow, suggest /workflow.",
        'When this phase is running as a daemon driver tick, inspect project_status before ending: call driver({ action: "schedule", delayMs: 0, reason }) only when concrete ready work remains; call driver({ action: "stop", reason }) when no work is ready, a blocker exists, or a human/review decision is pending. Omitting both leaves the driver dormant to prevent a no-progress spin.',
        ASK_BEFORE_GUESSING,
      ]
    : [
        'Select a current project with task_write({ action: "project_use" }) before claiming project-bound work; use task_read({ action: "workspace_status" }) to inspect available projects first if needed.',
        "Do not claim project-bound work until a current project is selected.",
        'When running inside a daemon driver tick, call driver({ action: "stop", reason: "no current project" }) before ending the turn.',
        ASK_BEFORE_GUESSING,
      ];
  return renderModePrompt(graph, selectedProjectRef, focus, "Implementation", requirements);
}

export function renderModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  phase: "Planning" | "Implementation" | "Goal driver" | "Workflow driver",
  requirements: string[],
  extraContext?: string,
): string {
  const scopedRequirements = [DURABLE_STATE_AUTHORITY, ...requirements];
  const sections = [
    renderSparkProjectSummary(graph, selectedProjectRef),
    renderPhaseFocus(phase, focus),
    extraContext?.trim() || undefined,
    [
      phase.endsWith("driver") ? `## ${phase} requirements` : `## ${phase} phase requirements`,
      ...scopedRequirements.map((item) => `- ${item}`),
    ].join("\n"),
  ].filter((section): section is string => Boolean(section));
  return sections.join("\n\n");
}

function renderPhaseFocus(phase: string, focus: string | undefined): string | undefined {
  const trimmed = focus?.trim();
  if (!trimmed) return undefined;
  return `## ${phase} focus\n${trimmed}`;
}

function renderSparkProjectSummary(graph: TaskGraph, selectedProjectRef?: ProjectRef): string {
  const projects = graph.projects();
  const project = selectedProjectRef
    ? projects.find((candidate) => candidate.ref === selectedProjectRef)
    : undefined;
  if (!project) {
    return [
      "## Spark project summary",
      "- Current project: none selected for this session",
      `- Projects: ${projects.length} total`,
      '- Guidance: use task_write({ action: "project_use" }) to select or create a current project before project-bound planning or execution.',
    ].join("\n");
  }
  const tasks = graph.tasks(project.ref);
  const unfinished = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
  const ready = graph.readyTasks(project.ref);
  return [
    "## Spark project summary",
    `- Current project: ${project.title} (${project.ref})`,
    `- Tasks: ${tasks.length} total / ${unfinished.length} unfinished`,
    ready.length > 0
      ? `- Ready frontier: ${ready
          .slice(0, 5)
          .map((task) => `@${task.name}: ${task.title}`)
          .join("; ")}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderSparkPhaseVisibleMessage(
  phase: SparkEntryPhase,
  projectTitle: string | undefined,
  focus: string | undefined,
): string {
  const title = phase === "plan" ? "Spark plan phase requested" : "Spark implement phase requested";
  const parts = [title];
  if (projectTitle?.trim()) parts.push(`project: ${projectTitle.trim()}`);
  if (focus?.trim()) parts.push(`focus: ${focus.trim()}`);
  return parts.join(" · ");
}

/** @deprecated Use renderSparkPhaseVisibleMessage. */
export const renderSparkModeVisibleMessage = renderSparkPhaseVisibleMessage;
