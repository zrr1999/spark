import type { Task, TaskPlan } from "@zendev-lab/spark-extension-api";
import type { TaskGraph } from "@zendev-lab/spark-tasks";

const MAX_PLAN_ITEMS = 12;

export function taskPlanItemTitles(plan: TaskPlan | undefined): string[] {
  if (!plan) return [];
  const candidates = plan.items?.map((item) => item.title) ?? [];
  const items: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizePlanItemTitle(candidate);
    if (!normalized || !isConcretePlanItemTitle(normalized)) continue;
    if (items.includes(normalized)) continue;
    items.push(normalized);
    if (items.length >= MAX_PLAN_ITEMS) break;
  }
  return items;
}

export function syncTaskPlanItemsFromPlan(graph: TaskGraph, task: Task): string[] {
  const existing = new Set(graph.taskTodos(task.ref).map((todo) => todo.content));
  const missing = taskPlanItemTitles(task.plan).filter((item) => !existing.has(item));
  if (missing.length > 0) graph.applyTodoOps(task.ref, [{ op: "append", items: missing }]);
  return missing;
}

function normalizePlanItemTitle(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function isConcretePlanItemTitle(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized.length < 4) return false;
  if (
    normalized === "none" ||
    normalized === "n/a" ||
    normalized === "not applicable" ||
    normalized === "todo" ||
    normalized === "done"
  )
    return false;
  return true;
}
