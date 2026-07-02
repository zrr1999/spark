import { randomUUID } from "node:crypto";

import {
  LOOP_CUSTOM_ENTRY_TYPE,
  MAX_LOOP_OBJECTIVE_CHARS,
  type LoopBlocker,
  type LoopCustomEntry,
  type LoopEntrySource,
  type LoopResult,
  type LoopSnapshot,
  type LoopState,
  type LoopStatus,
  type LoopTickReason,
  type SessionEntryLike,
} from "./types.ts";

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cloneLoop(loop: LoopState): LoopState {
  const cloned: LoopState = {
    ...loop,
    tick: { ...loop.tick },
  };
  if (loop.blocker) cloned.blocker = cloneLoopBlocker(loop.blocker);
  return cloned;
}

export function loopsEquivalent(left: LoopState, right: LoopState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateLoopObjective(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) return "Loop objective must not be empty.";
  if (Array.from(trimmed).length > MAX_LOOP_OBJECTIVE_CHARS) {
    return `Loop objective must be ${MAX_LOOP_OBJECTIVE_CHARS} characters or fewer.`;
  }
  return null;
}

export function createLoop(objective: string, now = unixSeconds()): LoopState {
  return {
    loopId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    tick: {
      count: 0,
      consecutiveFailures: 0,
    },
  };
}

export function createLoopResult(current: LoopState | null, objective: string): LoopResult {
  if (current) {
    return {
      ok: false,
      message:
        "cannot create a new loop because this session already has a loop; clear or replace it before creating a new one",
      loop: current,
    };
  }
  const objectiveError = validateLoopObjective(objective);
  if (objectiveError) return { ok: false, message: objectiveError, loop: null };
  return { ok: true, message: "Loop created.", loop: createLoop(objective) };
}

export function replaceLoop(objective: string): LoopResult {
  const objectiveError = validateLoopObjective(objective);
  if (objectiveError) return { ok: false, message: objectiveError, loop: null };
  return { ok: true, message: "Loop set.", loop: createLoop(objective) };
}

export function updateLoopStatus(current: LoopState | null, status: LoopStatus): LoopResult {
  if (!current) return { ok: false, message: "No active loop exists.", loop: null };
  if (status === "paused" && current.status !== "active") {
    return { ok: false, message: "Only active loops can be paused.", loop: current };
  }
  if (status === "active" && current.status !== "paused") {
    return { ok: false, message: "Only paused loops can be resumed.", loop: current };
  }
  const loop = cloneLoop(current);
  loop.status = status;
  loop.updatedAt = unixSeconds();
  if (status === "active") loop.blocker = undefined;
  return { ok: true, message: `Loop marked ${loop.status}.`, loop };
}

export function recordLoopTick(
  current: LoopState,
  reason: LoopTickReason = "manual",
  now = unixSeconds(),
): LoopState {
  const loop = cloneLoop(current);
  loop.tick.count += 1;
  loop.tick.lastReason = reason;
  loop.tick.awaitingTurnSince = now;
  loop.updatedAt = now;
  return loop;
}

export function recordLoopFailure(
  current: LoopState,
  policy: { retryBackoffMs?: readonly number[]; retryBudget?: number } = {},
  now = unixSeconds(),
): LoopState {
  const loop = cloneLoop(current);
  loop.tick.consecutiveFailures += 1;
  const backoff = policy.retryBackoffMs?.[loop.tick.consecutiveFailures - 1];
  if (backoff !== undefined) loop.tick.nextRunAt = now + Math.ceil(backoff / 1000);
  loop.updatedAt = now;
  return loop;
}

export function clearLoopFailure(current: LoopState, now = unixSeconds()): LoopState {
  const loop = cloneLoop(current);
  loop.tick.consecutiveFailures = 0;
  loop.tick.nextRunAt = undefined;
  loop.tick.awaitingTurnSince = undefined;
  loop.updatedAt = now;
  return loop;
}

export function blockLoop(
  current: LoopState,
  reason: string,
  evidenceRefs: string[] = [],
  now = unixSeconds(),
): LoopState {
  const loop = cloneLoop(current);
  loop.blocker = { reason: reason.trim(), since: now, evidenceRefs };
  loop.updatedAt = now;
  return loop;
}

export function setLoopEntry(
  loop: LoopState,
  source: LoopEntrySource,
  at = unixSeconds(),
): LoopCustomEntry {
  return { version: 1, kind: "set", source, loop: cloneLoop(loop), at };
}

export function clearLoopEntry(
  clearedLoopId: string | null,
  source: LoopEntrySource,
  at = unixSeconds(),
): LoopCustomEntry {
  return { version: 1, kind: "clear", source, clearedLoopId, at };
}

export function isLoopCustomEntry(data: unknown): data is LoopCustomEntry {
  if (!data || typeof data !== "object") return false;
  const entry = data as LoopCustomEntry;
  if (entry.version !== 1 || typeof entry.at !== "number") return false;
  if (entry.kind === "clear") {
    return entry.clearedLoopId === null || typeof entry.clearedLoopId === "string";
  }
  return entry.kind === "set" && isLoopState(entry.loop);
}

export function isLoopState(loop: unknown): loop is LoopState {
  if (!loop || typeof loop !== "object") return false;
  const candidate = loop as LoopState;
  return (
    typeof candidate.loopId === "string" &&
    typeof candidate.objective === "string" &&
    isLoopStatus(candidate.status) &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    Boolean(candidate.tick) &&
    typeof candidate.tick === "object" &&
    typeof candidate.tick.count === "number" &&
    typeof candidate.tick.consecutiveFailures === "number" &&
    (candidate.blocker === undefined || isLoopBlocker(candidate.blocker))
  );
}

export function isLoopStatus(status: unknown): status is LoopStatus {
  return status === "active" || status === "paused";
}

export function reconstructLoop(entries: Iterable<SessionEntryLike>): LoopSnapshot {
  let loop: LoopState | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== LOOP_CUSTOM_ENTRY_TYPE) continue;
    if (!isLoopCustomEntry(entry.data)) continue;
    if (entry.data.kind === "clear") loop = null;
    else if (entry.data.kind === "set") loop = cloneLoop(entry.data.loop);
  }
  return { loop, hasLoop: loop !== null };
}

function cloneLoopBlocker(blocker: LoopBlocker): LoopBlocker {
  return {
    ...blocker,
    evidenceRefs: blocker.evidenceRefs ? [...blocker.evidenceRefs] : undefined,
  };
}

function isLoopBlocker(blocker: unknown): blocker is LoopBlocker {
  if (!blocker || typeof blocker !== "object") return false;
  const candidate = blocker as LoopBlocker;
  return (
    typeof candidate.reason === "string" &&
    typeof candidate.since === "number" &&
    (candidate.evidenceRefs === undefined ||
      (Array.isArray(candidate.evidenceRefs) &&
        candidate.evidenceRefs.every((ref) => typeof ref === "string")))
  );
}
