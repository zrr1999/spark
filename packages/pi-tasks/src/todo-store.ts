import { join } from "node:path";

import {
  readJsonFileOptional,
  writeJsonFileAtomic,
  type TaskTodo,
  type TaskTodoStatus,
} from "@zendev-lab/pi-extension-api";
import { TaskGraph } from "./graph.ts";
import type {
  LoadableTaskTodoStoreSnapshot,
  TaskTodoStoreEntry,
  TaskTodoStoreSnapshot,
} from "./common.ts";
import { cloneTodos, normalizeTodo } from "./internal.ts";

export class TaskTodoStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid task TODO store: ${filePath}: ${message}`);
    this.name = "TaskTodoStoreFormatError";
    this.filePath = filePath;
  }
}

export class TaskTodoStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async save(todos: TaskTodo[] | TaskGraph): Promise<void> {
    const snapshot: TaskTodoStoreSnapshot = {
      version: 1,
      todos: Array.isArray(todos) ? cloneTodos(todos) : todos.todoSnapshot(),
    };
    await writeJsonFileAtomic(this.filePath, snapshot);
  }

  async load(): Promise<TaskTodo[] | null> {
    const raw = await readJsonFileOptional(
      this.filePath,
      (path, message) => new TaskTodoStoreFormatError(path, message),
    );
    if (raw === undefined) return null;
    assertTaskTodoStoreSnapshot(raw, this.filePath);
    return (raw.todos ?? []).map(normalizeTodo);
  }

  async hydrate(graph: TaskGraph): Promise<boolean> {
    const todos = await this.load();
    if (!todos) return false;
    graph.hydrateTodos(todos);
    return true;
  }
}

/** @deprecated Compatibility default path for existing task TODO stores. Prefer explicit host-owned TaskTodoStore paths for new integrations. */
export function defaultTaskTodoStore(cwd: string, scope: string): TaskTodoStore {
  return new TaskTodoStore(join(cwd, ".spark", "todos", `${sanitizeTodoStoreScope(scope)}.json`));
}

function sanitizeTodoStoreScope(scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return safe || "default";
}

function assertTaskTodoStoreSnapshot(
  value: unknown,
  filePath: string,
): asserts value is LoadableTaskTodoStoreSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskTodoStoreFormatError(filePath, "JSON root must be an object");
  }
  const snapshot = value as { todos?: unknown; version?: unknown };
  if (snapshot.version !== 1) {
    throw new TaskTodoStoreFormatError(filePath, "version must be 1");
  }
  if (!Array.isArray(snapshot.todos)) {
    throw new TaskTodoStoreFormatError(filePath, "todos must be an array");
  }
  snapshot.todos.forEach((todo, index) => {
    assertTaskTodoStoreEntry(todo, filePath, index);
  });
}

function assertTaskTodoStoreEntry(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is TaskTodoStoreEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}] must be an object`);
  }
  const todo = value as Partial<Record<keyof TaskTodo, unknown>>;
  if (typeof todo.taskRef !== "string" || !todo.taskRef) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].taskRef must be a string`);
  }
  if (typeof todo.content !== "string" || !todo.content.trim()) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].content must be a string`);
  }
  if (!isTaskTodoStatus(todo.status)) {
    throw new TaskTodoStoreFormatError(
      filePath,
      `todos[${index}].status must be a valid TODO status`,
    );
  }
  if (todo.notes !== undefined && !isStringArray(todo.notes)) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].notes must be a string array`);
  }
  if (todo.blockedBy !== undefined && !isStringArray(todo.blockedBy)) {
    throw new TaskTodoStoreFormatError(
      filePath,
      `todos[${index}].blockedBy must be a string array`,
    );
  }
  if (todo.deletedAt !== undefined && typeof todo.deletedAt !== "string") {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].deletedAt must be a string`);
  }
}

function isTaskTodoStatus(value: unknown): value is TaskTodoStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "done" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "deleted"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
