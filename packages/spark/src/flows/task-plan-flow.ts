import type { ArtifactRef, Task, TaskPlan, TaskPlanIssue } from "spark-core";
import { taskPlanReadiness } from "spark-tasks";

export interface TaskPlanDecisionResult {
  asked: boolean;
  accepted: boolean;
  blocked: boolean;
  artifactRef?: ArtifactRef;
  summary?: string;
  plan: TaskPlan;
  issues: TaskPlanIssue[];
}

export function decideTaskPlanBeforeCreate(input: {
  cwd: string;
  task: Task;
  ui?: unknown;
}): TaskPlanDecisionResult {
  void input.cwd;
  void input.ui;
  const readiness = taskPlanReadiness(input.task);
  const plan = input.task.plan as TaskPlan;
  if (readiness.ready) {
    return { asked: false, accepted: true, blocked: false, plan, issues: [] };
  }

  return {
    asked: false,
    accepted: false,
    blocked: true,
    plan,
    issues: readiness.issues,
    summary: summarizeTaskPlanIssues(input.task, readiness.issues),
  };
}

function summarizeTaskPlanIssues(task: Task, issues: TaskPlanIssue[]): string {
  const issueSummary = issues.map((issue) => issue.message).join(" ");
  return `Task @${task.name} “${task.title}” needs a concrete, context-specific plan before creation or update. ${issueSummary}`;
}
