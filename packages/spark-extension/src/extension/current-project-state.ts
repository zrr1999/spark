import { rm } from "node:fs/promises";

import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  type ProjectRef,
  type TaskRef,
} from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  normalizeCurrentProjectStoreSnapshot,
  type CurrentProjectStoreSnapshot,
  type SparkAgentPhase,
  type SparkRunStrategy,
} from "./current-project-state-schema.ts";
import { readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  legacyCurrentProjectStorePath,
  rebuildSessionIndex,
  sessionStateStorePath,
} from "./session-directory-store.ts";
import type { SparkSessionContext } from "./session-identity.ts";

export type {
  CurrentProjectStoreSnapshot,
  SparkAgentMode,
  SparkAgentPhase,
  SparkPlanningModeSource,
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
  currentTaskRef?: TaskRef,
): Promise<void> {
  const existing = await loadCurrentProjectState(cwd, ctx);
  await saveCurrentProjectState(cwd, ctx, {
    version: 1,
    projectRef,
    ...(currentTaskRef ? { currentTaskRef } : {}),
    ...(existing?.phase ? { phase: existing.phase } : {}),
  });
}

export function sparkRunStrategyMaxConcurrency(strategy: SparkRunStrategy): number {
  return strategy === "sequential" ? 1 : DEFAULT_READY_TASK_MAX_CONCURRENCY;
}

export function sparkRunStrategyForMaxConcurrency(maxConcurrency: number): SparkRunStrategy {
  return maxConcurrency === 1 ? "sequential" : "parallel";
}

export async function clearCurrentProjectRef(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  const existing = await loadCurrentProjectState(cwd, ctx);
  if (existing?.phase) {
    await saveCurrentProjectState(cwd, ctx, { version: 1, phase: existing.phase });
    return;
  }
  await rm(currentProjectStorePath(cwd, ctx), { force: true });
  await rebuildSessionIndex(cwd);
}

export async function saveSessionPhase(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  phase: SparkAgentPhase,
): Promise<void> {
  const existing = await loadCurrentProjectState(cwd, ctx);
  await saveCurrentProjectState(cwd, ctx, {
    version: 1,
    ...(existing?.projectRef ? { projectRef: existing.projectRef } : {}),
    ...(existing?.currentTaskRef ? { currentTaskRef: existing.currentTaskRef } : {}),
    phase,
  });
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
  if (selected) return selected;
  await clearCurrentProjectRef(cwd, ctx);
  return undefined;
}

export function currentProjectStorePath(cwd: string, ctx: SparkSessionContext | undefined): string {
  return sessionStateStorePath(cwd, ctx);
}

export async function importLegacyCurrentProjectState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<CurrentProjectStoreSnapshot | undefined> {
  const legacyPath = legacyCurrentProjectStorePath(cwd, ctx);
  const raw = await readJsonFileOptional<Record<string, unknown>>(legacyPath);
  if (!raw) return undefined;
  const snapshot = normalizeCurrentProjectStoreSnapshot(raw, legacyPath);
  await saveCurrentProjectState(cwd, ctx, snapshot);
  return snapshot;
}

async function saveCurrentProjectState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  snapshot: CurrentProjectStoreSnapshot,
): Promise<void> {
  await writeJsonFileAtomic(currentProjectStorePath(cwd, ctx), snapshot);
  await rebuildSessionIndex(cwd);
}
