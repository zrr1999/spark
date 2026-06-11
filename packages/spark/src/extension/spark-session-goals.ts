import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { nowIso, type ProjectRef } from "pi-extension-api";
import { isActiveSessionTodo, type SessionTodoEntry, type TaskGraph } from "pi-tasks";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  sanitizeStoreScope,
  sparkSessionOwnerKey,
  type SparkSessionContext,
} from "./session-identity.ts";

export type SparkSessionGoalStatus = "active" | "paused" | "budgetLimited" | "complete";
export type SparkSessionGoalSource = "explicit" | "inferred" | "agent" | "reviewer";
export type SparkGoalScope = "session" | "project";

export interface SparkSessionGoalUsage {
  tokensUsed: number;
  activeSeconds: number;
}

export interface SparkSessionGoalReviewSummary {
  achieved: boolean;
  confidence?: string;
  reason: string;
  remainingWork?: string;
  blockers: string[];
  artifactRef?: string;
  reviewedAt: string;
}

export interface SparkSessionGoalRetryState {
  consecutiveFailures: number;
  lastFailureAt?: string;
  nextDelayMs?: number;
  exhaustedAt?: string;
}

export interface SparkSessionGoal {
  version: 1;
  goalId: string;
  sessionKey: string;
  scope: SparkGoalScope;
  projectRef?: ProjectRef;
  objective: string;
  status: SparkSessionGoalStatus;
  source: SparkSessionGoalSource;
  tokenBudget: number | null;
  usage: SparkSessionGoalUsage;
  pauseReason?: string;
  budgetLimitedReason?: string;
  completedReason?: string;
  lastReview?: SparkSessionGoalReviewSummary;
  retryState?: SparkSessionGoalRetryState;
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
    scope?: SparkGoalScope;
    projectRef?: ProjectRef;
    tokenBudget?: number | null;
  },
): Promise<SparkSessionGoal> {
  const objective = normalizeGoalObjective(input.objective);
  const scope = input.scope ?? "session";
  const projectRef = normalizeGoalProjectRef(scope, input.projectRef);
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  const sameTarget = existing ? sameGoalTarget(existing, scope, projectRef) : false;
  const now = nowIso();
  const goal: SparkSessionGoal = {
    version: 1,
    goalId: existing && sameTarget ? existing.goalId : randomUUID(),
    sessionKey: sparkSessionOwnerKey(ctx),
    scope,
    ...(projectRef ? { projectRef } : {}),
    objective,
    status: input.status ?? "active",
    source: input.source,
    tokenBudget: normalizeTokenBudget(input.tokenBudget),
    usage: emptyGoalUsage(),
    createdAt: existing && sameTarget ? existing.createdAt : now,
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
    lastReview: undefined,
    retryState: undefined,
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
    retryState?: SparkSessionGoalRetryState | null;
    expectedGoalId?: string;
  } = {},
): Promise<SparkSessionGoal | undefined> {
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  if (!existing) return undefined;
  if (options.expectedGoalId && existing.goalId !== options.expectedGoalId) return undefined;
  const goal: SparkSessionGoal = {
    ...existing,
    status,
    pauseReason: status === "paused" ? normalizeOptionalReason(options.reason) : undefined,
    budgetLimitedReason:
      status === "budgetLimited" ? normalizeOptionalReason(options.reason) : undefined,
    completedReason: status === "complete" ? normalizeOptionalReason(options.reason) : undefined,
    lastReview: options.review ?? existing.lastReview,
    retryState:
      options.retryState === undefined ? existing.retryState : (options.retryState ?? undefined),
    updatedAt: nowIso(),
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export async function updateSessionGoalTokenBudget(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  tokenBudget: number | null,
): Promise<SparkSessionGoal | undefined> {
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  if (!existing) return undefined;
  const normalizedBudget = normalizeTokenBudget(tokenBudget);
  const budgetExhausted = isSessionGoalBudgetExhausted({
    ...existing,
    tokenBudget: normalizedBudget,
  });
  const goal: SparkSessionGoal = {
    ...existing,
    tokenBudget: normalizedBudget,
    status:
      existing.status === "complete"
        ? "complete"
        : budgetExhausted
          ? "budgetLimited"
          : existing.status === "budgetLimited"
            ? "active"
            : existing.status,
    budgetLimitedReason: budgetExhausted
      ? (existing.budgetLimitedReason ??
        `token budget exhausted (${existing.usage.tokensUsed}/${normalizedBudget})`)
      : undefined,
    updatedAt: nowIso(),
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return goal;
}

export async function applySessionGoalUsage(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  input: {
    goalId?: string;
    tokensUsedDelta?: number;
    activeSecondsDelta?: number;
  },
): Promise<{ goal?: SparkSessionGoal; changed: boolean; crossedBudget: boolean }> {
  const snapshot = await loadSessionGoalSnapshot(cwd, ctx);
  const existing = snapshot.goal;
  if (!existing) return { changed: false, crossedBudget: false };
  if (input.goalId && existing.goalId !== input.goalId)
    return { goal: existing, changed: false, crossedBudget: false };
  if (existing.status !== "active") return { goal: existing, changed: false, crossedBudget: false };
  const tokensUsedDelta = normalizeUsageDelta(input.tokensUsedDelta);
  const activeSecondsDelta = normalizeUsageDelta(input.activeSecondsDelta);
  if (tokensUsedDelta === 0 && activeSecondsDelta === 0)
    return { goal: existing, changed: false, crossedBudget: false };
  const usage = {
    tokensUsed: existing.usage.tokensUsed + tokensUsedDelta,
    activeSeconds: existing.usage.activeSeconds + activeSecondsDelta,
  };
  const wasUnderBudget = !isSessionGoalBudgetExhausted(existing);
  const crossedBudget =
    wasUnderBudget && existing.tokenBudget !== null && usage.tokensUsed >= existing.tokenBudget;
  const goal: SparkSessionGoal = {
    ...existing,
    status: crossedBudget ? "budgetLimited" : existing.status,
    usage,
    budgetLimitedReason: crossedBudget
      ? `token budget exhausted (${usage.tokensUsed}/${existing.tokenBudget})`
      : undefined,
    retryState: crossedBudget ? undefined : existing.retryState,
    updatedAt: nowIso(),
  };
  await saveSessionGoalSnapshot(cwd, ctx, { version: 1, goal });
  return { goal, changed: true, crossedBudget };
}

export function isSessionGoalBudgetExhausted(
  goal: Pick<SparkSessionGoal, "tokenBudget" | "usage">,
): boolean {
  return goal.tokenBudget !== null && goal.usage.tokensUsed >= goal.tokenBudget;
}

export function inferSessionGoalObjective(
  graph: TaskGraph,
  project?: SparkProject,
  independentTodos: SessionTodoEntry[] = [],
): string | undefined {
  const activeTodos = independentTodos.filter(isActiveSessionTodo);
  if (activeTodos.length > 0)
    return "处理当前 active session TODO：逐项完成、取消、删除或明确等待条件，直到没有 active session TODO 阻塞 goal completion review。";
  if (project) return inferProjectBackedSessionGoalObjective(graph, project);
  const activeSessionProjects = graph.projects().filter((candidate) => candidate.status !== "done");
  if (activeSessionProjects.length === 1)
    return inferProjectBackedSessionGoalObjective(graph, activeSessionProjects[0]!);
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

export function sameGoalTarget(
  goal: Pick<SparkSessionGoal, "scope" | "projectRef">,
  scope: SparkGoalScope,
  projectRef?: ProjectRef,
): boolean {
  return goal.scope === scope && (goal.projectRef ?? undefined) === (projectRef ?? undefined);
}

function normalizeGoalProjectRef(
  scope: SparkGoalScope,
  projectRef: ProjectRef | undefined,
): ProjectRef | undefined {
  if (scope === "session") return undefined;
  if (!projectRef) throw new Error("project goal scope requires a current project");
  return projectRef;
}

function inferProjectBackedSessionGoalObjective(_graph: TaskGraph, project: SparkProject): string {
  return `Advance project “${project.title}” to completion.`;
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
    scope: normalizeGoalScope(value.scope, filePath),
    projectRef: normalizeStoredGoalProjectRef(value.scope, value.projectRef, filePath),
    objective: requireString(value.objective, filePath, "goal.objective"),
    status,
    source,
    tokenBudget: normalizeStoredTokenBudget(value.tokenBudget, filePath),
    usage: normalizeGoalUsage(value.usage, filePath),
    pauseReason: optionalString(value.pauseReason, filePath, "goal.pauseReason"),
    budgetLimitedReason: optionalString(
      value.budgetLimitedReason,
      filePath,
      "goal.budgetLimitedReason",
    ),
    completedReason: optionalString(value.completedReason, filePath, "goal.completedReason"),
    lastReview:
      value.lastReview === undefined ? undefined : normalizeGoalReview(value.lastReview, filePath),
    retryState:
      value.retryState === undefined
        ? undefined
        : normalizeGoalRetryState(value.retryState, filePath),
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

function normalizeGoalRetryState(value: unknown, filePath: string): SparkSessionGoalRetryState {
  if (!isRecord(value))
    throw new JsonStoreFormatError(filePath, "goal.retryState must be an object");
  return {
    consecutiveFailures: requireNonNegativeInteger(
      value.consecutiveFailures,
      filePath,
      "goal.retryState.consecutiveFailures",
    ),
    lastFailureAt: optionalString(value.lastFailureAt, filePath, "goal.retryState.lastFailureAt"),
    nextDelayMs:
      value.nextDelayMs === undefined
        ? undefined
        : requireNonNegativeInteger(value.nextDelayMs, filePath, "goal.retryState.nextDelayMs"),
    exhaustedAt: optionalString(value.exhaustedAt, filePath, "goal.retryState.exhaustedAt"),
  };
}

function normalizeGoalStatus(value: unknown, filePath: string): SparkSessionGoalStatus {
  if (value === "active" || value === "paused" || value === "budgetLimited" || value === "complete")
    return value;
  throw new JsonStoreFormatError(
    filePath,
    "goal.status must be active, paused, budgetLimited, or complete",
  );
}

function normalizeGoalSource(value: unknown, filePath: string): SparkSessionGoalSource {
  if (value === "explicit" || value === "inferred" || value === "agent" || value === "reviewer")
    return value;
  throw new JsonStoreFormatError(
    filePath,
    "goal.source must be explicit, inferred, agent, or reviewer",
  );
}

function normalizeGoalScope(value: unknown, filePath: string): SparkGoalScope {
  if (value === undefined) return "session";
  if (value === "session" || value === "project") return value;
  throw new JsonStoreFormatError(filePath, "goal.scope must be session or project");
}

function normalizeStoredTokenBudget(value: unknown, filePath: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new JsonStoreFormatError(filePath, "goal.tokenBudget must be a positive integer or null");
  return value;
}

function normalizeTokenBudget(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error("goal tokenBudget must be a positive integer");
  return value;
}

function emptyGoalUsage(): SparkSessionGoalUsage {
  return { tokensUsed: 0, activeSeconds: 0 };
}

function normalizeGoalUsage(value: unknown, filePath: string): SparkSessionGoalUsage {
  if (value === undefined) return emptyGoalUsage();
  if (!isRecord(value)) throw new JsonStoreFormatError(filePath, "goal.usage must be an object");
  return {
    tokensUsed: requireNonNegativeInteger(value.tokensUsed, filePath, "goal.usage.tokensUsed"),
    activeSeconds: requireNonNegativeInteger(
      value.activeSeconds,
      filePath,
      "goal.usage.activeSeconds",
    ),
  };
}

function normalizeUsageDelta(value: number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeStoredGoalProjectRef(
  scopeValue: unknown,
  projectRefValue: unknown,
  filePath: string,
): ProjectRef | undefined {
  const scope = normalizeGoalScope(scopeValue, filePath);
  if (scope === "session") {
    if (projectRefValue !== undefined)
      throw new JsonStoreFormatError(filePath, "session goal.projectRef must be absent");
    return undefined;
  }
  return requireString(projectRefValue, filePath, "goal.projectRef") as ProjectRef;
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

function requireNonNegativeInteger(value: unknown, filePath: string, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new JsonStoreFormatError(filePath, `${path} must be a non-negative integer`);
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
