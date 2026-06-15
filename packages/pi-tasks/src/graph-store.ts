import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  formatJsonFile,
  isFileNotFoundError,
  nowIso,
  parseJsonFileText,
  stableId,
  writeJsonFileAtomic,
  type Project,
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

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
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

  private async saveUnlocked(graph: TaskGraph): Promise<void> {
    const snapshot = serializeTaskGraphStoreSnapshot(graph.snapshot());
    const data = formatJsonFile(snapshot);
    await writeJsonFileAtomic(this.filePath, snapshot);
    taskGraphSourceHashes.set(graph, stableId(data));
  }

  async load(): Promise<TaskGraph | null> {
    let data: string;
    try {
      data = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) return null;
      throw error;
    }
    const snapshot = parseTaskGraphStoreJson(data, this.filePath);
    let graph: TaskGraph;
    try {
      graph = TaskGraph.fromSnapshot(deserializeTaskGraphStoreSnapshot(snapshot));
    } catch (error) {
      throw new TaskGraphStoreFormatError(
        this.filePath,
        `not valid task graph snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    taskGraphSourceHashes.set(graph, stableId(data));
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
        await this.saveUnlocked(created);
        return { graph: created, result };
      }
      const result = await fn(graph);
      await this.saveUnlocked(graph);
      return { graph, result };
    }, options);
  }

  private async assertGraphNotStale(graph: TaskGraph): Promise<void> {
    const sourceHash = taskGraphSourceHashes.get(graph);
    if (!sourceHash) return;
    try {
      const current = await readFile(this.filePath, "utf8");
      if (stableId(current) !== sourceHash) throw new TaskGraphStoreConflictError(this.filePath);
    } catch (error) {
      if (isFileNotFoundError(error)) throw new TaskGraphStoreConflictError(this.filePath);
      throw error;
    }
  }
}

/** @deprecated Compatibility default path for existing task graph stores. Prefer explicit host-owned TaskGraphStore paths for new integrations. */
export function defaultTaskGraphStore(cwd: string): TaskGraphStore {
  return new TaskGraphStore(join(cwd, ".spark", "projects.json"));
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

async function acquireTaskGraphStoreLock(
  lockPath: string,
  options: TaskGraphStoreLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryIntervalMs = Math.max(1, options.retryIntervalMs ?? 25);
  const staleMs = options.staleMs ?? 60_000;
  const started = Date.now();
  const ownerId = stableId(`${process.pid}:${started}:${randomUUID()}`);
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
