import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { newRef, nowIso, stableId, type RunRef, type ThreadRef } from "spark-core";
import {
  DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
} from "spark-orchestrator";
import { defaultTaskGraphStore, defaultTaskTodoStore, type TaskGraph } from "spark-tasks";

export type SparkRunStrategy = "sequential" | "parallel";
export type SparkPlanningModeSource = "auto" | "direct";

export interface SparkPlanningModeState {
  version: 1;
  threadRef: ThreadRef;
  focus?: string;
  source: SparkPlanningModeSource;
  enteredAt: string;
}

export interface SparkExecutionModeState {
  version: 1;
  threadRef: ThreadRef;
  focus?: string;
  enteredAt: string;
}

export type SparkRunModeStatus = "running" | "paused" | "blocked" | "done" | "failed" | "cancelled";

export interface SparkRunModeState {
  version: 1;
  runRef: RunRef;
  threadRef: ThreadRef;
  focus?: string;
  status: SparkRunModeStatus;
  policy: {
    maxConcurrency: number;
    timeoutMs: number;
    stopOnAsk: true;
    stopOnValidationFailure: true;
  };
  enteredAt: string;
  updatedAt: string;
}

export interface CurrentThreadStoreSnapshot {
  version: 1;
  threadRef?: ThreadRef;
  planningMode?: SparkPlanningModeState;
  executionMode?: SparkExecutionModeState;
  runMode?: SparkRunModeState;
}

interface HiddenRoleRunInboxState {
  version: 1;
  delivered: Array<{ runRef: RunRef; deliveredAt: string }>;
}

interface SparkSessionContextLike {
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
}

export function sparkSessionKey(ctx: unknown): string {
  if (ctx && typeof ctx === "object") {
    const manager = (ctx as SparkSessionContextLike).sessionManager;
    const sessionFile = manager?.getSessionFile?.();
    if (sessionFile) return `session:${stableId(sessionFile)}`;
    const leaf = manager?.getLeafId?.();
    if (leaf) return `leaf:${leaf}`;
  }
  return "session:ephemeral";
}

export function sparkSessionOwnerKey(ctx: unknown): string {
  if (ctx && typeof ctx === "object") {
    const manager = (ctx as SparkSessionContextLike).sessionManager;
    const sessionFile = manager?.getSessionFile?.();
    if (sessionFile) return `session:${stableId(sessionFile)}`;
  }
  return sparkSessionKey(ctx);
}

export function sanitizeStoreScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || "default";
}

export async function loadSparkGraph(cwd: string, ctx?: unknown): Promise<TaskGraph | null> {
  const graph = await defaultTaskGraphStore(cwd).load();
  if (!graph) return null;
  await sparkTodoStore(cwd, ctx).hydrate(graph);
  return graph;
}

export function sparkTodoStore(cwd: string, ctx: unknown): ReturnType<typeof defaultTaskTodoStore> {
  return defaultTaskTodoStore(cwd, sparkSessionKey(ctx));
}

function currentThreadStorePath(cwd: string, ctx: unknown): string {
  return join(
    cwd,
    ".spark",
    "current-thread",
    `${sanitizeStoreScope(sparkSessionOwnerKey(ctx))}.json`,
  );
}

function hiddenRoleRunInboxStorePath(cwd: string, ctx: unknown): string {
  return join(
    cwd,
    ".spark",
    "background-role-results-inbox",
    `${sanitizeStoreScope(sparkSessionOwnerKey(ctx))}.json`,
  );
}

export async function loadHiddenRoleRunInboxState(
  cwd: string,
  ctx: unknown,
): Promise<HiddenRoleRunInboxState> {
  try {
    const raw = JSON.parse(await readFile(hiddenRoleRunInboxStorePath(cwd, ctx), "utf8")) as {
      delivered?: Array<{ runRef?: string; deliveredAt?: string }>;
      deliveredRunRefs?: string[];
    };
    const delivered = (raw.delivered ?? [])
      .filter((entry): entry is { runRef: RunRef; deliveredAt: string } =>
        Boolean(entry.runRef && entry.deliveredAt),
      )
      .map((entry) => ({ runRef: entry.runRef, deliveredAt: entry.deliveredAt }));
    for (const runRef of raw.deliveredRunRefs ?? []) {
      if (delivered.some((entry) => entry.runRef === runRef)) continue;
      delivered.push({ runRef: runRef as RunRef, deliveredAt: nowIso() });
    }
    return { version: 1, delivered };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, delivered: [] };
    throw error;
  }
}

export async function saveHiddenRoleRunInboxState(
  cwd: string,
  ctx: unknown,
  state: HiddenRoleRunInboxState,
): Promise<void> {
  await writeJsonFileAtomic(hiddenRoleRunInboxStorePath(cwd, ctx), state);
}

export async function loadCurrentThreadState(
  cwd: string,
  ctx: unknown,
): Promise<CurrentThreadStoreSnapshot | undefined> {
  try {
    const raw = JSON.parse(await readFile(currentThreadStorePath(cwd, ctx), "utf8")) as {
      threadRef?: string;
      planningMode?: Partial<SparkPlanningModeState>;
      executionMode?: Partial<SparkExecutionModeState>;
      runMode?: Partial<SparkRunModeState>;
    };
    return {
      version: 1,
      threadRef: raw.threadRef as ThreadRef | undefined,
      planningMode:
        raw.planningMode?.threadRef && raw.planningMode.enteredAt
          ? {
              version: 1,
              threadRef: raw.planningMode.threadRef as ThreadRef,
              focus: raw.planningMode.focus?.trim() || undefined,
              source: raw.planningMode.source === "direct" ? "direct" : "auto",
              enteredAt: raw.planningMode.enteredAt,
            }
          : undefined,
      executionMode:
        raw.executionMode?.threadRef && raw.executionMode.enteredAt
          ? {
              version: 1,
              threadRef: raw.executionMode.threadRef as ThreadRef,
              focus: raw.executionMode.focus?.trim() || undefined,
              enteredAt: raw.executionMode.enteredAt,
            }
          : undefined,
      runMode: normalizeSparkRunModeState(raw.runMode),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadCurrentThreadRef(
  cwd: string,
  ctx: unknown,
): Promise<ThreadRef | undefined> {
  return (await loadCurrentThreadState(cwd, ctx))?.threadRef;
}

async function saveCurrentThreadState(
  cwd: string,
  ctx: unknown,
  snapshot: CurrentThreadStoreSnapshot,
): Promise<void> {
  await writeJsonFileAtomic(currentThreadStorePath(cwd, ctx), snapshot);
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveCurrentThreadRef(
  cwd: string,
  ctx: unknown,
  threadRef: ThreadRef,
): Promise<void> {
  await saveCurrentThreadState(cwd, ctx, { version: 1, threadRef });
}

export async function saveSparkPlanningMode(
  cwd: string,
  ctx: unknown,
  threadRef: ThreadRef,
  focus: string | undefined,
  source: SparkPlanningModeSource,
): Promise<void> {
  await saveCurrentThreadState(cwd, ctx, {
    version: 1,
    threadRef,
    planningMode: {
      version: 1,
      threadRef,
      focus: focus?.trim() || undefined,
      source,
      enteredAt: nowIso(),
    },
  });
}

export async function saveSparkExecutionMode(
  cwd: string,
  ctx: unknown,
  threadRef: ThreadRef,
  focus: string | undefined,
): Promise<void> {
  await saveCurrentThreadState(cwd, ctx, {
    version: 1,
    threadRef,
    executionMode: {
      version: 1,
      threadRef,
      focus: focus?.trim() || undefined,
      enteredAt: nowIso(),
    },
  });
}

export async function loadSparkExecutionMode(
  cwd: string,
  ctx: unknown,
): Promise<SparkExecutionModeState | undefined> {
  return (await loadCurrentThreadState(cwd, ctx))?.executionMode;
}

export async function saveSparkRunMode(
  cwd: string,
  ctx: unknown,
  threadRef: ThreadRef,
  focus: string | undefined,
  strategy: SparkRunStrategy,
): Promise<SparkRunModeState> {
  const now = nowIso();
  const runMode: SparkRunModeState = {
    version: 1,
    runRef: newRef("run") as RunRef,
    threadRef,
    focus: focus?.trim() || undefined,
    status: "running",
    policy: {
      maxConcurrency: sparkRunStrategyMaxConcurrency(strategy),
      timeoutMs: DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
      stopOnAsk: true,
      stopOnValidationFailure: true,
    },
    enteredAt: now,
    updatedAt: now,
  };
  await saveCurrentThreadState(cwd, ctx, { version: 1, threadRef, runMode });
  return runMode;
}

export function sparkRunStrategyMaxConcurrency(strategy: SparkRunStrategy): number {
  return strategy === "sequential" ? 1 : DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY;
}

export function sparkRunStrategyForMaxConcurrency(maxConcurrency: number): SparkRunStrategy {
  return maxConcurrency === 1 ? "sequential" : "parallel";
}

function normalizeSparkRunModeState(
  raw: Partial<SparkRunModeState> | undefined,
): SparkRunModeState | undefined {
  if (!raw?.runRef || !raw.threadRef || !raw.enteredAt) return undefined;
  const status: SparkRunModeStatus =
    raw.status === "paused" ||
    raw.status === "blocked" ||
    raw.status === "done" ||
    raw.status === "failed" ||
    raw.status === "cancelled"
      ? raw.status
      : "running";
  return {
    version: 1,
    runRef: raw.runRef as RunRef,
    threadRef: raw.threadRef as ThreadRef,
    focus: raw.focus?.trim() || undefined,
    status,
    policy: {
      maxConcurrency:
        typeof raw.policy?.maxConcurrency === "number"
          ? raw.policy.maxConcurrency
          : DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
      timeoutMs:
        typeof raw.policy?.timeoutMs === "number"
          ? raw.policy.timeoutMs
          : DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
      stopOnAsk: true,
      stopOnValidationFailure: true,
    },
    enteredAt: raw.enteredAt,
    updatedAt: raw.updatedAt ?? raw.enteredAt,
  };
}

export async function loadSparkRunMode(
  cwd: string,
  ctx: unknown,
): Promise<SparkRunModeState | undefined> {
  return (await loadCurrentThreadState(cwd, ctx))?.runMode;
}

export async function updateSparkRunModeStatus(
  cwd: string,
  ctx: unknown,
  status: SparkRunModeStatus,
): Promise<SparkRunModeState | undefined> {
  const state = await loadCurrentThreadState(cwd, ctx);
  if (!state?.threadRef || !state.runMode) return undefined;
  const runMode: SparkRunModeState = { ...state.runMode, status, updatedAt: nowIso() };
  await saveCurrentThreadState(cwd, ctx, { version: 1, threadRef: state.threadRef, runMode });
  return runMode;
}

export async function clearSparkExecutionMode(cwd: string, ctx: unknown): Promise<void> {
  const state = await loadCurrentThreadState(cwd, ctx);
  if (!state?.threadRef) {
    await rm(currentThreadStorePath(cwd, ctx), { force: true });
    return;
  }
  await saveCurrentThreadRef(cwd, ctx, state.threadRef);
}

export async function clearCurrentThreadRef(cwd: string, ctx: unknown): Promise<void> {
  await rm(currentThreadStorePath(cwd, ctx), { force: true });
}

export async function currentSparkThread(
  cwd: string,
  ctx: unknown,
  graph: TaskGraph,
): Promise<ReturnType<TaskGraph["threads"]>[number] | undefined> {
  const threads = graph.threads();
  if (threads.length === 0) return undefined;
  const stored = await loadCurrentThreadRef(cwd, ctx);
  if (!stored) return undefined;
  const selected = threads.find((thread) => thread.ref === stored);
  if (selected && selected.status !== "done") return selected;
  await clearCurrentThreadRef(cwd, ctx);
  return undefined;
}
