import { compactContinuationPrompt, createSparkGoal } from "spark-goal";

export function renderSparkGoalContinuationPrompt(objective: string): string {
  const trimmed = objective.trim() || "Continue Spark goal execution.";
  const goal = createSparkGoal(trimmed, null, Math.floor(Date.now() / 1000));
  return compactContinuationPrompt(goal);
}

export function sparkGoalObjectiveForNextTask(input: {
  focus?: string;
  nextTaskName?: string;
  nextTaskTitle?: string;
}): string {
  const focus = input.focus?.trim();
  const next = input.nextTaskName
    ? "Continue with @" +
      input.nextTaskName +
      (input.nextTaskTitle ? ": " + input.nextTaskTitle : "")
    : undefined;
  return [focus || "Advance the active Spark goal execution.", next]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n");
}
