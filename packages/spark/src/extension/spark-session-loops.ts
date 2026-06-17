import { randomUUID } from "node:crypto";

import { nowIso } from "@zendev-lab/pi-extension-api";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  legacySessionLoopStorePath,
  rebuildSessionIndex,
  sessionLoopStorePathV2,
} from "./session-directory-store.ts";
import { sparkSessionOwnerKey, type SparkSessionContext } from "./session-identity.ts";

export type SparkSessionLoopStatus = "active" | "paused";
export type SparkSessionLoopSource = "explicit" | "inferred";

export interface SparkSessionLoopRetryState {
  consecutiveFailures: number;
  lastFailureAt?: string;
  nextDelayMs?: number;
  exhaustedAt?: string;
}

export interface SparkSessionLoop {
  version: 1;
  loopId: string;
  sessionKey: string;
  objective: string;
  status: SparkSessionLoopStatus;
  source: SparkSessionLoopSource;
  pauseReason?: string;
  retryState?: SparkSessionLoopRetryState;
  createdAt: string;
  updatedAt: string;
}

interface SparkSessionLoopSnapshot {
  version: 1;
  loop?: SparkSessionLoop;
}

export function sessionLoopStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return sessionLoopStorePathV2(cwd, ctx);
}

export async function importLegacySessionLoop(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionLoop | undefined> {
  const filePath = legacySessionLoopStorePath(cwd, ctx);
  const snapshot = await loadSessionLoopSnapshotFromPath(filePath, sparkSessionOwnerKey(ctx));
  if (!snapshot.loop) return undefined;
  await saveSessionLoopSnapshot(cwd, ctx, snapshot);
  return snapshot.loop;
}

export async function loadSessionLoop(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionLoop | undefined> {
  return (await loadSessionLoopSnapshot(cwd, ctx)).loop;
}

export async function setSessionLoop(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  input: { objective: string; source: SparkSessionLoopSource; status?: SparkSessionLoopStatus },
): Promise<SparkSessionLoop> {
  const objective = normalizeLoopObjective(input.objective);
  const now = nowIso();
  const loop: SparkSessionLoop = {
    version: 1,
    loopId: randomUUID(),
    sessionKey: sparkSessionOwnerKey(ctx),
    objective,
    status: input.status ?? "active",
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
  await saveSessionLoopSnapshot(cwd, ctx, { version: 1, loop });
  return loop;
}

export async function clearSessionLoop(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await saveSessionLoopSnapshot(cwd, ctx, { version: 1 });
}

export async function updateSessionLoopStatus(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  status: SparkSessionLoopStatus,
  options: {
    reason?: string;
    retryState?: SparkSessionLoopRetryState | null;
    expectedLoopId?: string;
  } = {},
): Promise<SparkSessionLoop | undefined> {
  const snapshot = await loadSessionLoopSnapshot(cwd, ctx);
  const existing = snapshot.loop;
  if (!existing) return undefined;
  if (options.expectedLoopId && existing.loopId !== options.expectedLoopId) return undefined;
  const loop: SparkSessionLoop = {
    ...existing,
    status,
    pauseReason: status === "paused" ? normalizeOptionalReason(options.reason) : undefined,
    retryState:
      options.retryState === undefined ? existing.retryState : (options.retryState ?? undefined),
    updatedAt: nowIso(),
  };
  await saveSessionLoopSnapshot(cwd, ctx, { version: 1, loop });
  return loop;
}

export function normalizeLoopObjective(value: unknown): string {
  if (typeof value !== "string") throw new Error("loop objective must be a string");
  const objective = value.trim();
  if (!objective) throw new Error("loop objective must not be empty");
  if (Array.from(objective).length > 8_000)
    throw new Error("loop objective must be 8000 characters or fewer");
  return objective;
}

function normalizeOptionalReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("loop reason must be a string");
  return value.trim() || undefined;
}

async function loadSessionLoopSnapshot(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionLoopSnapshot> {
  return loadSessionLoopSnapshotFromPath(sessionLoopStorePath(cwd, ctx), sparkSessionOwnerKey(ctx));
}

async function loadSessionLoopSnapshotFromPath(
  filePath: string,
  expectedSessionKey: string,
): Promise<SparkSessionLoopSnapshot> {
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return { version: 1 };
  if (raw.version !== 1) throw new JsonStoreFormatError(filePath, "version must be 1");
  return {
    version: 1,
    loop:
      raw.loop === undefined
        ? undefined
        : normalizeSessionLoop(raw.loop, filePath, expectedSessionKey),
  };
}

async function saveSessionLoopSnapshot(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  snapshot: SparkSessionLoopSnapshot,
): Promise<void> {
  await writeJsonFileAtomic(sessionLoopStorePath(cwd, ctx), snapshot);
  await rebuildSessionIndex(cwd);
}

function normalizeSessionLoop(
  value: unknown,
  filePath: string,
  expectedSessionKey: string,
): SparkSessionLoop {
  if (!isRecord(value)) throw new JsonStoreFormatError(filePath, "loop must be an object");
  if (value.version !== 1) throw new JsonStoreFormatError(filePath, "loop.version must be 1");
  const sessionKey = requireString(value.sessionKey, filePath, "loop.sessionKey");
  if (sessionKey !== expectedSessionKey)
    throw new JsonStoreFormatError(filePath, "loop.sessionKey must match the current session");
  return {
    version: 1,
    loopId: requireString(value.loopId, filePath, "loop.loopId"),
    sessionKey,
    objective: requireString(value.objective, filePath, "loop.objective"),
    status: normalizeLoopStatus(value.status, filePath),
    source: normalizeLoopSource(value.source, filePath),
    pauseReason: optionalString(value.pauseReason, filePath, "loop.pauseReason"),
    retryState:
      value.retryState === undefined
        ? undefined
        : normalizeLoopRetryState(value.retryState, filePath),
    createdAt: requireString(value.createdAt, filePath, "loop.createdAt"),
    updatedAt: requireString(value.updatedAt, filePath, "loop.updatedAt"),
  };
}

function normalizeLoopStatus(value: unknown, filePath: string): SparkSessionLoopStatus {
  if (value === "active" || value === "paused") return value;
  throw new JsonStoreFormatError(filePath, "loop.status must be active or paused");
}

function normalizeLoopSource(value: unknown, filePath: string): SparkSessionLoopSource {
  if (value === "explicit" || value === "inferred") return value;
  throw new JsonStoreFormatError(filePath, "loop.source must be explicit or inferred");
}

function normalizeLoopRetryState(value: unknown, filePath: string): SparkSessionLoopRetryState {
  if (!isRecord(value)) throw new JsonStoreFormatError(filePath, "loop.retryState must be object");
  return {
    consecutiveFailures: requireNumber(
      value.consecutiveFailures,
      filePath,
      "loop.retryState.consecutiveFailures",
    ),
    lastFailureAt: optionalString(value.lastFailureAt, filePath, "loop.retryState.lastFailureAt"),
    nextDelayMs: optionalNumber(value.nextDelayMs, filePath, "loop.retryState.nextDelayMs"),
    exhaustedAt: optionalString(value.exhaustedAt, filePath, "loop.retryState.exhaustedAt"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireString(value: unknown, filePath: string, field: string): string {
  if (typeof value === "string") return value;
  throw new JsonStoreFormatError(filePath, `${field} must be a string`);
}

function optionalString(value: unknown, filePath: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new JsonStoreFormatError(filePath, `${field} must be a string when present`);
}

function requireNumber(value: unknown, filePath: string, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new JsonStoreFormatError(filePath, `${field} must be a finite number`);
}

function optionalNumber(value: unknown, filePath: string, field: string): number | undefined {
  if (value === undefined) return undefined;
  return requireNumber(value, filePath, field);
}
