import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  nowIso,
  readJsonFileOptional,
  stableId,
  type ProjectRef,
  type TaskRef,
  type TaskTodo,
  type TaskTodoStatus,
} from "@zendev-lab/pi-extension-api";
import { TaskGraph } from "./graph.ts";
import type {
  LoadableTaskTodoStoreSnapshot,
  SessionTodoEntry,
  TaskTodoStoreEntry,
} from "./common.ts";
import { cloneTodos, normalizeTodo } from "./internal.ts";

export type TodoRecordOwnerKind = "task" | "session";

export interface TaskTodoLegacyImportResult {
  found: boolean;
  imported: number;
}

interface TaskTodoRowInput {
  ownerKind: TodoRecordOwnerKind;
  ownerRef: string;
  projectRef?: ProjectRef;
  taskRef?: TaskRef;
  id: string;
  content: string;
  status: TaskTodoStatus;
  notes?: string[];
  blockedBy?: string[];
  displayNumber?: number;
  position?: number;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;
}

interface TodoItemRow {
  id: string;
  owner_kind: TodoRecordOwnerKind;
  owner_ref: string;
  project_ref: string | null;
  task_ref: string | null;
  content: string;
  status: TaskTodoStatus;
  notes_json: string;
  blocked_by_json: string;
  display_number: number | null;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export class TaskTodoStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid task plan-item compatibility store: ${filePath}: ${message}`);
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
    if (!Array.isArray(todos)) return;
    const rows = cloneTodos(todos).map((todo, index) =>
      taskTodoRowInput(todo, { position: index }),
    );
    const db = await this.openRequiredDatabase();
    try {
      writeTransaction(db, () => {
        db.prepare("DELETE FROM todo_items WHERE owner_kind = 'task'").run();
        for (const row of rows) insertTodoRow(db, row, "insert");
      });
    } finally {
      db.close();
    }
  }

  async load(): Promise<TaskTodo[] | null> {
    const db = await this.openDatabase({ create: false });
    if (!db) return null;
    try {
      return db
        .prepare(
          `SELECT * FROM todo_items
           WHERE owner_kind = 'task'
           ORDER BY project_ref, task_ref, position, created_at, id`,
        )
        .all()
        .map((row) => rowToTaskTodo(row, this.filePath));
    } finally {
      db.close();
    }
  }

  async hydrate(graph: TaskGraph): Promise<boolean> {
    const todos = await this.load();
    if (!todos) return false;
    graph.hydrateTodos(todos);
    return true;
  }

  async saveSessionTodos(
    ownerRef: string,
    todos: SessionTodoEntry[],
    options: { projectRef?: ProjectRef } = {},
  ): Promise<void> {
    const normalizedOwnerRef = normalizeOwnerRef(ownerRef);
    const rows = todos.map((todo, index) =>
      sessionTodoRowInput(normalizedOwnerRef, todo, index, options),
    );
    const db = await this.openRequiredDatabase();
    try {
      writeTransaction(db, () => {
        db.prepare("DELETE FROM todo_items WHERE owner_kind = 'session' AND owner_ref = ?").run(
          normalizedOwnerRef,
        );
        for (const row of rows) insertTodoRow(db, row, "insert");
      });
    } finally {
      db.close();
    }
  }

  async loadSessionTodos(ownerRef: string): Promise<SessionTodoEntry[]> {
    const normalizedOwnerRef = normalizeOwnerRef(ownerRef);
    const db = await this.openDatabase({ create: false });
    if (!db) return [];
    try {
      return db
        .prepare(
          `SELECT * FROM todo_items
           WHERE owner_kind = 'session' AND owner_ref = ?
           ORDER BY position, display_number, created_at, id`,
        )
        .all(normalizedOwnerRef)
        .map((row) => rowToSessionTodo(row, this.filePath));
    } finally {
      db.close();
    }
  }

  async importLegacyTaskTodoFile(filePath: string): Promise<TaskTodoLegacyImportResult> {
    const raw = await readJsonFileOptional(
      filePath,
      (path, message) => new TaskTodoStoreFormatError(path, message),
    );
    if (raw === undefined) return { found: false, imported: 0 };
    assertTaskTodoStoreSnapshot(raw, filePath);
    const todos = raw.todos.map(normalizeTodo);
    const db = await this.openRequiredDatabase();
    try {
      writeTransaction(db, () => {
        for (const [index, todo] of todos.entries())
          insertTodoRow(db, taskTodoRowInput(todo, { position: index }), "upsert");
      });
    } finally {
      db.close();
    }
    return { found: true, imported: todos.length };
  }

  async importLegacySessionTodoFile(
    ownerRef: string,
    filePath: string,
    options: { projectRef?: ProjectRef } = {},
  ): Promise<TaskTodoLegacyImportResult> {
    const raw = await readJsonFileOptional(
      filePath,
      (path, message) => new TaskTodoStoreFormatError(path, message),
    );
    if (raw === undefined) return { found: false, imported: 0 };
    assertSessionTodoStoreSnapshot(raw, filePath);
    const normalizedOwnerRef = normalizeOwnerRef(ownerRef);
    const rows = raw.todos.map((todo, index) =>
      sessionTodoRowInput(normalizedOwnerRef, todo, index, options),
    );
    const db = await this.openRequiredDatabase();
    try {
      writeTransaction(db, () => {
        for (const row of rows) insertTodoRow(db, row, "upsert");
      });
    } finally {
      db.close();
    }
    return { found: true, imported: rows.length };
  }

  private async openDatabase(options: { create: boolean }): Promise<DatabaseSync | null> {
    if (!options.create && !(await pathExists(this.filePath))) return null;
    if (options.create) await ensureDatabaseParent(this.filePath);
    const db = new DatabaseSync(this.filePath);
    try {
      ensureTodoSchema(db);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private async openRequiredDatabase(): Promise<DatabaseSync> {
    const db = await this.openDatabase({ create: true });
    if (!db) throw new Error("failed to open TODO SQLite store");
    return db;
  }
}

export function defaultTaskTodoStore(cwd: string, _scope?: string): TaskTodoStore {
  return new TaskTodoStore(join(cwd, ".spark", "todos", "todos.sqlite"));
}

function taskTodoRowInput(
  todo: TaskTodo,
  options: { projectRef?: ProjectRef; position?: number } = {},
): TaskTodoRowInput {
  const normalized = normalizeTodo(todo);
  return {
    ownerKind: "task",
    ownerRef: normalized.taskRef,
    projectRef: options.projectRef,
    taskRef: normalized.taskRef,
    id: normalized.id,
    content: normalized.content,
    status: normalized.status,
    notes: normalized.notes,
    blockedBy: normalized.blockedBy,
    position: options.position,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    deletedAt: normalized.deletedAt,
  };
}

function sessionTodoRowInput(
  ownerRef: string,
  todo: SessionTodoEntry,
  index: number,
  options: { projectRef?: ProjectRef } = {},
): TaskTodoRowInput {
  const content = normalizeContent(todo.content);
  const now = nowIso();
  const id = todo.id?.trim() || `todo-${stableId(`${ownerRef}:${index}:${content}`).slice(0, 12)}`;
  return {
    ownerKind: "session",
    ownerRef,
    projectRef: options.projectRef,
    id,
    content,
    status: normalizeTaskTodoStatus(todo.status, "session todo status"),
    notes: normalizeOptionalStringArray(todo.notes, "session todo notes"),
    blockedBy: normalizeOptionalStringArray(todo.blockedBy, "session todo blockedBy"),
    displayNumber: normalizeOptionalPositiveInteger(
      todo.displayNumber,
      "session todo displayNumber",
    ),
    position: index,
    createdAt: todo.createdAt ?? now,
    updatedAt: todo.updatedAt ?? todo.createdAt ?? now,
    deletedAt: todo.deletedAt,
  };
}

function insertTodoRow(db: DatabaseSync, row: TaskTodoRowInput, mode: "insert" | "upsert"): void {
  const conflictClause =
    mode === "upsert"
      ? ` ON CONFLICT(owner_kind, owner_ref, id) DO UPDATE SET
          project_ref = excluded.project_ref,
          task_ref = excluded.task_ref,
          content = excluded.content,
          status = excluded.status,
          notes_json = excluded.notes_json,
          blocked_by_json = excluded.blocked_by_json,
          display_number = excluded.display_number,
          position = excluded.position,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at`
      : "";
  db.prepare(
    `INSERT INTO todo_items
      (id, owner_kind, owner_ref, project_ref, task_ref, content, status,
       notes_json, blocked_by_json, display_number, position, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${conflictClause}`,
  ).run(
    row.id,
    row.ownerKind,
    row.ownerRef,
    row.projectRef ?? null,
    row.taskRef ?? null,
    normalizeContent(row.content),
    normalizeTaskTodoStatus(row.status, "todo status"),
    JSON.stringify(row.notes ?? []),
    JSON.stringify(row.blockedBy ?? []),
    row.displayNumber ?? null,
    row.position ?? 0,
    row.createdAt ?? nowIso(),
    row.updatedAt ?? row.createdAt ?? nowIso(),
    row.deletedAt ?? null,
  );
}

function rowToTaskTodo(row: unknown, filePath: string): TaskTodo {
  const item = normalizeTodoItemRow(row, filePath);
  if (item.owner_kind !== "task" || !item.task_ref) {
    throw new TaskTodoStoreFormatError(
      filePath,
      "task plan-item row must have owner_kind=task and task_ref",
    );
  }
  return normalizeTodo({
    id: item.id,
    taskRef: item.task_ref as TaskRef,
    content: item.content,
    status: item.status,
    notes: parseStringArrayJson(item.notes_json, filePath, `${item.id}.notes_json`),
    blockedBy: parseStringArrayJson(item.blocked_by_json, filePath, `${item.id}.blocked_by_json`),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    deletedAt: item.deleted_at ?? undefined,
  });
}

function rowToSessionTodo(row: unknown, filePath: string): SessionTodoEntry {
  const item = normalizeTodoItemRow(row, filePath);
  if (item.owner_kind !== "session" || item.task_ref !== null) {
    throw new TaskTodoStoreFormatError(
      filePath,
      "session-owned row must have owner_kind=session and no task_ref",
    );
  }
  const notes = parseStringArrayJson(item.notes_json, filePath, `${item.id}.notes_json`);
  const blockedBy = parseStringArrayJson(
    item.blocked_by_json,
    filePath,
    `${item.id}.blocked_by_json`,
  );
  const todo: SessionTodoEntry = {
    id: item.id,
    content: item.content,
    status: item.status,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
  if (item.display_number !== null) todo.displayNumber = item.display_number;
  if (notes) todo.notes = notes;
  if (blockedBy) todo.blockedBy = blockedBy;
  if (item.deleted_at !== null) todo.deletedAt = item.deleted_at;
  return todo;
}

function normalizeTodoItemRow(row: unknown, filePath: string): TodoItemRow {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TaskTodoStoreFormatError(filePath, "todo_items row must be an object");
  }
  const value = row as Record<string, unknown>;
  const ownerKind = value.owner_kind;
  if (ownerKind !== "task" && ownerKind !== "session") {
    throw new TaskTodoStoreFormatError(filePath, "todo_items.owner_kind must be task or session");
  }
  return {
    id: stringField(value.id, filePath, "todo_items.id"),
    owner_kind: ownerKind,
    owner_ref: stringField(value.owner_ref, filePath, "todo_items.owner_ref"),
    project_ref: nullableStringField(value.project_ref, filePath, "todo_items.project_ref"),
    task_ref: nullableStringField(value.task_ref, filePath, "todo_items.task_ref"),
    content: stringField(value.content, filePath, "todo_items.content"),
    status: normalizeTaskTodoStatus(value.status, "todo_items.status"),
    notes_json: stringField(value.notes_json, filePath, "todo_items.notes_json"),
    blocked_by_json: stringField(value.blocked_by_json, filePath, "todo_items.blocked_by_json"),
    display_number: nullableNumberField(
      value.display_number,
      filePath,
      "todo_items.display_number",
    ),
    position: numberField(value.position, filePath, "todo_items.position"),
    created_at: stringField(value.created_at, filePath, "todo_items.created_at"),
    updated_at: stringField(value.updated_at, filePath, "todo_items.updated_at"),
    deleted_at: nullableStringField(value.deleted_at, filePath, "todo_items.deleted_at"),
  };
}

function ensureTodoSchema(db: DatabaseSync): void {
  db.exec(TODO_SQLITE_SCHEMA);
}

function writeTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function ensureDatabaseParent(filePath: string): Promise<void> {
  if (filePath === ":memory:") return;
  await mkdir(dirname(filePath), { recursive: true });
}

async function pathExists(filePath: string): Promise<boolean> {
  if (filePath === ":memory:") return true;
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeOwnerRef(value: string): string {
  const ownerRef = value.trim();
  if (!ownerRef) throw new Error("todo ownerRef must not be empty");
  return ownerRef;
}

function normalizeContent(value: string): string {
  const content = value.trim();
  if (!content) throw new Error("todo content is required");
  return content;
}

function normalizeTaskTodoStatus(value: unknown, label: string): TaskTodoStatus {
  if (isTaskTodoStatus(value)) return value;
  throw new Error(`${label} must be a valid TODO status`);
}

function normalizeOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value];
}

function normalizeOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function stringField(value: unknown, filePath: string, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new TaskTodoStoreFormatError(filePath, `${label} must be a string`);
  }
  return value;
}

function nullableStringField(value: unknown, filePath: string, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TaskTodoStoreFormatError(filePath, `${label} must be a string or null`);
  }
  return value;
}

function nullableNumberField(value: unknown, filePath: string, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number") {
    throw new TaskTodoStoreFormatError(filePath, `${label} must be a number or null`);
  }
  return value;
}

function numberField(value: unknown, filePath: string, label: string): number {
  if (typeof value !== "number") {
    throw new TaskTodoStoreFormatError(filePath, `${label} must be a number`);
  }
  return value;
}

function parseStringArrayJson(
  value: string,
  filePath: string,
  label: string,
): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TaskTodoStoreFormatError(
      filePath,
      `${label} must be JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new TaskTodoStoreFormatError(filePath, `${label} must be a string array`);
  }
  return parsed.length ? parsed : undefined;
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

interface LegacySessionTodoStoreSnapshot {
  version: 1;
  todos: SessionTodoEntry[];
}

function assertSessionTodoStoreSnapshot(
  value: unknown,
  filePath: string,
): asserts value is LegacySessionTodoStoreSnapshot {
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
  snapshot.todos.forEach((todo, index) => assertSessionTodoStoreEntry(todo, filePath, index));
}

function assertSessionTodoStoreEntry(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is SessionTodoEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}] must be an object`);
  }
  const todo = value as Partial<Record<keyof SessionTodoEntry, unknown>>;
  if (todo.id !== undefined && (typeof todo.id !== "string" || !todo.id.trim())) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].id must be a non-empty string`);
  }
  if (typeof todo.content !== "string" || !todo.content.trim()) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].content must be a string`);
  }
  if (!isTaskTodoStatus(todo.status)) {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].status must be a valid status`);
  }
  if (todo.displayNumber !== undefined) {
    normalizeOptionalPositiveInteger(todo.displayNumber, `todos[${index}].displayNumber`);
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
  if (todo.createdAt !== undefined && typeof todo.createdAt !== "string") {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].createdAt must be a string`);
  }
  if (todo.updatedAt !== undefined && typeof todo.updatedAt !== "string") {
    throw new TaskTodoStoreFormatError(filePath, `todos[${index}].updatedAt must be a string`);
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

const TODO_SQLITE_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO schema_meta (key, value)
VALUES ('spark_store_v2_todo_schema_version', '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('task', 'session')),
  owner_ref TEXT NOT NULL,
  project_ref TEXT,
  task_ref TEXT,
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'blocked', 'cancelled', 'deleted')),
  notes_json TEXT NOT NULL DEFAULT '[]',
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  display_number INTEGER CHECK (display_number IS NULL OR display_number > 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (owner_kind, owner_ref, id),
  CHECK (
    (owner_kind = 'task' AND task_ref = owner_ref) OR
    (owner_kind = 'session' AND task_ref IS NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_todo_items_owner_status
  ON todo_items (owner_kind, owner_ref, status);

CREATE INDEX IF NOT EXISTS idx_todo_items_task_status
  ON todo_items (task_ref, status);

CREATE INDEX IF NOT EXISTS idx_todo_items_project_status
  ON todo_items (project_ref, status);

CREATE INDEX IF NOT EXISTS idx_todo_items_updated_at
  ON todo_items (updated_at);
`;
