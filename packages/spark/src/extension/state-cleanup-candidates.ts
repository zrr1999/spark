import { join, relative } from "node:path";

import type { Task, TaskRef, ProjectRef } from "spark-core";
import type { TaskGraph } from "spark-tasks";
import {
  fileScope,
  listSparkStateFiles,
  readJsonObject,
  type SparkStateFileInfo,
} from "./state-housekeeping-files.ts";
import {
  allTodosBelongToTerminalOrMissingTasks,
  isTerminalTodoStatus,
  todoStatus,
} from "./state-cache-todo-rules.ts";
import type {
  SparkStateCacheKind,
  SparkStateCleanupCandidate,
  SparkStateCleanupReason,
  SparkStateSessionScopes,
} from "./state-cache-types.ts";

export async function collectSparkStateCleanupCandidates(
  cwd: string,
  root: string,
  scopes: SparkStateSessionScopes,
  graph: TaskGraph,
  staleCutoffMs: number,
  includeBroken: boolean,
): Promise<SparkStateCleanupCandidate[]> {
  const projectByRef = new Map(graph.projects().map((project) => [project.ref, project]));
  const taskByRef = new Map(graph.tasks().map((task) => [task.ref, task]));
  return [
    ...(await currentProjectCleanupCandidates(
      cwd,
      root,
      scopes.currentOwnerScope,
      projectByRef,
      staleCutoffMs,
      includeBroken,
    )),
    ...(await taskTodoCleanupCandidates(
      cwd,
      root,
      scopes.currentSessionScope,
      taskByRef,
      staleCutoffMs,
      includeBroken,
    )),
    ...(await sessionTodoCleanupCandidates(
      cwd,
      root,
      scopes.currentSessionScope,
      staleCutoffMs,
      includeBroken,
    )),
    ...(await todoDisplayNumberCleanupCandidates(
      cwd,
      root,
      scopes.currentSessionScope,
      staleCutoffMs,
      includeBroken,
    )),
  ];
}

async function currentProjectCleanupCandidates(
  cwd: string,
  root: string,
  currentOwnerScope: string,
  projectByRef: Map<ProjectRef, ReturnType<TaskGraph["projects"]>[number]>,
  staleCutoffMs: number,
  includeBroken: boolean,
): Promise<SparkStateCleanupCandidate[]> {
  const candidates: SparkStateCleanupCandidate[] = [];
  for (const file of await listSparkStateFiles(join(root, "sessions"))) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentOwnerScope;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      if (includeBroken)
        candidates.push(cleanupCandidate(cwd, file, "sessions", "broken-json", stale));
      continue;
    }
    const projectRef =
      typeof raw.projectRef === "string" ? (raw.projectRef as ProjectRef) : undefined;
    const project = projectRef ? projectByRef.get(projectRef) : undefined;
    if (!project)
      candidates.push(cleanupCandidate(cwd, file, "sessions", "missing-project", stale));
    else if (project.status === "done")
      candidates.push(cleanupCandidate(cwd, file, "sessions", "done-project", stale));
    else if (stale)
      candidates.push(cleanupCandidate(cwd, file, "sessions", "stale-sessions", stale));
  }
  return candidates;
}

async function taskTodoCleanupCandidates(
  cwd: string,
  root: string,
  currentSessionScope: string,
  taskByRef: Map<TaskRef, Task>,
  staleCutoffMs: number,
  includeBroken: boolean,
): Promise<SparkStateCleanupCandidate[]> {
  const candidates: SparkStateCleanupCandidate[] = [];
  for (const file of await listSparkStateFiles(join(root, "todos"))) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      if (includeBroken)
        candidates.push(cleanupCandidate(cwd, file, "task-todos", "broken-json", stale));
      continue;
    }
    const todos = Array.isArray(raw.todos) ? raw.todos : [];
    const allTerminalTodos = todos.every((todo) => isTerminalTodoStatus(todoStatus(todo)));
    const allTasksTerminalOrMissing = allTodosBelongToTerminalOrMissingTasks(todos, taskByRef);
    if (fileScope(file) === currentSessionScope) continue;
    if (todos.length === 0)
      candidates.push(cleanupCandidate(cwd, file, "task-todos", "empty-task-todos", stale));
    else if (stale && allTerminalTodos && allTasksTerminalOrMissing)
      candidates.push(
        cleanupCandidate(cwd, file, "task-todos", "stale-terminal-task-todos", stale),
      );
  }
  return candidates;
}

async function sessionTodoCleanupCandidates(
  cwd: string,
  root: string,
  currentSessionScope: string,
  staleCutoffMs: number,
  includeBroken: boolean,
): Promise<SparkStateCleanupCandidate[]> {
  const candidates: SparkStateCleanupCandidate[] = [];
  for (const file of await listSparkStateFiles(join(root, "session-todos"))) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      if (includeBroken)
        candidates.push(cleanupCandidate(cwd, file, "session-todos", "broken-json", stale));
      continue;
    }
    const todos = Array.isArray(raw.todos) ? raw.todos : [];
    const allTerminalTodos = todos.every((todo) => isTerminalTodoStatus(todoStatus(todo)));
    if (fileScope(file) === currentSessionScope) continue;
    if (todos.length === 0)
      candidates.push(cleanupCandidate(cwd, file, "session-todos", "empty-session-todos", stale));
    else if (stale && allTerminalTodos)
      candidates.push(
        cleanupCandidate(cwd, file, "session-todos", "stale-terminal-session-todos", stale),
      );
  }
  return candidates;
}

async function todoDisplayNumberCleanupCandidates(
  cwd: string,
  root: string,
  currentSessionScope: string,
  staleCutoffMs: number,
  includeBroken: boolean,
): Promise<SparkStateCleanupCandidate[]> {
  const candidates: SparkStateCleanupCandidate[] = [];
  for (const file of await listSparkStateFiles(join(root, "todo-display-numbers"))) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      if (includeBroken)
        candidates.push(cleanupCandidate(cwd, file, "todo-display-numbers", "broken-json", stale));
      continue;
    }
    if (stale)
      candidates.push(
        cleanupCandidate(cwd, file, "todo-display-numbers", "stale-display-numbers", stale),
      );
  }
  return candidates;
}

function cleanupCandidate(
  cwd: string,
  file: SparkStateFileInfo,
  kind: SparkStateCacheKind,
  reason: SparkStateCleanupReason,
  stale: boolean,
): SparkStateCleanupCandidate {
  return { path: relative(cwd, file.path), kind, reason, bytes: file.bytes, stale };
}
