import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { nowIso, type ProjectRef } from "pi-extension-api";
import { isUnfinishedTaskStatus, type TaskGraph } from "pi-tasks";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";

export type SparkProjectGoalStatus = "active" | "paused" | "complete";
export type SparkProjectGoalSource = "explicit" | "inferred" | "agent" | "reviewer";

export interface SparkProjectGoalReviewSummary {
  achieved: boolean;
  confidence?: string;
  reason: string;
  remainingWork?: string;
  blockers: string[];
  artifactRef?: string;
  reviewedAt: string;
}

export interface SparkProjectGoal {
  version: 1;
  goalId: string;
  projectRef: ProjectRef;
  objective: string;
  status: SparkProjectGoalStatus;
  source: SparkProjectGoalSource;
  pauseReason?: string;
  completedReason?: string;
  lastReview?: SparkProjectGoalReviewSummary;
  createdAt: string;
  updatedAt: string;
}

interface SparkProjectGoalsSnapshot {
  version: 1;
  goals: Record<string, SparkProjectGoal>;
}

export function projectGoalStorePath(cwd: string): string {
  return join(cwd, ".spark", "project-goals.json");
}

export async function loadProjectGoal(
  cwd: string,
  projectRef: ProjectRef,
): Promise<SparkProjectGoal | undefined> {
  const snapshot = await loadProjectGoalSnapshot(cwd);
  return snapshot.goals[projectRef];
}

export async function setProjectGoal(
  cwd: string,
  input: {
    projectRef: ProjectRef;
    objective: string;
    source: SparkProjectGoalSource;
    status?: SparkProjectGoalStatus;
  },
): Promise<SparkProjectGoal> {
  const objective = normalizeGoalObjective(input.objective);
  const snapshot = await loadProjectGoalSnapshot(cwd);
  const existing = snapshot.goals[input.projectRef];
  const now = nowIso();
  const goal: SparkProjectGoal = {
    version: 1,
    goalId: existing?.goalId ?? randomUUID(),
    projectRef: input.projectRef,
    objective,
    status: input.status ?? "active",
    source: input.source,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  snapshot.goals[input.projectRef] = goal;
  await saveProjectGoalSnapshot(cwd, snapshot);
  return goal;
}

export async function updateProjectGoalStatus(
  cwd: string,
  projectRef: ProjectRef,
  status: SparkProjectGoalStatus,
  options: { reason?: string; review?: SparkProjectGoalReviewSummary } = {},
): Promise<SparkProjectGoal | undefined> {
  const snapshot = await loadProjectGoalSnapshot(cwd);
  const existing = snapshot.goals[projectRef];
  if (!existing) return undefined;
  const goal: SparkProjectGoal = {
    ...existing,
    status,
    pauseReason: status === "paused" ? normalizeOptionalReason(options.reason) : undefined,
    completedReason: status === "complete" ? normalizeOptionalReason(options.reason) : undefined,
    lastReview: options.review ?? existing.lastReview,
    updatedAt: nowIso(),
  };
  snapshot.goals[projectRef] = goal;
  await saveProjectGoalSnapshot(cwd, snapshot);
  return goal;
}

export function inferProjectGoalObjective(
  graph: TaskGraph,
  project: ReturnType<TaskGraph["projects"]>[number],
): string {
  const tasks = graph.tasks(project.ref);
  const unfinished = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
  const ready = graph.readyTasks(project.ref);
  const lines = [
    `Advance project “${project.title}” to completion.`,
    `Project description: ${project.description}`,
    `Unfinished tasks: ${unfinished.length}. Ready tasks: ${ready.length}.`,
  ];
  const readyTitles = ready.slice(0, 5).map((task) => task.title);
  if (readyTitles.length > 0) lines.push(`Ready frontier: ${readyTitles.join("; ")}.`);
  const blockedCount = unfinished.filter((task) => task.status === "blocked").length;
  if (blockedCount > 0)
    lines.push(`Blocked tasks: ${blockedCount}; clarify blockers before claiming work.`);
  lines.push(
    "Goal policy: claim and complete concrete ready tasks, verify required evidence, ask for user decisions when scope or success criteria are ambiguous, and stop only when reviewer confirms the project goal is achieved or blocked.",
  );
  return lines.join("\n");
}

export function normalizeGoalObjective(value: unknown): string {
  if (typeof value !== "string") throw new Error("goal objective must be a string");
  const objective = value.trim();
  if (!objective) throw new Error("goal objective must not be empty");
  if (Array.from(objective).length > 8_000)
    throw new Error("goal objective must be 8000 characters or fewer");
  return objective;
}

export function normalizeOptionalReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("goal reason must be a string");
  return value.trim() || undefined;
}

async function loadProjectGoalSnapshot(cwd: string): Promise<SparkProjectGoalsSnapshot> {
  const filePath = projectGoalStorePath(cwd);
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return { version: 1, goals: {} };
  if (raw.version !== 1) throw new JsonStoreFormatError(filePath, "version must be 1");
  if (!isRecord(raw.goals)) throw new JsonStoreFormatError(filePath, "goals must be an object");
  const goals: Record<string, SparkProjectGoal> = {};
  for (const [projectRef, value] of Object.entries(raw.goals)) {
    goals[projectRef] = normalizeProjectGoal(value, filePath, projectRef);
  }
  return { version: 1, goals };
}

async function saveProjectGoalSnapshot(
  cwd: string,
  snapshot: SparkProjectGoalsSnapshot,
): Promise<void> {
  await writeJsonFileAtomic(projectGoalStorePath(cwd), snapshot);
}

function normalizeProjectGoal(value: unknown, filePath: string, key: string): SparkProjectGoal {
  if (!isRecord(value)) throw new JsonStoreFormatError(filePath, `goal ${key} must be an object`);
  if (value.version !== 1)
    throw new JsonStoreFormatError(filePath, `goal ${key}.version must be 1`);
  const status = normalizeGoalStatus(value.status, filePath, key);
  const source = normalizeGoalSource(value.source, filePath, key);
  return {
    version: 1,
    goalId: requireString(value.goalId, filePath, `goal ${key}.goalId`),
    projectRef: requireString(value.projectRef, filePath, `goal ${key}.projectRef`) as ProjectRef,
    objective: requireString(value.objective, filePath, `goal ${key}.objective`),
    status,
    source,
    pauseReason: optionalString(value.pauseReason, filePath, `goal ${key}.pauseReason`),
    completedReason: optionalString(value.completedReason, filePath, `goal ${key}.completedReason`),
    lastReview:
      value.lastReview === undefined
        ? undefined
        : normalizeGoalReview(value.lastReview, filePath, key),
    createdAt: requireString(value.createdAt, filePath, `goal ${key}.createdAt`),
    updatedAt: requireString(value.updatedAt, filePath, `goal ${key}.updatedAt`),
  };
}

function normalizeGoalReview(
  value: unknown,
  filePath: string,
  key: string,
): SparkProjectGoalReviewSummary {
  if (!isRecord(value))
    throw new JsonStoreFormatError(filePath, `goal ${key}.lastReview must be an object`);
  return {
    achieved: requireBoolean(value.achieved, filePath, `goal ${key}.lastReview.achieved`),
    confidence: optionalString(value.confidence, filePath, `goal ${key}.lastReview.confidence`),
    reason: requireString(value.reason, filePath, `goal ${key}.lastReview.reason`),
    remainingWork: optionalString(
      value.remainingWork,
      filePath,
      `goal ${key}.lastReview.remainingWork`,
    ),
    blockers: normalizeStringArray(value.blockers, filePath, `goal ${key}.lastReview.blockers`),
    artifactRef: optionalString(value.artifactRef, filePath, `goal ${key}.lastReview.artifactRef`),
    reviewedAt: requireString(value.reviewedAt, filePath, `goal ${key}.lastReview.reviewedAt`),
  };
}

function normalizeGoalStatus(
  value: unknown,
  filePath: string,
  key: string,
): SparkProjectGoalStatus {
  if (value === "active" || value === "paused" || value === "complete") return value;
  throw new JsonStoreFormatError(
    filePath,
    `goal ${key}.status must be active, paused, or complete`,
  );
}

function normalizeGoalSource(
  value: unknown,
  filePath: string,
  key: string,
): SparkProjectGoalSource {
  if (value === "explicit" || value === "inferred" || value === "agent" || value === "reviewer")
    return value;
  throw new JsonStoreFormatError(
    filePath,
    `goal ${key}.source must be explicit, inferred, agent, or reviewer`,
  );
}

function normalizeStringArray(value: unknown, filePath: string, path: string): string[] {
  if (!Array.isArray(value)) throw new JsonStoreFormatError(filePath, `${path} must be an array`);
  return value.map((entry, index) => requireString(entry, filePath, `${path}[${index}]`));
}

function requireBoolean(value: unknown, filePath: string, path: string): boolean {
  if (typeof value !== "boolean")
    throw new JsonStoreFormatError(filePath, `${path} must be a boolean`);
  return value;
}

function requireString(value: unknown, filePath: string, path: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new JsonStoreFormatError(filePath, `${path} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, filePath: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new JsonStoreFormatError(filePath, `${path} must be a string`);
  return value.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
