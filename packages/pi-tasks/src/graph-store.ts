import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  formatJsonFile,
  isFileNotFoundError,
  nowIso,
  parseJsonFileText,
  stableId,
  writeJsonFileAtomic,
  type Project,
  type ProjectRef,
  type ProjectRoadmap,
  type Task,
  type TaskDependency,
  type TaskRef,
  type TaskRun,
} from "@zendev-lab/pi-extension-api";
import { TaskGraph } from "./graph.ts";
import type {
  TaskGraphSnapshot,
  TaskGraphStoreLockOptions,
  TaskGraphStoreUpdateOptions,
} from "./common.ts";

export interface TaskGraphStoreUpdateResult<T> {
  graph: TaskGraph | null;
  result: T;
}

export class TaskGraphStoreConflictError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`task graph changed since it was loaded: ${filePath}`);
    this.name = "TaskGraphStoreConflictError";
    this.filePath = filePath;
  }
}

export class TaskGraphStoreLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`timed out waiting for task graph lock: ${lockPath}`);
    this.name = "TaskGraphStoreLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export class TaskGraphStoreLockOwnerFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid task graph lock owner: ${filePath}: ${message}`);
    this.name = "TaskGraphStoreLockOwnerFormatError";
    this.filePath = filePath;
  }
}

export class TaskGraphStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid task graph store: ${filePath}: ${message}`);
    this.name = "TaskGraphStoreFormatError";
    this.filePath = filePath;
  }
}

const taskGraphSourceHashes = new WeakMap<TaskGraph, string>();
const taskGraphStoreLockDepth = new AsyncLocalStorage<number>();

export class TaskGraphStore {
  readonly filePath: string;
  readonly lockPath: string;
  readonly layout: "legacy-json" | "project-tree";

  constructor(filePath: string) {
    this.filePath = filePath;
    this.layout = filePath.endsWith(".json") ? "legacy-json" : "project-tree";
    this.lockPath =
      this.layout === "project-tree" ? join(filePath, "index.lock") : `${filePath}.lock`;
  }

  async save(graph: TaskGraph): Promise<void> {
    if (taskGraphStoreLockDepth.getStore()) {
      await this.saveUnlocked(graph);
      return;
    }
    await this.withLock(async () => {
      await this.assertGraphNotStale(graph);
      await this.saveUnlocked(graph);
    });
  }

  private async saveUnlocked(
    graph: TaskGraph,
    lockOptions: TaskGraphStoreLockOptions = {},
  ): Promise<void> {
    const snapshot = serializeTaskGraphStoreSnapshot(graph.snapshot());
    if (this.layout === "project-tree") {
      const canonical = canonicalizePersistedSnapshot(snapshot);
      await writeProjectTreeSnapshot(this.filePath, canonical, lockOptions);
      taskGraphSourceHashes.set(graph, stableId(formatJsonFile(canonical)));
      return;
    }
    const data = formatJsonFile(snapshot);
    await writeJsonFileAtomic(this.filePath, snapshot);
    taskGraphSourceHashes.set(graph, stableId(data));
  }

  async load(): Promise<TaskGraph | null> {
    const loaded =
      this.layout === "project-tree"
        ? await readProjectTreeSnapshot(this.filePath)
        : await readLegacyProjectJsonSnapshot(this.filePath);
    if (!loaded) return null;
    let graph: TaskGraph;
    try {
      graph = TaskGraph.fromSnapshot(deserializeTaskGraphStoreSnapshot(loaded.snapshot));
    } catch (error) {
      throw new TaskGraphStoreFormatError(
        this.filePath,
        `not valid task graph snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    taskGraphSourceHashes.set(graph, loaded.hash);
    return graph;
  }

  async withLock<T>(fn: () => T | Promise<T>, options: TaskGraphStoreLockOptions = {}): Promise<T> {
    if (taskGraphStoreLockDepth.getStore()) return fn();
    const release = await acquireTaskGraphStoreLock(this.lockPath, options);
    return taskGraphStoreLockDepth.run(1, async () => {
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  async update<T>(
    fn: (graph: TaskGraph) => T | Promise<T>,
    options: TaskGraphStoreUpdateOptions = {},
  ): Promise<TaskGraphStoreUpdateResult<T>> {
    const createIfMissing = options.createIfMissing ?? true;
    return this.withLock(async () => {
      const graph = await this.load();
      if (!graph) {
        if (!createIfMissing) return { graph: null, result: undefined as T };
        const created = new TaskGraph();
        const result = await fn(created);
        await this.saveUnlocked(created, options);
        return { graph: created, result };
      }
      const result = await fn(graph);
      await this.saveUnlocked(graph, options);
      return { graph, result };
    }, options);
  }

  private async assertGraphNotStale(graph: TaskGraph): Promise<void> {
    const sourceHash = taskGraphSourceHashes.get(graph);
    if (!sourceHash) return;
    try {
      const currentHash = await this.currentStoreHash();
      if (currentHash !== sourceHash) throw new TaskGraphStoreConflictError(this.filePath);
    } catch (error) {
      if (isFileNotFoundError(error)) throw new TaskGraphStoreConflictError(this.filePath);
      throw error;
    }
  }

  private async currentStoreHash(): Promise<string> {
    if (this.layout === "project-tree") {
      const loaded = await readProjectTreeSnapshot(this.filePath);
      if (!loaded) throw new TaskGraphStoreConflictError(this.filePath);
      return loaded.hash;
    }
    const current = await readFile(this.filePath, "utf8");
    return stableId(current);
  }
}

export function defaultTaskGraphStore(cwd: string): TaskGraphStore {
  return new TaskGraphStore(join(cwd, ".spark", "projects"));
}

interface LoadedTaskGraphStoreSnapshot {
  snapshot: PersistedTaskGraphSnapshot;
  hash: string;
}

async function readLegacyProjectJsonSnapshot(
  filePath: string,
): Promise<LoadedTaskGraphStoreSnapshot | null> {
  let data: string;
  try {
    data = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
  return {
    snapshot: parseTaskGraphStoreJson(data, filePath) as PersistedTaskGraphSnapshot,
    hash: stableId(data),
  };
}

function parseTaskGraphStoreJson(text: string, filePath: string): unknown {
  const raw = parseJsonFileText(
    text,
    filePath,
    (path, message) => new TaskGraphStoreFormatError(path, message),
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskGraphStoreFormatError(filePath, "JSON root must be an object");
  }
  return raw;
}

interface PersistedProject extends Omit<Project, "purpose"> {
  intent?: string;
  purpose?: string;
}

interface PersistedTaskGraphSnapshot extends Omit<TaskGraphSnapshot, "projects"> {
  projects: PersistedProject[];
}

function serializeTaskGraphStoreSnapshot(snapshot: TaskGraphSnapshot): PersistedTaskGraphSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => {
      const { purpose, ...rest } = project;
      return {
        ...rest,
        intent: purpose,
      };
    }),
  };
}

function canonicalizePersistedSnapshot(
  snapshot: PersistedTaskGraphSnapshot,
): PersistedTaskGraphSnapshot {
  return {
    projects: [...snapshot.projects].sort(compareRef),
    tasks: [...snapshot.tasks].sort(compareRef),
    dependencies: [...(snapshot.dependencies ?? [])].sort(compareDependency),
    runs: [...(snapshot.runs ?? [])].sort(compareRef),
  };
}

function deserializeTaskGraphStoreSnapshot(raw: unknown): TaskGraphSnapshot {
  const snapshot = raw as PersistedTaskGraphSnapshot;
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => {
      const { intent, purpose, ...rest } = project;
      return {
        ...rest,
        purpose: purpose ?? intent,
      };
    }),
  } as TaskGraphSnapshot;
}

interface ProjectIndexSnapshot {
  version: 1;
  rebuildable: true;
  generatedAt: string;
  legacyImportOnly: string[];
  projects: ProjectIndexEntry[];
}

interface ProjectIndexEntry {
  projectRef: ProjectRef;
  path: string;
  projectPath: string;
  roadmapPath: string;
  dependenciesPath: string;
  tasksPath: string;
  status: Project["status"];
  title: string;
  updatedAt: string;
  taskCount: number;
  currentTaskRef?: TaskRef;
}

interface ProjectFileSnapshot extends Omit<Project, "roadmap" | "purpose"> {
  version: 1;
  purpose?: string;
  intent?: string;
  roadmapPath: "roadmap.json";
  dependenciesPath: "dependencies.json";
  tasksPath: "tasks";
  reviewPath: "reviews";
}

interface RoadmapFileSnapshot extends ProjectRoadmap {
  version: 1;
}

interface DependencyFileSnapshot {
  version: 1;
  projectRef: ProjectRef;
  dependencies: TaskDependency[];
}

interface TaskFileSnapshot extends Task {
  version: 1;
  todoOwnerRef: TaskRef;
  runsPath: "runs";
  reviewsPath: "reviews";
}

interface RunFileSnapshot extends TaskRun {
  version: 1;
}

async function writeProjectTreeSnapshot(
  root: string,
  snapshot: PersistedTaskGraphSnapshot,
  lockOptions: TaskGraphStoreLockOptions = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  const tasksByProject = new Map<ProjectRef, Task[]>();
  for (const task of snapshot.tasks) {
    const list = tasksByProject.get(task.projectRef) ?? [];
    list.push(task);
    tasksByProject.set(task.projectRef, list);
  }
  const runsByTask = new Map<TaskRef, TaskRun[]>();
  for (const run of snapshot.runs ?? []) {
    const list = runsByTask.get(run.taskRef) ?? [];
    list.push(run);
    runsByTask.set(run.taskRef, list);
  }
  const desiredProjectDirs = new Set(snapshot.projects.map((project) => storeDirName(project.ref)));
  const existingProjectDirs = await listProjectDirs(root);
  const projectLockDirs = [...new Set([...desiredProjectDirs, ...existingProjectDirs])].sort();
  const releaseProjectLocks = await acquireProjectTreeProjectLocks(
    root,
    projectLockDirs,
    lockOptions,
  );
  try {
    for (const existing of existingProjectDirs) {
      if (!desiredProjectDirs.has(existing))
        await rm(join(root, existing), { recursive: true, force: true });
    }

    const projectEntries: ProjectIndexEntry[] = [];
    for (const project of snapshot.projects) {
      const projectDirName = storeDirName(project.ref);
      const projectDir = join(root, projectDirName);
      const projectTasks = [...(tasksByProject.get(project.ref) ?? [])].sort(compareRef);
      const projectDependencies = (snapshot.dependencies ?? [])
        .filter((dependency) => projectTasks.some((task) => task.ref === dependency.taskRef))
        .sort(compareDependency);
      await writeJsonFileIfChanged(join(projectDir, "project.json"), projectFileSnapshot(project));
      await writeJsonFileIfChanged(join(projectDir, "roadmap.json"), {
        version: 1,
        ...project.roadmap,
      } satisfies RoadmapFileSnapshot);
      await writeJsonFileIfChanged(join(projectDir, "dependencies.json"), {
        version: 1,
        projectRef: project.ref,
        dependencies: projectDependencies,
      } satisfies DependencyFileSnapshot);

      const tasksRoot = join(projectDir, "tasks");
      const desiredTaskDirs = new Set(projectTasks.map((task) => storeDirName(task.ref)));
      for (const existing of await listChildDirs(tasksRoot)) {
        if (!desiredTaskDirs.has(existing))
          await rm(join(tasksRoot, existing), { recursive: true, force: true });
      }
      for (const task of projectTasks) {
        const taskDir = join(tasksRoot, storeDirName(task.ref));
        await writeJsonFileIfChanged(join(taskDir, "task.json"), taskFileSnapshot(task));
        const runsRoot = join(taskDir, "runs");
        const taskRuns = [...(runsByTask.get(task.ref) ?? [])].sort(compareRef);
        const desiredRunFiles = new Set(taskRuns.map((run) => `${storeDirName(run.ref)}.json`));
        for (const existing of await listJsonFiles(runsRoot)) {
          if (!desiredRunFiles.has(existing)) await rm(join(runsRoot, existing), { force: true });
        }
        for (const run of taskRuns) {
          await writeJsonFileIfChanged(join(runsRoot, `${storeDirName(run.ref)}.json`), {
            version: 1,
            ...run,
          } satisfies RunFileSnapshot);
        }
      }
      const relativeProjectDir = join("projects", projectDirName);
      projectEntries.push({
        projectRef: project.ref,
        path: relativeProjectDir,
        projectPath: join(relativeProjectDir, "project.json"),
        roadmapPath: join(relativeProjectDir, "roadmap.json"),
        dependenciesPath: join(relativeProjectDir, "dependencies.json"),
        tasksPath: join(relativeProjectDir, "tasks"),
        status: project.status,
        title: project.title,
        updatedAt: project.updatedAt,
        taskCount: projectTasks.length,
        ...(project.currentTaskRef ? { currentTaskRef: project.currentTaskRef } : {}),
      });
    }
    await writeJsonFileIfChanged(join(root, "index.json"), {
      version: 1,
      rebuildable: true,
      generatedAt: nowIso(),
      legacyImportOnly: [".spark/projects.json", ".spark/projects.json.lock/"],
      projects: projectEntries.sort((left, right) =>
        left.projectRef.localeCompare(right.projectRef),
      ),
    } satisfies ProjectIndexSnapshot);
  } finally {
    await releaseProjectLocks();
  }
}

async function readProjectTreeSnapshot(root: string): Promise<LoadedTaskGraphStoreSnapshot | null> {
  const indexPath = join(root, "index.json");
  let indexData: string;
  try {
    indexData = await readFile(indexPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
  parseProjectTreeJson(indexData, indexPath);
  const projectDirs = await listProjectDirs(root);
  const projects: PersistedProject[] = [];
  const tasks: Task[] = [];
  const dependencies: TaskDependency[] = [];
  const runs: TaskRun[] = [];
  for (const projectDirName of projectDirs) {
    const projectDir = join(root, projectDirName);
    const projectFile = (await readProjectTreeJson(
      join(projectDir, "project.json"),
    )) as unknown as ProjectFileSnapshot;
    const roadmap = (await readProjectTreeJson(
      join(projectDir, "roadmap.json"),
    )) as unknown as RoadmapFileSnapshot;
    projects.push({
      ...projectFile,
      purpose: projectFile.purpose ?? projectFile.intent,
      roadmap,
    });
    const dependencyFile = (await readProjectTreeJson(
      join(projectDir, "dependencies.json"),
    )) as unknown as DependencyFileSnapshot;
    dependencies.push(...(dependencyFile.dependencies ?? []));
    for (const taskDirName of await listChildDirs(join(projectDir, "tasks"))) {
      const taskDir = join(projectDir, "tasks", taskDirName);
      const taskFile = (await readProjectTreeJson(
        join(taskDir, "task.json"),
      )) as unknown as TaskFileSnapshot;
      tasks.push(taskFile);
      for (const runFileName of await listJsonFiles(join(taskDir, "runs"))) {
        const run = (await readProjectTreeJson(
          join(taskDir, "runs", runFileName),
        )) as unknown as RunFileSnapshot;
        runs.push(run);
      }
    }
  }
  const snapshot = serializeTaskGraphStoreSnapshot({
    projects: projects.sort(compareRef),
    tasks: tasks.sort(compareRef),
    dependencies: dependencies.sort(compareDependency),
    runs: runs.sort(compareRef),
  });
  return { snapshot, hash: stableId(formatJsonFile(snapshot)) };
}

function projectFileSnapshot(project: PersistedProject): ProjectFileSnapshot {
  const { roadmap: _roadmap, purpose, ...rest } = project;
  return {
    version: 1,
    ...rest,
    ...(purpose ? { purpose, intent: purpose } : {}),
    roadmapPath: "roadmap.json",
    dependenciesPath: "dependencies.json",
    tasksPath: "tasks",
    reviewPath: "reviews",
  };
}

function taskFileSnapshot(task: Task): TaskFileSnapshot {
  return {
    version: 1,
    ...task,
    todoOwnerRef: task.ref,
    runsPath: "runs",
    reviewsPath: "reviews",
  };
}

async function writeJsonFileIfChanged(filePath: string, value: unknown): Promise<void> {
  const next = formatJsonFile(value);
  try {
    if ((await readFile(filePath, "utf8")) === next) return;
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  await writeJsonFileAtomic(filePath, value);
}

async function readProjectTreeJson(filePath: string): Promise<Record<string, unknown>> {
  const data = await readFile(filePath, "utf8");
  return parseProjectTreeJson(data, filePath);
}

function parseProjectTreeJson(text: string, filePath: string): Record<string, unknown> {
  const raw = parseTaskGraphStoreJson(text, filePath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskGraphStoreFormatError(filePath, "JSON root must be an object");
  }
  return raw as Record<string, unknown>;
}

async function listProjectDirs(root: string): Promise<string[]> {
  return (await listChildDirs(root)).filter((name) => name.startsWith("proj-"));
}

async function listChildDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

async function listJsonFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

function storeDirName(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-");
}

async function acquireProjectTreeProjectLocks(
  root: string,
  projectDirNames: string[],
  options: TaskGraphStoreLockOptions,
): Promise<() => Promise<void>> {
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const projectDirName of projectDirNames) {
      releases.push(
        await acquireTaskGraphStoreLock(join(root, "locks", `${projectDirName}.lock`), options),
      );
    }
  } catch (error) {
    for (const release of releases.reverse()) await release();
    throw error;
  }
  return async () => {
    for (const release of releases.reverse()) await release();
  };
}

function compareRef<T extends { ref: string }>(left: T, right: T): number {
  return left.ref.localeCompare(right.ref);
}

function compareDependency(left: TaskDependency, right: TaskDependency): number {
  return `${left.taskRef}\0${left.dependsOn}`.localeCompare(`${right.taskRef}\0${right.dependsOn}`);
}

async function acquireTaskGraphStoreLock(
  lockPath: string,
  options: TaskGraphStoreLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryIntervalMs = Math.max(1, options.retryIntervalMs ?? 25);
  const staleMs = options.staleMs ?? 60_000;
  const started = Date.now();
  const ownerId = stableId(`${process.pid}:${started}:${randomUUID()}`);
  await mkdir(dirname(lockPath), { recursive: true });
  const ownerPath = join(lockPath, "owner.json");
  const ownerJson = () =>
    `${JSON.stringify(
      {
        ownerId,
        pid: process.pid,
        startedAt: new Date(started).toISOString(),
        heartbeatAt: nowIso(),
      },
      null,
      2,
    )}\n`;

  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      await writeLockOwnerFile(ownerPath, ownerJson());
      const refreshMs =
        staleMs > 0 ? Math.max(1_000, Math.min(30_000, Math.floor(staleMs / 3))) : undefined;
      let heartbeatError: unknown;
      let heartbeatWrite: Promise<void> | undefined;
      const refreshTimer = refreshMs
        ? setInterval(() => {
            heartbeatWrite = writeLockOwnerFile(ownerPath, ownerJson()).catch((error) => {
              heartbeatError = error;
            });
          }, refreshMs)
        : undefined;
      refreshTimer?.unref?.();
      return async () => {
        if (refreshTimer) clearInterval(refreshTimer);
        await heartbeatWrite;
        if (await lockOwnerMatches(ownerPath, ownerId))
          await rm(lockPath, { recursive: true, force: true });
        if (heartbeatError) {
          throw new Error(
            `task graph lock heartbeat failed: ${unknownErrorMessage(heartbeatError)}`,
          );
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleTaskGraphStoreLock(lockPath, staleMs);
      if (Date.now() - started >= timeoutMs) throw new TaskGraphStoreLockTimeoutError(lockPath);
      await sleep(retryIntervalMs);
    }
  }
}

async function writeLockOwnerFile(ownerPath: string, data: string): Promise<void> {
  const tempPath = `${ownerPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, data, "utf8");
    await rename(tempPath, ownerPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function removeStaleTaskGraphStoreLock(lockPath: string, staleMs: number): Promise<void> {
  if (staleMs < 0) return;
  try {
    const heartbeatMs = await taskGraphStoreLockHeartbeatMs(lockPath);
    if (Date.now() - heartbeatMs >= staleMs) await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function taskGraphStoreLockHeartbeatMs(lockPath: string): Promise<number> {
  const ownerPath = join(lockPath, "owner.json");
  try {
    const ownerRaw = await readFile(ownerPath, "utf8");
    return parseTaskGraphStoreLockOwner(ownerPath, ownerRaw).heartbeatMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return (await stat(lockPath)).mtimeMs;
  }
}

async function lockOwnerMatches(ownerPath: string, ownerId: string): Promise<boolean> {
  try {
    const owner = parseTaskGraphStoreLockOwner(ownerPath, await readFile(ownerPath, "utf8"));
    return owner.ownerId === ownerId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseTaskGraphStoreLockOwner(
  filePath: string,
  text: string,
): { ownerId: string; heartbeatMs: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new TaskGraphStoreLockOwnerFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskGraphStoreLockOwnerFormatError(filePath, "JSON root must be an object");
  }
  const owner = raw as Record<string, unknown>;
  if (typeof owner.ownerId !== "string" || !owner.ownerId.trim()) {
    throw new TaskGraphStoreLockOwnerFormatError(filePath, "ownerId must be a non-empty string");
  }
  if (typeof owner.heartbeatAt !== "string" || !owner.heartbeatAt.trim()) {
    throw new TaskGraphStoreLockOwnerFormatError(
      filePath,
      "heartbeatAt must be a non-empty string",
    );
  }
  const heartbeatMs = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    throw new TaskGraphStoreLockOwnerFormatError(filePath, "heartbeatAt must be a valid date");
  }
  return { ownerId: owner.ownerId, heartbeatMs };
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
