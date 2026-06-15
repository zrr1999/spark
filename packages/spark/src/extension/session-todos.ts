import { join } from "node:path";

import { nowIso, type TaskRef } from "@zendev-lab/pi-extension-api";
import {
  isDeletedSessionTodo,
  type SessionTodoEntry,
  type SessionTodoStatus,
} from "@zendev-lab/pi-tasks";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  sanitizeStoreScope,
  sparkSessionKey,
  type SparkSessionContext,
} from "./session-identity.ts";

function independentTodoStorePath(cwd: string, ctx: SparkSessionContext | undefined): string {
  return join(cwd, ".spark", "session-todos", `${sanitizeStoreScope(sparkSessionKey(ctx))}.json`);
}

interface TodoDisplayNumberState {
  version: 1;
  next: number;
  numbers: Record<string, number>;
  changed?: boolean;
}

interface TodoDisplayNumberStoreSnapshot {
  version: 1;
  next: number;
  numbers: Record<string, number>;
}

function todoDisplayNumberStorePath(cwd: string, ctx: SparkSessionContext | undefined): string {
  return join(
    cwd,
    ".spark",
    "todo-display-numbers",
    `${sanitizeStoreScope(sparkSessionKey(ctx))}.json`,
  );
}

export async function loadTodoDisplayNumberState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<TodoDisplayNumberState> {
  const filePath = todoDisplayNumberStorePath(cwd, ctx);
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return { version: 1, next: 1, numbers: {} };
  assertTodoDisplayNumberStoreSnapshot(raw, filePath);
  const numbers: Record<string, number> = {};
  let max = 0;
  for (const [key, value] of Object.entries(raw.numbers)) {
    numbers[key] = value;
    max = Math.max(max, value);
  }
  if (raw.next <= max) {
    throw new JsonStoreFormatError(filePath, "next must be greater than every display number");
  }
  return { version: 1, next: raw.next, numbers };
}

export function assignTodoDisplayNumber(state: TodoDisplayNumberState, key: string): number {
  const existing = state.numbers[key];
  if (existing) return existing;
  const displayNumber = state.next;
  state.numbers[key] = displayNumber;
  state.next += 1;
  state.changed = true;
  return displayNumber;
}

export async function saveTodoDisplayNumberState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  state: TodoDisplayNumberState,
): Promise<void> {
  const filePath = todoDisplayNumberStorePath(cwd, ctx);
  const snapshot: TodoDisplayNumberStoreSnapshot = {
    version: 1,
    next: state.next,
    numbers: state.numbers,
  };
  assertTodoDisplayNumberStoreSnapshot(snapshot, filePath);
  await writeJsonFileAtomic(filePath, snapshot);
  state.changed = false;
}

function assertTodoDisplayNumberStoreSnapshot(
  value: unknown,
  filePath: string,
): asserts value is TodoDisplayNumberStoreSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonStoreFormatError(filePath, "JSON root must be an object");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== 1) {
    throw new JsonStoreFormatError(filePath, "version must be 1");
  }
  if (typeof snapshot.next !== "number" || !Number.isInteger(snapshot.next) || snapshot.next <= 0) {
    throw new JsonStoreFormatError(filePath, "next must be a positive integer");
  }
  if (
    !snapshot.numbers ||
    typeof snapshot.numbers !== "object" ||
    Array.isArray(snapshot.numbers)
  ) {
    throw new JsonStoreFormatError(filePath, "numbers must be an object");
  }
  for (const [key, value] of Object.entries(snapshot.numbers)) {
    if (!key.trim()) {
      throw new JsonStoreFormatError(filePath, "numbers keys must be non-empty strings");
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new JsonStoreFormatError(filePath, `numbers.${key} must be a positive integer`);
    }
  }
}

export function taskTodoDisplayKey(taskRef: TaskRef | string, todoId: string): string {
  return `task:${taskRef}:${todoId}`;
}

export async function loadIndependentTodos(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<SessionTodoEntry[]> {
  const filePath = independentTodoStorePath(cwd, ctx);
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return [];
  assertIndependentTodoStoreSnapshot(raw, filePath);
  return raw.todos;
}

export function visibleIndependentTodos(todos: SessionTodoEntry[]): SessionTodoEntry[] {
  return todos.filter((todo) => !isDeletedSessionTodo(todo));
}

export async function saveIndependentTodos(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  todos: SessionTodoEntry[],
): Promise<void> {
  await writeJsonFileAtomic(independentTodoStorePath(cwd, ctx), {
    version: 1,
    todos,
    updatedAt: nowIso(),
  });
}

interface IndependentTodoStoreSnapshot {
  version: 1;
  todos: SessionTodoEntry[];
  updatedAt?: string;
}

function assertIndependentTodoStoreSnapshot(
  value: unknown,
  filePath: string,
): asserts value is IndependentTodoStoreSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonStoreFormatError(filePath, "JSON root must be an object");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== 1) {
    throw new JsonStoreFormatError(filePath, "version must be 1");
  }
  if (!Array.isArray(snapshot.todos)) {
    throw new JsonStoreFormatError(filePath, "todos must be an array");
  }
  snapshot.todos.forEach((todo, index) => {
    assertIndependentTodoStoreEntry(todo, filePath, index);
  });
  if (snapshot.updatedAt !== undefined && typeof snapshot.updatedAt !== "string") {
    throw new JsonStoreFormatError(filePath, "updatedAt must be a string");
  }
}

function assertIndependentTodoStoreEntry(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is SessionTodoEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonStoreFormatError(filePath, `todos[${index}] must be an object`);
  }
  const todo = value as Partial<Record<keyof SessionTodoEntry, unknown>>;
  if (todo.id !== undefined && (typeof todo.id !== "string" || !todo.id.trim())) {
    throw new JsonStoreFormatError(filePath, `todos[${index}].id must be a non-empty string`);
  }
  if (typeof todo.content !== "string" || !todo.content.trim()) {
    throw new JsonStoreFormatError(filePath, `todos[${index}].content must be a non-empty string`);
  }
  if (!isSessionTodoStatus(todo.status)) {
    throw new JsonStoreFormatError(filePath, `todos[${index}].status must be a valid status`);
  }
  if (todo.displayNumber !== undefined) {
    const displayNumber = todo.displayNumber;
    if (
      typeof displayNumber !== "number" ||
      !Number.isInteger(displayNumber) ||
      displayNumber <= 0
    ) {
      throw new JsonStoreFormatError(
        filePath,
        `todos[${index}].displayNumber must be a positive integer`,
      );
    }
  }
  assertOptionalStringArray(todo.notes, filePath, `todos[${index}].notes`);
  assertOptionalStringArray(todo.blockedBy, filePath, `todos[${index}].blockedBy`);
  assertOptionalString(todo.createdAt, filePath, `todos[${index}].createdAt`);
  assertOptionalString(todo.updatedAt, filePath, `todos[${index}].updatedAt`);
  assertOptionalString(todo.deletedAt, filePath, `todos[${index}].deletedAt`);
}

function isSessionTodoStatus(value: unknown): value is SessionTodoStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "done" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "deleted"
  );
}

function assertOptionalStringArray(
  value: unknown,
  filePath: string,
  path: string,
): asserts value is string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new JsonStoreFormatError(filePath, `${path} must be a string array`);
  }
}

function assertOptionalString(value: unknown, filePath: string, path: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new JsonStoreFormatError(filePath, `${path} must be a string`);
  }
}
