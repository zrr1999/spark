export const GOAL_CUSTOM_ENTRY_TYPE = "spark-goal";
export const MAX_OBJECTIVE_CHARS = 8000;

export type GoalStatus = "active" | "paused" | "complete";

export interface Goal {
  goalId: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
}

export type GoalEntrySource = "command" | "tool" | "runtime";

export type GoalCustomEntry =
  | {
      version: 1;
      kind: "set";
      source: GoalEntrySource;
      goal: Goal;
      at: number;
    }
  | {
      version: 1;
      kind: "clear";
      source: GoalEntrySource;
      clearedGoalId: string | null;
      at: number;
    }
  | {
      version: 1;
      kind: "host_overflow_cap_reset";
      active: boolean;
      at: number;
    };

export interface GoalResult {
  ok: boolean;
  message: string;
  goal: Goal | null;
}

export interface GoalSnapshot {
  goal: Goal | null;
  hasGoal: boolean;
}

export interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}
