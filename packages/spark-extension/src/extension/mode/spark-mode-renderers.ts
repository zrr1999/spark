import type { ProjectRef } from "@zendev-lab/spark-extension-api";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import type { RoadmapPlanningContext } from "../../flows/roadmap-flow.ts";
import { renderRoadmapPlanningContext } from "../../flows/roadmap-flow.ts";
import type { SparkEntryPhase } from "../spark-entry.ts";
import type { SparkPlanningModeSource } from "../session-state.ts";

const PLANNING_AFFECTING_CHOICES =
  "scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order";

export const ASK_BEFORE_GUESSING = `Do not guess user intent. Unless the user explicitly asks you to infer or research, if a user-facing open question or decision would change ${PLANNING_AFFECTING_CHOICES}, call ask with context-specific questions before narrowing scope, planning durable work, or finishing execution.`;

const DURABLE_PLANNING_RULES =
  'Use task_write({ action: "plan" }) only for concrete executable/review/validation/research work with success criteria and evidence expectations. Never create standalone design/planning tasks; discuss design in conversation first, then embed the chosen design, rationale, constraints, alternatives, and success evidence inside each concrete task.plan.';

const NO_CANNED_ASKS =
  "Keep asks dynamic and grounded in inspected context; do not use canned intake templates or ask questions whose answers would not change the task plan.";

export const WORKFLOW_AND_SUBAGENT_ARE_TOOLS =
  "Workflow and subagent role runs are execution tools, not session phases. First select the governing phase (research, plan, or implement), then use role/workflow only within that phase's responsibility and evidence boundaries.";

export const DURABLE_STATE_AUTHORITY =
  'Compact summaries, restored conversation history, and hidden phase text are historical hints only. Before planning, claiming, finishing, or deciding a goal/project transition, verify durable state with scoped tools: task_read({ action: "project_status" }) for the selected project, task_read({ action: "workspace_status" }) or task_read({ action: "project_list" }) before selecting a project, and goal({ action: "status" }) before relying on a goal.';

const RESEARCH_SUBAGENT_STRATEGY =
  'Default lightweight research should use subagent role calls plus main-agent synthesis when parallel inspection, cross-checking, or specialist review materially improves coverage. Call role({ action: "call", role, instruction, launch: "fresh" | "forked" }) with focused read-only research briefs; the main agent remains responsible for summarizing, reconciling, and qualifying the findings.';

export const PARALLEL_EXECUTION_WORKFLOW_STRATEGY =
  'For ordinary single-task implementation, work directly with focused tools. Use the workflow runtime only when the user asks for workflow/fan-out/multi-agent orchestration, or when the execution work is clearly parallelizable, repetitive, or suited to scripted orchestration. In those cases, discover saved workflows with workflow({ action: "list" }) and read candidates with workflow({ action: "read" }) before choosing workflow_run or a new trusted workflow script.';

export function renderSparkResearchModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
): string {
  return renderModePrompt(
    graph,
    selectedProjectRef,
    focus,
    "Default research",
    selectedProjectRef
      ? [
          "Investigate the repository, current project, task graph, artifacts, context providers, and external references needed to answer the focus.",
          WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
          RESEARCH_SUBAGENT_STRATEGY,
          "Report findings directly; do not change files or durable Spark task state during default research unless the user explicitly asks for that change.",
          'Do not call task_write({ action: "plan" | "claim" | "finish" }) during default research.',
          "When research changes task scope, suggests new work, or exposes multiple implementation directions, summarize findings and ask whether the user wants design options, durable task planning, or execution toward completing the project.",
          ASK_BEFORE_GUESSING,
        ]
      : [
          WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
          RESEARCH_SUBAGENT_STRATEGY,
          'Select a current project with task_write({ action: "project_use" }) before project-scoped research; use task_read({ action: "workspace_status" }) or context preview to inspect available projects first if needed.',
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
  const openingRequirement =
    source === "direct"
      ? "Treat this /plan request as a high-priority planning prompt, not as a permission gate and not as an answer-only research turn."
      : "Research and clarify the project context first, then choose the lightest appropriate action from the actual request.";
  const sharedRequirements = [
    openingRequirement,
    "Before generating or changing a durable plan, outline the plan shape and keep clarifying until every material planning-affecting choice is either clear from inspected context or answered through context-specific ask questions.",
    "Ask when the user may want design options only, durable task planning, or execution toward completing all project tasks.",
    DURABLE_PLANNING_RULES,
    'Once concrete executable/review/validation/research tasks have clear objectives, dependencies, success criteria, and evidence requirements, call task_write({ action: "plan" }) directly; refine by calling task_write({ action: "plan" }) again with concrete updates rather than using a separate dry-run/apply phase.',
    NO_CANNED_ASKS,
    ASK_BEFORE_GUESSING,
    "Do not execute tasks yet unless the user explicitly asks to switch to execution.",
  ];
  const requirements = selectedProjectRef
    ? [
        ...sharedRequirements,
        'Answer directly only when the user explicitly asks for read-only research or commentary instead of durable planning; otherwise keep planning toward task_write({ action: "plan" }).',
        'Call task_write({ action: "project_rename" }) only when inspected context clearly supports a more specific label than a stale or generic bootstrap title; use project_metadata_update for description/purpose/output language changes.',
      ]
    : [
        ...sharedRequirements,
        'No current project is selected. If the focus and inspected context identify the intended project, first call task_write({ action: "project_use", title, description }) to create or select that stable project, then call task_write({ action: "plan" }) to add concrete tasks under it.',
        "A missing current project is not an answer-only escape hatch. Ask only when the project identity, scope, or material planning-affecting choices remain ambiguous after inspection; otherwise bootstrap the project and plan durable work directly.",
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
        ASK_BEFORE_GUESSING,
      ]
    : [
        'Select a current project with task_write({ action: "project_use" }) before claiming project-bound work; use task_read({ action: "workspace_status" }) to inspect available projects first if needed.',
        "Do not claim project-bound work until a current project is selected.",
        ASK_BEFORE_GUESSING,
      ];
  return renderModePrompt(graph, selectedProjectRef, focus, "Implementation", requirements);
}

export function renderModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  phase: "Default research" | "Planning" | "Implementation" | "Workflow driver",
  requirements: string[],
  extraContext?: string,
): string {
  const scopedRequirements = [DURABLE_STATE_AUTHORITY, ...requirements];
  const sections = [
    renderSparkProjectSummary(graph, selectedProjectRef),
    renderPhaseFocus(phase, focus),
    extraContext?.trim() || undefined,
    [
      phase === "Default research"
        ? "## Default research requirements"
        : `## ${phase} phase requirements`,
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
  const title =
    phase === "research"
      ? "Spark default research phase requested"
      : phase === "plan"
        ? "Spark plan phase requested"
        : "Spark implement phase requested";
  const parts = [title];
  if (projectTitle?.trim()) parts.push(`project: ${projectTitle.trim()}`);
  if (focus?.trim()) parts.push(`focus: ${focus.trim()}`);
  return parts.join(" · ");
}

/** @deprecated Use renderSparkPhaseVisibleMessage. */
export const renderSparkModeVisibleMessage = renderSparkPhaseVisibleMessage;
