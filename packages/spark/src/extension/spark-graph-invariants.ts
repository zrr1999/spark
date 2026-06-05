import type { ProjectRef } from "pi-extension-api";
import { isUnfinishedTaskStatus, type TaskGraph } from "pi-tasks";
import { normalizeProjectTitle } from "./spark-md-rendering.ts";

export function ensureSparkGraphInvariants(graph: TaskGraph): boolean {
  let changed = false;
  for (const project of graph.projects()) {
    const projectState = graph.getProject(project.ref);
    if (!projectState.status) {
      graph.updateProject(project.ref, { status: "active" });
      changed = true;
    }
    const betterTitle = fallbackProjectTitle(graph, projectState);
    if (betterTitle && betterTitle !== projectState.title) {
      graph.updateProject(project.ref, { title: betterTitle });
      changed = true;
    }
    if (!projectState.currentTaskRef) continue;
    if (graph.tasks(project.ref).some((task) => task.ref === projectState.currentTaskRef)) continue;
    graph.setCurrentTask(project.ref, undefined);
    changed = true;
  }
  return changed;
}

function fallbackProjectTitle(
  graph: TaskGraph,
  project: { title: string; ref: ProjectRef },
): string | undefined {
  if (!isPlaceholderProjectTitle(project.title)) return undefined;
  const firstConcrete = graph
    .tasks(project.ref)
    .find(
      (task) =>
        isUnfinishedTaskStatus(task.status) &&
        !isGenericInitialTaskTitle(task.title) &&
        !isPlaceholderProjectTitle(task.title),
    );
  if (firstConcrete) return normalizeProjectTitle(firstConcrete.title);
  return undefined;
}

export function isPlaceholderProjectTitle(title: string): boolean {
  const normalized = title.trim();
  const normalizedLower = normalized.toLowerCase();
  return (
    normalized === "「自定义输入」" ||
    normalized === "[Enter custom title]" ||
    normalized === "Enter custom title" ||
    normalized === "自定义输入" ||
    normalizedLower === "untitled" ||
    normalizedLower === "untitled spark project" ||
    normalizedLower === "spark project" ||
    normalizedLower === "new project" ||
    normalizedLower === "current project"
  );
}

export function isGenericInitialTaskTitle(title: string): boolean {
  const normalized = title.trim();
  const normalizedLower = normalized.toLowerCase();
  return (
    normalized === "Capture project intent" ||
    normalized === "Build initial task graph" ||
    normalized === "Analyze project intent" ||
    normalized === "Plan targeted clarification" ||
    normalized === "Review initial direction" ||
    normalizedLower === "current task" ||
    normalizedLower === "task" ||
    normalizedLower === "todo" ||
    normalizedLower === "implement task" ||
    normalizedLower === "do the task"
  );
}
