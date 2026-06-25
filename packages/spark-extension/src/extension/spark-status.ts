import type { Task, TaskStatus, ProjectRef } from "@zendev-lab/pi-extension-api";
import { isUnfinishedTaskStatus, type TaskGraph } from "@zendev-lab/pi-tasks";
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
  return status !== "done" && status !== "cancelled";
}

export function sortTasksForStatusVisibility(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const byStatus = taskStatusVisibilityRank(a.status) - taskStatusVisibilityRank(b.status);
    if (byStatus !== 0) return byStatus;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
}

function taskStatusVisibilityRank(status: TaskStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "blocked":
      return 1;
    case "ready":
    case "pending":
      return 2;
    case "failed":
      return 3;
    case "done":
      return 4;
    case "cancelled":
      return 5;
  }
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
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

export function formatTaskStatusCounts(counts: Partial<Record<TaskStatus, number>>): string {
  const order: TaskStatus[] = [
    "running",
    "blocked",
    "pending",
    "ready",
    "failed",
    "done",
    "cancelled",
  ];
  const parts = order.flatMap((status) => {
    const count = counts[status] ?? 0;
    return count > 0 ? [`${status}=${count}`] : [];
  });
  return parts.length > 0 ? parts.join(" ") : "none";
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
