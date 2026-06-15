import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
  newRef,
  nowIso,
  type RunRef,
  type ProjectRef,
} from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  normalizeCurrentProjectStoreSnapshot,
  type CurrentProjectStoreSnapshot,
  type SparkAgentMode,
  type SparkExecuteStrategy,
  type SparkExecutionBudget,
  type SparkExecutionModeState,
  type SparkPlanningModeSource,
  type SparkRunModeState,
  type SparkRunModeStatus,
  type SparkRunStrategy,
} from "./current-project-state-schema.ts";
import { readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  sanitizeStoreScope,
  sparkSessionOwnerKey,
  type SparkSessionContext,
} from "./session-identity.ts";

export type {
  CurrentProjectStoreSnapshot,
  SparkAgentMode,
  SparkExecuteStrategy,
  SparkExecutionBudget,
  SparkExecutionModeState,
  SparkPlanningModeSource,
  SparkPlanningModeState,
  SparkRunModeState,
  SparkRunModeStatus,
  SparkRunStrategy,
} from "./current-project-state-schema.ts";

export async function loadCurrentProjectState(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<CurrentProjectStoreSnapshot | undefined> {
  const filePath = currentProjectStorePath(cwd, ctx);
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return undefined;
  return normalizeCurrentProjectStoreSnapshot(raw, filePath);
}

export async function loadCurrentProjectRef(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<ProjectRef | undefined> {
  return (await loadCurrentProjectState(cwd, ctx))?.projectRef;
}

export async function saveCurrentProjectRef(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  projectRef: ProjectRef,
): Promise<void> {
  await saveCurrentProjectState(cwd, ctx, { version: 1, projectRef });
}

export async function saveSparkPlanningMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  projectRef: ProjectRef,
  focus: string | undefined,
  source: SparkPlanningModeSource,
): Promise<void> {
  const enteredAt = nowIso();
  await saveCurrentProjectState(cwd, ctx, {
    version: 1,
    projectRef,
    planningMode: {
      version: 1,
      projectRef,
      focus: focus?.trim() || undefined,
      source,
      enteredAt,
    },
    executionMode: {
      version: 1,
      projectRef,
      focus: focus?.trim() || undefined,
      mode: "plan",
      enteredAt,
    },
  });
}

export async function saveSparkExecutionMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  projectRef: ProjectRef,
  focus: string | undefined,
  mode: SparkAgentMode = "implement",
  strategy?: SparkExecuteStrategy,
  options?: {
    workflowName?: string;
    inlineScript?: string;
    workflowArgs?: unknown;
    budget?: SparkExecutionBudget;
  },
): Promise<void> {
  await saveCurrentProjectState(cwd, ctx, {
    version: 1,
    projectRef,
    executionMode: {
      version: 1,
      projectRef,
      focus: focus?.trim() || undefined,
      mode,
      strategy: mode === "implement" ? (strategy ?? "default") : undefined,
      workflowName: options?.workflowName?.trim() || undefined,
      inlineScript: options?.inlineScript?.trim() || undefined,
      workflowArgs: options?.workflowArgs,
      budget: options?.budget,
      enteredAt: nowIso(),
    },
  });
}

export async function loadSparkExecutionMode(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkExecutionModeState | undefined> {
  return (await loadCurrentProjectState(cwd, ctx))?.executionMode;
}

export async function saveSparkRunMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  projectRef: ProjectRef,
  focus: string | undefined,
  strategy: SparkRunStrategy,
  policy?: { maxConcurrency?: number; timeoutMs?: number },
): Promise<SparkRunModeState> {
  const now = nowIso();
  const runMode: SparkRunModeState = {
    version: 1,
    runRef: newRef("run") as RunRef,
    projectRef,
    focus: focus?.trim() || undefined,
    status: "running",
    policy: {
      maxConcurrency: policy?.maxConcurrency ?? sparkRunStrategyMaxConcurrency(strategy),
      timeoutMs: policy?.timeoutMs ?? DEFAULT_READY_TASK_TIMEOUT_MS,
      stopOnAsk: true,
      stopOnValidationFailure: true,
    },
    enteredAt: now,
    updatedAt: now,
  };
  await saveCurrentProjectState(cwd, ctx, { version: 1, projectRef, runMode });
  return runMode;
}

export function sparkRunStrategyMaxConcurrency(strategy: SparkRunStrategy): number {
  return strategy === "sequential" ? 1 : DEFAULT_READY_TASK_MAX_CONCURRENCY;
}

export function sparkRunStrategyForMaxConcurrency(maxConcurrency: number): SparkRunStrategy {
  return maxConcurrency === 1 ? "sequential" : "parallel";
}

export async function loadSparkRunMode(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkRunModeState | undefined> {
  return (await loadCurrentProjectState(cwd, ctx))?.runMode;
}

export async function updateSparkRunModeStatus(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  status: SparkRunModeStatus,
): Promise<SparkRunModeState | undefined> {
  const state = await loadCurrentProjectState(cwd, ctx);
  if (!state?.projectRef || !state.runMode) return undefined;
  const runMode: SparkRunModeState = { ...state.runMode, status, updatedAt: nowIso() };
  await saveCurrentProjectState(cwd, ctx, { version: 1, projectRef: state.projectRef, runMode });
  return runMode;
}

export async function clearSparkExecutionMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  const state = await loadCurrentProjectState(cwd, ctx);
  if (!state?.projectRef) {
    await rm(currentProjectStorePath(cwd, ctx), { force: true });
    return;
  }
  await saveCurrentProjectRef(cwd, ctx, state.projectRef);
}

export async function clearCurrentProjectRef(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await rm(currentProjectStorePath(cwd, ctx), { force: true });
}

export async function currentSparkProject(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  graph: TaskGraph,
): Promise<ReturnType<TaskGraph["projects"]>[number] | undefined> {
  const projects = graph.projects();
  if (projects.length === 0) return undefined;
  const stored = await loadCurrentProjectRef(cwd, ctx);
  if (!stored) return undefined;
  const selected = projects.find((project) => project.ref === stored);
  if (selected && selected.status !== "done") return selected;
  await clearCurrentProjectRef(cwd, ctx);
  return undefined;
}

function currentProjectStorePath(cwd: string, ctx: SparkSessionContext | undefined): string {
  return join(cwd, ".spark", "sessions", `${sanitizeStoreScope(sparkSessionOwnerKey(ctx))}.json`);
}

async function saveCurrentProjectState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  snapshot: CurrentProjectStoreSnapshot,
): Promise<void> {
  await writeJsonFileAtomic(currentProjectStorePath(cwd, ctx), snapshot);
}
