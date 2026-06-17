import type { ProjectRef } from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import type { RoadmapPlanningContext } from "../../flows/roadmap-flow.ts";
import { renderRoadmapPlanningContext } from "../../flows/roadmap-flow.ts";
import type { SparkEntryMode } from "../spark-entry.ts";
import type { SparkPlanningModeSource } from "../session-state.ts";

const PLANNING_AFFECTING_CHOICES =
  "scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order";

export const ASK_BEFORE_GUESSING = `Do not guess user intent. Unless the user explicitly asks you to infer or research, if a user-facing open question or decision would change ${PLANNING_AFFECTING_CHOICES}, call ask with context-specific questions before narrowing scope, planning durable work, or finishing execution.`;

const DURABLE_PLANNING_RULES =
  'Use task_write({ action: "plan" }) only for concrete executable/review/validation/research work with success criteria and evidence expectations. Never create standalone design/planning tasks; discuss design in conversation first, then embed the chosen design, rationale, constraints, alternatives, and success evidence inside each concrete task.plan.';

const NO_CANNED_ASKS =
  "Keep asks dynamic and grounded in inspected context; do not use canned intake templates or ask questions whose answers would not change the task plan.";

export const WORKFLOW_AND_SUBAGENT_ARE_TOOLS =
  "Workflow and subagent role runs are execution tools, not session modes. First select the governing mode (research, plan, or implement), then use role/workflow only within that mode's responsibility and evidence boundaries.";

const RESEARCH_SUBAGENT_STRATEGY =
  'Research mode should use subagent role calls plus main-agent synthesis when parallel inspection, cross-checking, or specialist review materially improves coverage. Call role({ action: "call", role, instruction, launch: "fresh" | "forked" }) with focused read-only research briefs; the main agent remains responsible for summarizing, reconciling, and qualifying the findings.';

export const PARALLEL_EXECUTION_WORKFLOW_STRATEGY =
  'Implementation mode should use the workflow tool/runtime boundary for execution work that is parallelizable, repetitive, or suited to scripted orchestration. Discover saved workflows with workflow({ action: "list" }) and read candidates with workflow({ action: "read" }); if no workflow applies, report the missing workflow requirement or ask for direction before creating or running one.';

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
          WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
          RESEARCH_SUBAGENT_STRATEGY,
          "Report findings directly; do not change files or durable Spark task state in research mode unless the user explicitly asks for that change.",
          'Do not call task_write({ action: "plan" | "claim" | "finish" }) in research mode.',
          "When research changes task scope, suggests new work, or exposes multiple implementation directions, summarize findings and ask whether the user wants design options, durable task planning, or execution toward completing the project.",
          ASK_BEFORE_GUESSING,
        ]
      : [
          WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
          RESEARCH_SUBAGENT_STRATEGY,
          'Select a current project with task_write({ action: "project_use" }) before project-scoped research; use task_read({ action: "status" }) or context preview to inspect available projects first if needed.',
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
        'Call task_write({ action: "project_update" }) only when inspected context clearly supports a more specific label than a stale or generic bootstrap title.',
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
        'Read the current project/task plan and inspect ready tasks with task_read({ action: "status" }). Claim at most one concrete task with task_write({ action: "claim" }), execute it, verify the required evidence with artifact/learning/context as needed, then call task_write({ action: "finish" }). Stop after that task finishes; do not auto-claim another task or dispatch continuous work from /implement.',
        WORKFLOW_AND_SUBAGENT_ARE_TOOLS,
        PARALLEL_EXECUTION_WORKFLOW_STRATEGY,
        "If the user wants autonomous completion of all ready work, suggest /goal. If the user wants a scripted saved workflow, suggest /workflow.",
        ASK_BEFORE_GUESSING,
      ]
    : [
        'Select a current project with task_write({ action: "project_use" }) before claiming project-bound work; use task_read({ action: "status" }) to inspect available projects first if needed.',
        "Do not claim project-bound work until a current project is selected.",
        ASK_BEFORE_GUESSING,
      ];
  return renderModePrompt(graph, selectedProjectRef, focus, "Implementation", requirements);
}

export function renderModePrompt(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  focus: string | undefined,
  mode: "Research" | "Planning" | "Implementation" | "Workflow driver",
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
      '- Guidance: use task_write({ action: "project_use" }) to select or create a current project before project-bound planning or execution.',
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
): string {
  const title =
    mode === "research"
      ? "Spark research mode requested"
      : mode === "plan"
        ? "Spark plan mode requested"
        : "Spark implement mode requested";
  const parts = [title];
  if (projectTitle?.trim()) parts.push(`project: ${projectTitle.trim()}`);
  if (focus?.trim()) parts.push(`focus: ${focus.trim()}`);
  return parts.join(" · ");
}
