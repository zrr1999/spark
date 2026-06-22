import { basename, dirname, join, relative } from "node:path";

import type { Task, TaskRef, ProjectRef } from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  fileScope,
  listSparkStateFiles,
  readJsonObject,
  type SparkStateFileInfo,
} from "./state-housekeeping-files.ts";
import {
  allTodosBelongToTerminalOrMissingTasks,
  isActiveTodoStatus,
  isTerminalTodoStatus,
  todoStatus,
} from "./state-cache-todo-rules.ts";
import type {
  SparkProtectedStoreReason,
  SparkProtectedStoreSummary,
  SparkStateCacheKind,
  SparkStateCacheSummary,
  SparkStateSessionScopes,
} from "./state-cache-types.ts";

export async function collectSparkStateCacheSummaries(
  root: string,
  scopes: SparkStateSessionScopes,
  graph: TaskGraph,
  staleCutoffMs: number,
): Promise<SparkStateCacheSummary[]> {
  const projectByRef = new Map(graph.projects().map((project) => [project.ref, project]));
  const taskByRef = new Map(graph.tasks().map((task) => [task.ref, task]));
  return [
    await summarizeCurrentProjectCache(root, scopes.currentOwnerScope, projectByRef, staleCutoffMs),
    await summarizeTaskTodoCache(root, scopes.currentSessionScope, taskByRef, staleCutoffMs),
    await summarizeSessionTodoCache(root, scopes.currentSessionScope, staleCutoffMs),
    await summarizeTodoDisplayNumberCache(root, scopes.currentSessionScope, staleCutoffMs),
    await summarizeLegacyTaskTodoCache(root),
  ];
}

export async function collectSparkProtectedStoreSummaries(
  root: string,
): Promise<SparkProtectedStoreSummary[]> {
  return [
    await summarizeProtectedSparkStore(root, "projects", "task-graph", true),
    await summarizeProtectedSparkStore(root, join("todos", "todos.sqlite"), "todo-records", false),
    await summarizeProtectedSparkStore(root, "sessions", "session-state", true),
    await summarizeProtectedSparkStore(root, "artifacts", "artifact-history", true),
    await summarizeProtectedSparkStore(root, "notes", "notes", true),
    await summarizeProtectedSparkStore(root, "role-reports", "role-reports", true),
    await summarizeProtectedSparkStore(root, "workflow-runs.json", "workflow-runs", false),
    await summarizeProtectedSparkStore(
      root,
      "dynamic-workflow-runs.json",
      "dynamic-workflow-runs",
      false,
    ),
    await summarizeProtectedSparkStore(root, "reviews", "reviews", true),
  ];
}

async function summarizeCurrentProjectCache(
  root: string,
  currentOwnerScope: string,
  projectByRef: Map<ProjectRef, ReturnType<TaskGraph["projects"]>[number]>,
  staleCutoffMs: number,
): Promise<SparkStateCacheSummary> {
  const sessionsRoot = join(root, "sessions");
  const files = (await listSparkStateFiles(sessionsRoot, true)).filter((file) =>
    isCurrentProjectStateCacheFile(sessionsRoot, file),
  );
  let staleFiles = 0;
  let brokenFiles = 0;
  let safeToDeleteFiles = 0;
  let activeFiles = 0;
  for (const file of files) {
    const stale = file.mtimeMs < staleCutoffMs && sessionStateFileScope(file) !== currentOwnerScope;
    if (stale) staleFiles += 1;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      brokenFiles += 1;
      continue;
    }
    const projectRef =
      typeof raw.projectRef === "string" ? (raw.projectRef as ProjectRef) : undefined;
    const project = projectRef ? projectByRef.get(projectRef) : undefined;
    const safe = !project || stale;
    if (safe) safeToDeleteFiles += 1;
    else activeFiles += 1;
  }
  return cacheSummary(root, "sessions", "sessions", files, {
    staleFiles,
    brokenFiles,
    safeToDeleteFiles,
    activeFiles,
  });
}

function isCurrentProjectStateCacheFile(sessionsRoot: string, file: SparkStateFileInfo): boolean {
  const relativePath = relative(sessionsRoot, file.path);
  const segments = relativePath.split(/[\\/]/u);
  if (segments.length === 1) return file.name.endsWith(".json") && file.name !== "index.json";
  return segments.length === 2 && file.name === "state.json";
}

function sessionStateFileScope(file: SparkStateFileInfo): string {
  return file.name === "state.json" ? basename(dirname(file.path)) : fileScope(file);
}

async function summarizeTaskTodoCache(
  root: string,
  currentSessionScope: string,
  taskByRef: Map<TaskRef, Task>,
  staleCutoffMs: number,
): Promise<SparkStateCacheSummary> {
  const files = (await listSparkStateFiles(join(root, "todos"))).filter((file) =>
    file.name.endsWith(".json"),
  );
  let staleFiles = 0;
  let brokenFiles = 0;
  let safeToDeleteFiles = 0;
  let activeFiles = 0;
  for (const file of files) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    if (stale) staleFiles += 1;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      brokenFiles += 1;
      continue;
    }
    const todos = Array.isArray(raw.todos) ? raw.todos : [];
    const hasActiveTodo = todos.some((todo) => isActiveTodoStatus(todoStatus(todo)));
    const allTerminalTodos = todos.every((todo) => isTerminalTodoStatus(todoStatus(todo)));
    const allTasksTerminalOrMissing = allTodosBelongToTerminalOrMissingTasks(todos, taskByRef);
    if (hasActiveTodo) activeFiles += 1;
    if (todos.length === 0 || (stale && allTerminalTodos && allTasksTerminalOrMissing))
      safeToDeleteFiles += 1;
  }
  return cacheSummary(root, "todos", "task-todos", files, {
    staleFiles,
    brokenFiles,
    safeToDeleteFiles,
    activeFiles,
  });
}

async function summarizeSessionTodoCache(
  root: string,
  currentSessionScope: string,
  staleCutoffMs: number,
): Promise<SparkStateCacheSummary> {
  const files = await listSparkStateFiles(join(root, "session-todos"));
  let staleFiles = 0;
  let brokenFiles = 0;
  let safeToDeleteFiles = 0;
  let activeFiles = 0;
  for (const file of files) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    if (stale) staleFiles += 1;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      brokenFiles += 1;
      continue;
    }
    const todos = Array.isArray(raw.todos) ? raw.todos : [];
    const hasActiveTodo = todos.some((todo) => isActiveTodoStatus(todoStatus(todo)));
    const allTerminalTodos = todos.every((todo) => isTerminalTodoStatus(todoStatus(todo)));
    if (hasActiveTodo) activeFiles += 1;
    if (todos.length === 0 || (stale && allTerminalTodos)) safeToDeleteFiles += 1;
  }
  return cacheSummary(root, "session-todos", "session-todos", files, {
    staleFiles,
    brokenFiles,
    safeToDeleteFiles,
    activeFiles,
  });
}

async function summarizeTodoDisplayNumberCache(
  root: string,
  currentSessionScope: string,
  staleCutoffMs: number,
): Promise<SparkStateCacheSummary> {
  const files = await listSparkStateFiles(join(root, "todo-display-numbers"));
  let staleFiles = 0;
  let brokenFiles = 0;
  let safeToDeleteFiles = 0;
  let activeFiles = 0;
  for (const file of files) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    if (stale) staleFiles += 1;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      brokenFiles += 1;
      continue;
    }
    if (stale) safeToDeleteFiles += 1;
    else activeFiles += 1;
  }
  return cacheSummary(root, "todo-display-numbers", "todo-display-numbers", files, {
    staleFiles,
    brokenFiles,
    safeToDeleteFiles,
    activeFiles,
  });
}

async function summarizeLegacyTaskTodoCache(root: string): Promise<SparkStateCacheSummary> {
  const files = await listSparkStateFiles(root);
  const legacyFiles = files.filter((file) => file.name === "todos.json");
  return cacheSummary(root, "todos.json", "legacy-task-todos", legacyFiles, {
    staleFiles: 0,
    brokenFiles: 0,
    safeToDeleteFiles: 0,
    activeFiles: legacyFiles.length,
  });
}

async function summarizeProtectedSparkStore(
  root: string,
  child: string,
  reason: SparkProtectedStoreReason,
  recursive: boolean,
): Promise<SparkProtectedStoreSummary> {
  const files = await listSparkStateFiles(join(root, child), recursive);
  return {
    path: join(relative(dirname(root), root), child),
    reason,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function cacheSummary(
  root: string,
  child: string,
  kind: SparkStateCacheKind,
  files: SparkStateFileInfo[],
  counts: Omit<SparkStateCacheSummary, "path" | "kind" | "files" | "bytes">,
): SparkStateCacheSummary {
  return {
    path: join(relative(dirname(root), root), child),
    kind,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    ...counts,
  };
}
