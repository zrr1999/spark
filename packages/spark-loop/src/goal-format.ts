import type { Goal, GoalStatus } from "./goal-types.ts";

export interface GoalToolRecord {
  goalId: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface GoalToolResponse {
  goal: GoalToolRecord | null;
}

export function formatGoalSummary(goal: Goal | null): string {
  if (!goal) {
    return "No Spark goal is currently set.";
  }
  return [
    `Status: ${statusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Hint: ${commandHint(goal.status)}`,
  ].join("\n");
}

function statusLabel(status: GoalStatus): string {
  return status;
}

function commandHint(status: GoalStatus): string {
  if (status === "active") {
    return "pause or clear the Spark goal";
  }
  if (status === "paused") {
    return "resume or clear the Spark goal";
  }
  return "replace or clear the Spark goal";
}

export function formatFooterStatus(goal: Goal | null): string | undefined {
  if (!goal) {
    return undefined;
  }
  if (goal.status === "active") {
    return "Pursuing goal";
  }
  if (goal.status === "paused") {
    return "Goal paused";
  }
  return "Goal achieved";
}

export function toToolGoal(goal: Goal): GoalToolRecord {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function goalToolResponse(goal: Goal | null): GoalToolResponse {
  return { goal: goal ? toToolGoal(goal) : null };
}

export function toToolText(goal: Goal | null): string {
  return formatGoalSummary(goal);
}
