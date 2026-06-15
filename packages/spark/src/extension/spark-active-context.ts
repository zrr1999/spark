import type { TaskGraph } from "@zendev-lab/pi-tasks";
import { isUnfinishedTaskStatus } from "@zendev-lab/pi-tasks";
import { isActiveSessionTodo, type SessionTodoEntry } from "@zendev-lab/pi-tasks";
import { isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";
import type { SparkSessionGoal } from "./spark-session-goals.ts";
import { truncateInline } from "./tool-rendering.ts";
import {
  activeSparkContextStrings,
  sparkLanguageForProject,
  type SparkLanguage,
} from "./spark-i18n.ts";

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
  sessionGoal?: SparkSessionGoal;
  sparkMd?: string;
  language?: SparkLanguage;
}): string | undefined {
  const language =
    input.language ??
    sparkLanguageForProject({
      project: input.project,
      goal: input.sessionGoal,
      fallbackText: input.sparkMd,
    });
  const strings = activeSparkContextStrings(language);
  const stateLines = input.project
    ? renderActiveSparkProjectSummary(
        input.graph,
        input.project,
        input.sessionKey,
        input.independentTodos,
        input.sessionGoal,
        strings,
      )
    : renderNoCurrentSparkProjectSummary(input.graph, input.sessionGoal, strings);
  const sparkMdExcerpt = input.sparkMd
    ? renderSparkMdActiveExcerpt(input.sparkMd, strings.sparkMdReadFull)
    : undefined;
  const lines = [
    sparkMdExcerpt ? [strings.sparkMdHeader, sparkMdExcerpt].join("\n") : undefined,
    stateLines,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n\n") : undefined;
}

function renderActiveSparkProjectSummary(
  graph: TaskGraph,
  project: SparkProject,
  sessionKey: string,
  independentTodos: SessionTodoEntry[],
  sessionGoal: SparkSessionGoal | undefined,
  strings: ReturnType<typeof activeSparkContextStrings>,
): string {
  const tasks = graph.tasks(project.ref);
  const unfinishedTasks = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
  const claimed = unfinishedTasks.filter((task) => taskClaimedBy(task));
  const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, sessionKey));
  const lines = [
    strings.header,
    strings.currentProjectLine(project.title, project.ref),
    strings.taskCountsLine({
      unfinished: unfinishedTasks.length,
      claimed: claimed.length,
      sessionClaimed: sessionClaimed.length,
      total: tasks.length,
    }),
  ];

  if (sessionGoal) {
    const reasonText = sessionGoal.pauseReason ?? sessionGoal.completedReason;
    lines.push(
      strings.goalLine({
        status: sessionGoal.status,
        objective: truncateInline(sessionGoal.objective, 180),
        reason: reasonText ? truncateInline(reasonText, 120) : undefined,
      }),
    );
  }

  const activeIndependentTodos = independentTodos.filter(isActiveSessionTodo);
  if (activeIndependentTodos.length > 0) {
    const visibleTodos = activeIndependentTodos.slice(0, SPARK_CONTEXT_TODO_LIMIT);
    lines.push(strings.independentTodosHeader(activeIndependentTodos.length));
    for (const todo of visibleTodos) {
      const id = todo.id ? `${todo.id} ` : "";
      lines.push(`  - [${todo.status}] ${id}${truncateInline(todo.content, 160)}`);
    }
    const hidden = activeIndependentTodos.length - visibleTodos.length;
    if (hidden > 0) lines.push(strings.independentTodosHidden(hidden));
  }

  const visibleSessionClaimed = sessionClaimed.slice(0, SPARK_CONTEXT_CLAIMED_TASK_LIMIT);
  for (const task of visibleSessionClaimed) {
    const activeTodos = graph
      .taskTodos(task.ref)
      .filter((todo) => isActiveSparkTodoStatus(todo.status));
    const visibleTodos = activeTodos.slice(0, SPARK_CONTEXT_TODO_LIMIT);
    lines.push(
      strings.myClaimedTaskLine({
        status: task.status,
        name: task.name,
        title: task.title,
        ref: task.ref,
        activeTodos: activeTodos.length,
      }),
    );
    for (const todo of visibleTodos) {
      lines.push(`  - [${todo.status}] ${todo.id} ${truncateInline(todo.content, 160)}`);
    }
    const hidden = activeTodos.length - visibleTodos.length;
    if (hidden > 0) lines.push(strings.myClaimedTodosHidden(hidden));
  }
  const hiddenSessionClaimed = sessionClaimed.length - visibleSessionClaimed.length;
  if (hiddenSessionClaimed > 0) lines.push(strings.hiddenSessionClaimed(hiddenSessionClaimed));

  return lines.join("\n");
}

function renderNoCurrentSparkProjectSummary(
  graph: TaskGraph,
  sessionGoal: SparkSessionGoal | undefined,
  strings: ReturnType<typeof activeSparkContextStrings>,
): string {
  const projects = graph.projects();
  const activeProjects = projects.filter((project) => project.status !== "done");
  const lines = [
    strings.noProjectHeader,
    strings.projectsCountsLine(projects.length, activeProjects.length),
  ];
  if (sessionGoal) {
    const reasonText = sessionGoal.pauseReason ?? sessionGoal.completedReason;
    lines.push(
      strings.goalLine({
        status: sessionGoal.status,
        objective: truncateInline(sessionGoal.objective, 180),
        reason: reasonText ? truncateInline(reasonText, 120) : undefined,
      }),
    );
  }
  lines.push(strings.noProjectGuidance);
  return lines.join("\n");
}

function isActiveSparkTodoStatus(status: string): boolean {
  return status !== "done" && status !== "cancelled" && status !== "deleted";
}

export function renderSparkMdActiveExcerpt(
  markdown: string,
  readFullSuffix = "… (read SPARK.md for full intent)",
): string | undefined {
  return truncateSparkContextBlock(stripFinishedSparkMdSections(markdown), readFullSuffix);
}

function stripFinishedSparkMdSections(markdown: string): string {
  const lines = markdown.trim().split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = markdownLevelTwoHeading(line);
    if (heading) skipping = isFinishedSparkMdHeading(heading);
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}

function markdownLevelTwoHeading(line: string): string | undefined {
  if (!line.startsWith("##")) return undefined;
  if (line.startsWith("###")) return undefined;
  return line.slice(2).trim() || undefined;
}

function isFinishedSparkMdHeading(heading: string): boolean {
  const normalized = stripMarkdownHeadingMarkers(heading).toLowerCase();
  const zhPrefixes = ["修订记录", "变更记录", "历史", "完成", "已完成"];
  if (zhPrefixes.some((prefix) => normalized.startsWith(prefix))) return true;
  return [
    "revision history",
    "revision",
    "revisions",
    "changelog",
    "change log",
    "history",
    "completed",
    "finished",
    "done",
  ].some((prefix) => normalized === prefix || normalized.startsWith(prefix + " "));
}

function stripMarkdownHeadingMarkers(value: string): string {
  let output = "";
  for (const char of value)
    if (char !== "#" && char !== "*" && char !== "_" && char !== "`") output += char;
  return output.trim();
}

function truncateSparkContextBlock(value: string, readFullSuffix: string): string | undefined {
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
  return truncated ? `${text}\n${readFullSuffix}` : text;
}
