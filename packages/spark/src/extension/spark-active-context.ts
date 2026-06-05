import type { TaskGraph } from "pi-tasks";
import { isUnfinishedTaskStatus } from "pi-tasks";
import { isActiveSessionTodo, type SessionTodoEntry } from "pi-tasks";
import { isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";
import { truncateInline } from "./tool-rendering.ts";

const SPARK_CONTEXT_TODO_LIMIT = 3;
const SPARK_CONTEXT_CLAIMED_TASK_LIMIT = 1;
const SPARK_MD_CONTEXT_MAX_LINES = 20;
const SPARK_MD_CONTEXT_MAX_CHARS = 1_200;

type SparkProject = ReturnType<TaskGraph["projects"]>[number];

export function renderActiveSparkContext(input: {
  graph: TaskGraph;
  project?: SparkProject;
  sessionKey: string;
  independentTodos: SessionTodoEntry[];
  sparkMd?: string;
}): string | undefined {
  const stateLines = input.project
    ? renderActiveSparkProjectSummary(
        input.graph,
        input.project,
        input.sessionKey,
        input.independentTodos,
      )
    : renderNoCurrentSparkProjectSummary(input.graph);
  const sparkMdExcerpt = input.sparkMd ? renderSparkMdActiveExcerpt(input.sparkMd) : undefined;
  const lines = [
    sparkMdExcerpt ? ["SPARK.md (active intent excerpt):", sparkMdExcerpt].join("\n") : undefined,
    stateLines,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n\n") : undefined;
}

function renderActiveSparkProjectSummary(
  graph: TaskGraph,
  project: SparkProject,
  sessionKey: string,
  independentTodos: SessionTodoEntry[],
): string {
  const tasks = graph.tasks(project.ref);
  const unfinishedTasks = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
  const claimed = unfinishedTasks.filter((task) => taskClaimedBy(task));
  const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, sessionKey));
  const lines = [
    "Active Spark context:",
    `- Current project: ${project.title} (${project.ref})`,
    `- Unfinished tasks: ${unfinishedTasks.length} / claimed: ${claimed.length} / current_session_claimed: ${sessionClaimed.length} (${tasks.length} total)`,
  ];

  const activeIndependentTodos = independentTodos.filter(isActiveSessionTodo);
  if (activeIndependentTodos.length > 0) {
    const visibleTodos = activeIndependentTodos.slice(0, SPARK_CONTEXT_TODO_LIMIT);
    lines.push(`- Independent TODOs (session priority): ${activeIndependentTodos.length} active`);
    for (const todo of visibleTodos) {
      const id = todo.id ? `${todo.id} ` : "";
      lines.push(`  - [${todo.status}] ${id}${truncateInline(todo.content, 160)}`);
    }
    const hidden = activeIndependentTodos.length - visibleTodos.length;
    if (hidden > 0) lines.push(`  - … ${hidden} more active TODOs`);
  }

  const visibleSessionClaimed = sessionClaimed.slice(0, SPARK_CONTEXT_CLAIMED_TASK_LIMIT);
  for (const task of visibleSessionClaimed) {
    const activeTodos = graph
      .taskTodos(task.ref)
      .filter((todo) => isActiveSparkTodoStatus(todo.status));
    const visibleTodos = activeTodos.slice(0, SPARK_CONTEXT_TODO_LIMIT);
    const todoSuffix = activeTodos.length > 0 ? `; ${activeTodos.length} active TODOs` : "";
    lines.push(
      `- My claimed task: [${task.status}] @${task.name}: ${task.title} (${task.ref})${todoSuffix}`,
    );
    for (const todo of visibleTodos) {
      lines.push(`  - [${todo.status}] ${todo.id} ${truncateInline(todo.content, 160)}`);
    }
    const hidden = activeTodos.length - visibleTodos.length;
    if (hidden > 0) lines.push(`  - … ${hidden} more active TODOs`);
  }
  const hiddenSessionClaimed = sessionClaimed.length - visibleSessionClaimed.length;
  if (hiddenSessionClaimed > 0)
    lines.push(
      `- … ${hiddenSessionClaimed} more claimed task(s); use task({ action: "status" }) for details`,
    );

  return lines.join("\n");
}

function renderNoCurrentSparkProjectSummary(graph: TaskGraph): string {
  const projects = graph.projects();
  const activeProjects = projects.filter((project) => project.status !== "done");
  return [
    "Spark available: no project selected for this session.",
    `- Projects: ${projects.length} total / ${activeProjects.length} active`,
    '- Use task({ action: "project_use" }) to select or create a current project before planning, claiming, or updating project-bound tasks.',
  ].join("\n");
}

function isActiveSparkTodoStatus(status: string): boolean {
  return status !== "done" && status !== "cancelled" && status !== "deleted";
}

export function renderSparkMdActiveExcerpt(markdown: string): string | undefined {
  return truncateSparkContextBlock(stripFinishedSparkMdSections(markdown));
}

function stripFinishedSparkMdSections(markdown: string): string {
  const lines = markdown.trim().split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) skipping = isFinishedSparkMdHeading(heading[1] ?? "");
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}

function isFinishedSparkMdHeading(heading: string): boolean {
  const normalized = heading
    .replaceAll(/[#*_`]/g, "")
    .trim()
    .toLowerCase();
  if (/^(修订记录|变更记录|历史|完成|已完成)/.test(normalized)) return true;
  return /^(revision history|revisions?|changelog|change log|history|completed|finished|done)\b/i.test(
    normalized,
  );
}

function truncateSparkContextBlock(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/);
  let truncated = false;
  let text = lines.slice(0, SPARK_MD_CONTEXT_MAX_LINES).join("\n").trimEnd();
  if (lines.length > SPARK_MD_CONTEXT_MAX_LINES) truncated = true;
  if (text.length > SPARK_MD_CONTEXT_MAX_CHARS) {
    text = `${text.slice(0, SPARK_MD_CONTEXT_MAX_CHARS - 1).trimEnd()}…`;
    truncated = true;
  }
  return truncated ? `${text}\n… (read SPARK.md for full intent)` : text;
}
