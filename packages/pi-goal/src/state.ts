import { randomUUID } from "node:crypto";

import {
  GOAL_CUSTOM_ENTRY_TYPE,
  MAX_OBJECTIVE_CHARS,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalResult,
  type GoalSnapshot,
  type GoalStatus,
  type SessionEntryLike,
  type Goal,
} from "./types.ts";

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cloneGoal(goal: Goal): Goal {
  return { ...goal };
}

export function goalsEquivalent(left: Goal, right: Goal): boolean {
  return (
    left.goalId === right.goalId &&
    left.objective === right.objective &&
    left.status === right.status &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

export function validateObjective(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    return "Objective must not be empty.";
  }
  if (Array.from(trimmed).length > MAX_OBJECTIVE_CHARS) {
    return `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.`;
  }
  return null;
}

export function createGoal(objective: string, now = unixSeconds()): Goal {
  return {
    goalId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

export function setEntry(goal: Goal, source: GoalEntrySource, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "set",
    source,
    goal: cloneGoal(goal),
    at,
  };
}

export function clearEntry(
  clearedGoalId: string | null,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "clear",
    source,
    clearedGoalId,
    at,
  };
}

export function hostOverflowCapResetEntry(active: boolean, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "host_overflow_cap_reset",
    active,
    at,
  };
}

export function isGoalCustomEntry(data: unknown): data is GoalCustomEntry {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data as GoalCustomEntry;
  if (entry.version !== 1 || typeof entry.at !== "number") {
    return false;
  }
  if (entry.kind === "clear") {
    return entry.clearedGoalId === null || typeof entry.clearedGoalId === "string";
  }
  if (entry.kind === "host_overflow_cap_reset") {
    return typeof entry.active === "boolean";
  }
  return entry.kind === "set" && isGoal(entry.goal);
}

export function isGoal(goal: unknown): goal is Goal {
  if (!goal || typeof goal !== "object") {
    return false;
  }
  const candidate = goal as Goal;
  return (
    typeof candidate.goalId === "string" &&
    typeof candidate.objective === "string" &&
    isGoalStatus(candidate.status) &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number"
  );
}

export function isGoalStatus(status: unknown): status is GoalStatus {
  return status === "active" || status === "paused" || status === "complete";
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): GoalSnapshot {
  let goal: Goal | null = null;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GOAL_CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "clear") {
      goal = null;
    } else if (entry.data.kind === "set") {
      goal = cloneGoal(entry.data.goal);
    }
  }

  return {
    goal,
    hasGoal: goal !== null,
  };
}

export function reconstructHostOverflowCapNeedsUserReset(
  entries: Iterable<SessionEntryLike>,
): boolean {
  let needsReset = false;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GOAL_CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "host_overflow_cap_reset") {
      needsReset = entry.data.active;
    }
  }

  return needsReset;
}

export function createGoalResult(current: Goal | null, objective: string): GoalResult {
  if (current && current.status !== "complete") {
    return {
      ok: false,
      message:
        "cannot create a new goal because this Spark project already has a non-complete goal; mark it complete, clear it, or replace it before creating a new one",
      goal: current,
    };
  }

  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const goal = createGoal(objective);
  return {
    ok: true,
    message: "Goal created.",
    goal,
  };
}

export function replaceGoal(objective: string): GoalResult {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const goal = createGoal(objective);
  return {
    ok: true,
    message: "Goal set.",
    goal,
  };
}

export function updateGoalStatus(current: Goal | null, status: GoalStatus): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  if (current.status === "complete") {
    if (status === "complete") {
      return {
        ok: true,
        message: "Goal already complete.",
        goal: current,
      };
    }
    return {
      ok: false,
      message:
        "Completed goals are terminal; replace or clear the Spark goal before changing status.",
      goal: current,
    };
  }

  if (status === "complete") {
    const goal = cloneGoal(current);
    goal.status = "complete";
    goal.updatedAt = unixSeconds();
    return {
      ok: true,
      message: "Goal marked complete.",
      goal,
    };
  }

  if (status === "paused" && current.status !== "active") {
    return {
      ok: false,
      message: "Only active goals can be paused.",
      goal: current,
    };
  }

  if (status === "active" && current.status !== "paused") {
    return {
      ok: false,
      message: "Only paused goals can be resumed.",
      goal: current,
    };
  }

  const goal = cloneGoal(current);
  goal.status = status;
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: `Goal marked ${goal.status}.`,
    goal,
  };
}
