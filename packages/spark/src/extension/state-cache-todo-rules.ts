import type { Task, TaskRef } from "pi-extension-api";
import { isUnfinishedTaskStatus } from "pi-tasks";

export function todoStatus(todo: unknown): string | undefined {
  return todo && typeof todo === "object" && "status" in todo
    ? String((todo as { status?: unknown }).status)
    : undefined;
}

export function todoTaskRef(todo: unknown): TaskRef | undefined {
  return todo &&
    typeof todo === "object" &&
    typeof (todo as { taskRef?: unknown }).taskRef === "string"
    ? ((todo as { taskRef: string }).taskRef as TaskRef)
    : undefined;
}

export function isActiveTodoStatus(status: string | undefined): boolean {
  return status === "pending" || status === "in_progress" || status === "blocked";
}

export function isTerminalTodoStatus(status: string | undefined): boolean {
  return status === "done" || status === "cancelled" || status === "deleted";
}

export function allTodosBelongToTerminalOrMissingTasks(
  todos: unknown[],
  taskByRef: Map<TaskRef, Task>,
): boolean {
  return todos.every((todo) => {
    const taskRef = todoTaskRef(todo);
    const task = taskRef ? taskByRef.get(taskRef) : undefined;
    return !task || !isUnfinishedTaskStatus(task.status);
  });
}
