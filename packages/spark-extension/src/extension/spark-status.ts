import type { Task, TaskStatus, ProjectRef } from "@zendev-lab/pi-extension-api";
import {
  countPiTaskStatuses,
  formatPiTaskStatusCounts,
  isImportantPiTaskStatus,
  isUnfinishedTaskStatus,
  sortPiTasksForStatusVisibility,
  type TaskGraph,
} from "@zendev-lab/pi-tasks";
import { renderSparkProjectKindDisplay } from "./project-kind-registry.ts";
import { isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";

export type SparkStatusView = "active" | "summary";
export type SparkStatusFormat = "text" | "json";
export type SparkStatusScope = "workspace" | "project" | "task";
export function normalizeSparkStatusScope(params: Record<string, unknown>): SparkStatusScope {
  const value = params.scope;
  if (value === undefined || value === null) return "workspace";
  if (value === "workspace" || value === "project" || value === "task") return value;
  throw new Error("task_read status scope must be workspace, project, or task");
}

export function normalizeSparkStatusView(params: Record<string, unknown>): SparkStatusView {
  const value = params.view;
  if (value === undefined || value === null) return "active";
  if (value === "active" || value === "summary") return value;
  throw new Error("task_read status view must be active or summary");
}

export function normalizeSparkStatusFormat(params: Record<string, unknown>): SparkStatusFormat {
  const value = params.format;
  if (value === undefined || value === null) return "text";
  if (value === "text" || value === "json") return value;
  throw new Error("task_read status format must be text or json");
}

export function normalizeSparkStatusLimit(params: Record<string, unknown>): number | undefined {
  const value = params.limit;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("task_read status limit must be a finite number");
  if (!Number.isInteger(value) || value < 0)
    throw new Error("task_read status limit must be a non-negative integer");
  return value;
}

export function isImportantStatus(status: TaskStatus): boolean {
  return isImportantPiTaskStatus(status);
}

export function sortTasksForStatusVisibility(tasks: Task[]): Task[] {
  return sortPiTasksForStatusVisibility(tasks);
}

export function shouldRenderProjectInSparkStatus(input: {
  view: SparkStatusView;
  projectRef: ProjectRef;
  activeProjectRef?: ProjectRef;
  sessionClaimedCount: number;
}): boolean {
  if (input.view === "summary") return true;
  if (input.projectRef === input.activeProjectRef) return true;
  return input.sessionClaimedCount > 0;
}

export function countTaskStatuses(tasks: Task[]): Partial<Record<TaskStatus, number>> {
  return countPiTaskStatuses(tasks);
}

export function formatTaskStatusCounts(counts: Partial<Record<TaskStatus, number>>): string {
  return formatPiTaskStatusCounts(counts);
}

export function compactProjectSummaries(graph: TaskGraph, sessionKey: string) {
  return graph.projects().map((project) => {
    const tasks = graph.tasks(project.ref);
    const claimed = tasks.filter((task) => taskClaimedBy(task));
    const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, sessionKey));
    return {
      ref: project.ref,
      title: project.title,
      kind: project.kind ?? "generic",
      kindDisplay: renderSparkProjectKindDisplay(project),
      tasks: tasks.length,
      unfinished: tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length,
      claimed: claimed.length,
      claimedByCurrentSession: sessionClaimed.length,
      statusCounts: countTaskStatuses(tasks),
    };
  });
}
