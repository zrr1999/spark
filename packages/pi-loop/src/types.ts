export const LOOP_CUSTOM_ENTRY_TYPE = "pi-loop";
export const MAX_LOOP_OBJECTIVE_CHARS = 8000;

export type LoopStatus = "active" | "paused";

export interface LoopState {
  loopId: string;
  objective: string;
  status: LoopStatus;
  createdAt: number;
  updatedAt: number;
  tick: LoopTickState;
  blocker?: LoopBlocker;
}

export interface LoopTickState {
  count: number;
  consecutiveFailures: number;
  nextRunAt?: number;
  awaitingTurnSince?: number;
  lastReason?: LoopTickReason;
}

export type LoopTickReason = "start" | "idle" | "retry" | "resume" | "manual";

export type LoopTickDecision = "continue" | "wait" | "paused" | "blocked";

export interface LoopTickInput {
  loop: LoopState | null;
  now?: number;
  reason?: LoopTickReason;
}

export interface LoopTickResult {
  decision: LoopTickDecision;
  loop: LoopState | null;
  message: string;
  prompt?: string;
}

export interface LoopBlocker {
  reason: string;
  since: number;
  evidenceRefs?: string[];
}

export interface LoopPolicy {
  retryBackoffMs?: readonly number[];
  retryBudget?: number;
}

export type LoopEntrySource = "command" | "tool" | "runtime";

export type LoopCustomEntry =
  | {
      version: 1;
      kind: "set";
      source: LoopEntrySource;
      loop: LoopState;
      at: number;
    }
  | {
      version: 1;
      kind: "clear";
      source: LoopEntrySource;
      clearedLoopId: string | null;
      at: number;
    };

export interface LoopSnapshot {
  loop: LoopState | null;
  hasLoop: boolean;
}

export interface LoopResult {
  ok: boolean;
  message: string;
  loop: LoopState | null;
}

export interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}
