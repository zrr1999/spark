import { randomUUID } from "node:crypto";

import { nowIso, type ArtifactRef } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  legacySessionGoalStorePath,
  rebuildSessionIndex,
  sessionGoalStorePathV2,
} from "./session-directory-store.ts";
import { sparkSessionOwnerKey, type SparkSessionContext } from "./session-identity.ts";

export type SparkSessionGoalStatus = "active" | "paused" | "complete";
export type SparkSessionGoalSource = "explicit" | "inferred" | "agent" | "reviewer";

export interface SparkSessionGoalReviewSummary {
  achieved: boolean;
  confidence?: string;
  reason: string;
  remainingWork?: string;
  blockers: string[];
  reviewRef?: string;
  artifactRef?: string;
  reviewedAt: string;
}

export interface SparkSessionGoal {
  version: 1;
  goalId: string;
  sessionKey: string;
  /** Immutable objective captured when the current goal was started/set; edits may refine objective but must not weaken this original user goal. */
  originalObjective: string;
  objective: string;
  status: SparkSessionGoalStatus;
  source: SparkSessionGoalSource;
  pauseReason?: string;
  completedReason?: string;
  lastReviewRef?: string;
  lastReviewArtifactRef?: ArtifactRef;
  lastReviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface SparkSessionGoalSnapshot {
  version: 1;
  goal?: SparkSessionGoal;
}

type SparkProject = ReturnType<TaskGraph["projects"]>[number];

export function sessionGoalStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return sessionGoalStorePathV2(cwd, ctx);
}

export async function importLegacySessionGoal(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionGoal | undefined> {
  const filePath = legacySessionGoalStorePath(cwd, ctx);
  const snapshot = await loadSessionGoalSnapshotFromPath(filePath, sparkSessionOwnerKey(ctx));
  if (!snapshot.goal) return undefined;
  await saveSessionGoalSnapshot(cwd, ctx, snapshot);
  return snapshot.goal;
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
    goalId: existing ? existing.goalId : randomUUID(),
    sessionKey: sparkSessionOwnerKey(ctx),
    originalObjective: objective,
    objective,
    status: input.status ?? "active",
    source: input.source,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export async function clearSessionGoal(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1 });
}

export async function editSessionGoalObjective(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  objective: string,
): Promise<SparkSessionGoal | undefined> {
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  if (!existing) return undefined;
  const goal: SparkSessionGoal = {
    ...existing,
    objective: normalizeGoalObjective(objective),
    source: "explicit",
    lastReviewRef: undefined,
    lastReviewArtifactRef: undefined,
    lastReviewedAt: undefined,
    updatedAt: nowIso(),
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export async function updateSessionGoalStatus(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  status: SparkSessionGoalStatus,
  options: {
    reason?: string;
    review?: SparkSessionGoalReviewSummary;
    expectedGoalId?: string;
  } = {},
): Promise<SparkSessionGoal | undefined> {
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  if (!existing) return undefined;
  if (options.expectedGoalId && existing.goalId !== options.expectedGoalId) return undefined;
  const reviewPointer = options.review ? goalReviewPointerFields(options.review) : {};
  const goal: SparkSessionGoal = {
    ...existing,
    status,
    pauseReason: status === "paused" ? normalizeOptionalReason(options.reason) : undefined,
    completedReason: status === "complete" ? normalizeOptionalReason(options.reason) : undefined,
    ...reviewPointer,
    updatedAt: nowIso(),
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export function inferSessionGoalObjective(
  graph: TaskGraph,
  project?: SparkProject,
): string | undefined {
  if (project) return inferProjectBackedSessionGoalObjective(graph, project);
  const projects = graph.projects();
  if (projects.length === 1) return inferProjectBackedSessionGoalObjective(graph, projects[0]!);
  return undefined;
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

function inferProjectBackedSessionGoalObjective(_graph: TaskGraph, project: SparkProject): string {
  const outcome =
    normalizeProjectOutcomeText(project.purpose) ??
    normalizeProjectOutcomeText(project.description);
  const language = project.outputLanguage === "en" ? "en" : "zh";
  if (outcome) {
    return language === "en"
      ? `Achieve the intended project outcome: ${withTerminalPunctuation(outcome, ".")}`
      : `实现项目预期成果：${withTerminalPunctuation(outcome, "。")}`;
  }
  return language === "en"
    ? `Achieve the intended outcome of “${project.title}”.`
    : `实现“${project.title}”的预期成果。`;
}

function normalizeProjectOutcomeText(value: string | undefined): string | undefined {
  const normalized = value?.replaceAll(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function withTerminalPunctuation(text: string, fallback: "." | "。") {
  return /[.!?。！？]$/u.test(text) ? text : `${text}${fallback}`;
}

async function loadSessionGoalSnapshot(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionGoalSnapshot> {
  return loadSessionGoalSnapshotFromPath(sessionGoalStorePath(cwd, ctx), sparkSessionOwnerKey(ctx));
}

async function loadSessionGoalSnapshotFromPath(
  filePath: string,
  expectedSessionKey: string,
): Promise<SparkSessionGoalSnapshot> {
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return { version: 1 };
  if (raw.version !== 1) throw new JsonStoreFormatError(filePath, "version must be 1");
  return {
    version: 1,
    goal:
      raw.goal === undefined
        ? undefined
        : normalizeSessionGoal(raw.goal, filePath, expectedSessionKey),
  };
}

async function saveSessionGoalSnapshot(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  snapshot: SparkSessionGoalSnapshot,
): Promise<void> {
  const goal = snapshot.goal ? withoutGoalRuntimeState(snapshot.goal) : undefined;
  await writeJsonFileAtomic(sessionGoalStorePath(cwd, ctx), { version: 1, goal });
  await rebuildSessionIndex(cwd, ctx);
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
    originalObjective:
      optionalString(value.originalObjective, filePath, "goal.originalObjective") ??
      requireString(value.objective, filePath, "goal.objective"),
    objective: requireString(value.objective, filePath, "goal.objective"),
    status,
    source,
    pauseReason: optionalString(value.pauseReason, filePath, "goal.pauseReason"),
    completedReason: optionalString(value.completedReason, filePath, "goal.completedReason"),
    ...normalizeGoalReviewPointer(value, filePath),
    createdAt: requireString(value.createdAt, filePath, "goal.createdAt"),
    updatedAt: requireString(value.updatedAt, filePath, "goal.updatedAt"),
  };
}

function withoutGoalRuntimeState(goal: SparkSessionGoal): SparkSessionGoal {
  const { retryState: _retryState, ...canonical } = goal as SparkSessionGoal & {
    retryState?: unknown;
  };
  return canonical;
}

function goalReviewPointerFields(
  review: SparkSessionGoalReviewSummary,
): Pick<SparkSessionGoal, "lastReviewRef" | "lastReviewArtifactRef" | "lastReviewedAt"> {
  const artifactRef = review.artifactRef as ArtifactRef | undefined;
  return {
    lastReviewRef: review.reviewRef ?? artifactRef,
    lastReviewArtifactRef: artifactRef,
    lastReviewedAt: review.reviewedAt,
  };
}

function normalizeGoalReviewPointer(
  value: Record<string, unknown>,
  filePath: string,
): Pick<SparkSessionGoal, "lastReviewRef" | "lastReviewArtifactRef" | "lastReviewedAt"> {
  const legacyReview = value.lastReview;
  const legacyArtifactRef = isRecord(legacyReview)
    ? optionalString(legacyReview.artifactRef, filePath, "goal.lastReview.artifactRef")
    : undefined;
  const legacyReviewedAt = isRecord(legacyReview)
    ? optionalString(legacyReview.reviewedAt, filePath, "goal.lastReview.reviewedAt")
    : undefined;
  const lastReviewRef = optionalString(value.lastReviewRef, filePath, "goal.lastReviewRef");
  const lastReviewArtifactRef = optionalString(
    value.lastReviewArtifactRef,
    filePath,
    "goal.lastReviewArtifactRef",
  );
  const lastReviewedAt = optionalString(value.lastReviewedAt, filePath, "goal.lastReviewedAt");
  return {
    ...(lastReviewRef || legacyArtifactRef
      ? { lastReviewRef: lastReviewRef ?? legacyArtifactRef }
      : {}),
    ...(lastReviewArtifactRef || legacyArtifactRef
      ? { lastReviewArtifactRef: (lastReviewArtifactRef ?? legacyArtifactRef) as ArtifactRef }
      : {}),
    ...(lastReviewedAt || legacyReviewedAt
      ? { lastReviewedAt: lastReviewedAt ?? legacyReviewedAt }
      : {}),
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
