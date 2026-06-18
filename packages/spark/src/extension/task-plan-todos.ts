import type { Task, TaskPlan } from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";

const MAX_PLAN_TODO_ITEMS = 12;

export function taskPlanTodoItems(plan: TaskPlan | undefined): string[] {
  if (!plan) return [];
  const candidates = [...plan.steps, ...plan.successCriteria];
  const items: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizePlanTodoItem(candidate);
    if (!normalized || !isConcretePlanTodoItem(normalized)) continue;
    if (items.includes(normalized)) continue;
    items.push(normalized);
    if (items.length >= MAX_PLAN_TODO_ITEMS) break;
  }
  return items;
}

export function syncTaskTodosFromPlan(graph: TaskGraph, task: Task): string[] {
  const existing = new Set(graph.taskTodos(task.ref).map((todo) => todo.content));
  const missing = taskPlanTodoItems(task.plan).filter((item) => !existing.has(item));
  if (missing.length > 0) graph.applyTodoOps(task.ref, [{ op: "append", items: missing }]);
  return missing;
}

function normalizePlanTodoItem(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function isConcretePlanTodoItem(value: string): boolean {
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
