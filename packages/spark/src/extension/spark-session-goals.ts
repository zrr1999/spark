import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { nowIso } from "pi-extension-api";
import { isUnfinishedTaskStatus, type TaskGraph } from "pi-tasks";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  sanitizeStoreScope,
  sparkSessionOwnerKey,
  type SparkSessionContext,
} from "./session-identity.ts";

export type SparkSessionGoalStatus = "active" | "paused" | "complete";
export type SparkSessionGoalSource = "explicit" | "inferred" | "agent" | "reviewer";

export interface SparkSessionGoalReviewSummary {
  achieved: boolean;
  confidence?: string;
  reason: string;
  remainingWork?: string;
  blockers: string[];
  artifactRef?: string;
  reviewedAt: string;
}

export interface SparkSessionGoal {
  version: 1;
  goalId: string;
  sessionKey: string;
  objective: string;
  status: SparkSessionGoalStatus;
  source: SparkSessionGoalSource;
  pauseReason?: string;
  completedReason?: string;
  lastReview?: SparkSessionGoalReviewSummary;
  createdAt: string;
  updatedAt: string;
}

interface SparkSessionGoalSnapshot {
  version: 1;
  goal?: SparkSessionGoal;
}

type SparkProject = ReturnType<TaskGraph["projects"]>[number];

export function sessionGoalStorePath(cwd: string, ctx?: SparkSessionContext): string {
  const fileName = `${sanitizeStoreScope(sparkSessionOwnerKey(ctx))}.json`;
  return join(cwd, ".spark", "session-goals", fileName);
}

export async function loadSessionGoal(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionGoal | undefined> {
  return (await loadSessionGoalSnapshot(cwd, ctx)).goal;
}

export async function setSessionGoal(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  input: {
    objective: string;
    source: SparkSessionGoalSource;
    status?: SparkSessionGoalStatus;
  },
): Promise<SparkSessionGoal> {
  const objective = normalizeGoalObjective(input.objective);
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  const now = nowIso();
  const goal: SparkSessionGoal = {
    version: 1,
    goalId: existing?.goalId ?? randomUUID(),
    sessionKey: sparkSessionOwnerKey(ctx),
    objective,
    status: input.status ?? "active",
    source: input.source,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export async function updateSessionGoalStatus(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  status: SparkSessionGoalStatus,
  options: { reason?: string; review?: SparkSessionGoalReviewSummary } = {},
): Promise<SparkSessionGoal | undefined> {
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  if (!existing) return undefined;
  const goal: SparkSessionGoal = {
    ...existing,
    status,
    pauseReason: status === "paused" ? normalizeOptionalReason(options.reason) : undefined,
    completedReason: status === "complete" ? normalizeOptionalReason(options.reason) : undefined,
    lastReview: options.review ?? existing.lastReview,
    updatedAt: nowIso(),
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export function inferSessionGoalObjective(graph: TaskGraph, project?: SparkProject): string {
  if (project) return inferProjectBackedSessionGoalObjective(graph, project);

  const activeProjects = graph.projects().filter((candidate) => candidate.status !== "done");
  const unfinished = activeProjects.flatMap((candidate) =>
    graph.tasks(candidate.ref).filter((task) => isUnfinishedTaskStatus(task.status)),
  );
  const ready = activeProjects.flatMap((candidate) => graph.readyTasks(candidate.ref));
  const lines = [
    "Advance this Spark session to the next verified outcome.",
    `Active projects: ${activeProjects.length}. Unfinished tasks: ${unfinished.length}. Ready tasks: ${ready.length}.`,
  ];
  const projectTitles = activeProjects.slice(0, 5).map((candidate) => candidate.title);
  if (projectTitles.length > 0)
    lines.push(`Active project candidates: ${projectTitles.join("; ")}.`);
  const readyTitles = ready.slice(0, 5).map((task) => task.title);
  if (readyTitles.length > 0) lines.push(`Ready frontier: ${readyTitles.join("; ")}.`);
  const blockedCount = unfinished.filter((task) => task.status === "blocked").length;
  if (blockedCount > 0)
    lines.push(`Blocked tasks: ${blockedCount}; clarify blockers before claiming work.`);
  lines.push(
    "Goal policy: claim and complete concrete ready tasks, verify required evidence, revise task decomposition when it is missing or wrong, and pause or report when a user decision is needed.",
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

function inferProjectBackedSessionGoalObjective(graph: TaskGraph, project: SparkProject): string {
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
    "Goal policy: claim and complete concrete ready tasks, verify required evidence, revise task decomposition when it is missing or wrong, and pause or report when a user decision is needed.",
  );
  return lines.join("\n");
}

async function loadSessionGoalSnapshot(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionGoalSnapshot> {
  const filePath = sessionGoalStorePath(cwd, ctx);
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return { version: 1 };
  if (raw.version !== 1) throw new JsonStoreFormatError(filePath, "version must be 1");
  return {
    version: 1,
    goal:
      raw.goal === undefined
        ? undefined
        : normalizeSessionGoal(raw.goal, filePath, sparkSessionOwnerKey(ctx)),
  };
}

async function saveSessionGoalSnapshot(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  snapshot: SparkSessionGoalSnapshot,
): Promise<void> {
  await writeJsonFileAtomic(sessionGoalStorePath(cwd, ctx), snapshot);
}

function normalizeSessionGoal(
  value: unknown,
  filePath: string,
  expectedSessionKey: string,
): SparkSessionGoal {
  if (!isRecord(value)) throw new JsonStoreFormatError(filePath, "goal must be an object");
  if (value.version !== 1) throw new JsonStoreFormatError(filePath, "goal.version must be 1");
  const status = normalizeGoalStatus(value.status, filePath);
  const source = normalizeGoalSource(value.source, filePath);
  const sessionKey = requireString(value.sessionKey, filePath, "goal.sessionKey");
  if (sessionKey !== expectedSessionKey)
    throw new JsonStoreFormatError(filePath, "goal.sessionKey must match the current session");
  return {
    version: 1,
    goalId: requireString(value.goalId, filePath, "goal.goalId"),
    sessionKey,
    objective: requireString(value.objective, filePath, "goal.objective"),
    status,
    source,
    pauseReason: optionalString(value.pauseReason, filePath, "goal.pauseReason"),
    completedReason: optionalString(value.completedReason, filePath, "goal.completedReason"),
    lastReview:
      value.lastReview === undefined ? undefined : normalizeGoalReview(value.lastReview, filePath),
    createdAt: requireString(value.createdAt, filePath, "goal.createdAt"),
    updatedAt: requireString(value.updatedAt, filePath, "goal.updatedAt"),
  };
}

function normalizeGoalReview(value: unknown, filePath: string): SparkSessionGoalReviewSummary {
  if (!isRecord(value))
    throw new JsonStoreFormatError(filePath, "goal.lastReview must be an object");
  return {
    achieved: requireBoolean(value.achieved, filePath, "goal.lastReview.achieved"),
    confidence: optionalString(value.confidence, filePath, "goal.lastReview.confidence"),
    reason: requireString(value.reason, filePath, "goal.lastReview.reason"),
    remainingWork: optionalString(value.remainingWork, filePath, "goal.lastReview.remainingWork"),
    blockers: normalizeStringArray(value.blockers, filePath, "goal.lastReview.blockers"),
    artifactRef: optionalString(value.artifactRef, filePath, "goal.lastReview.artifactRef"),
    reviewedAt: requireString(value.reviewedAt, filePath, "goal.lastReview.reviewedAt"),
  };
}

function normalizeGoalStatus(value: unknown, filePath: string): SparkSessionGoalStatus {
  if (value === "active" || value === "paused" || value === "complete") return value;
  throw new JsonStoreFormatError(filePath, "goal.status must be active, paused, or complete");
}

function normalizeGoalSource(value: unknown, filePath: string): SparkSessionGoalSource {
  if (value === "explicit" || value === "inferred" || value === "agent" || value === "reviewer")
    return value;
  throw new JsonStoreFormatError(
    filePath,
    "goal.source must be explicit, inferred, agent, or reviewer",
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
