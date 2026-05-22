import { Type } from "typebox";

import { type TaskKind, type TaskPlan, type TaskStatus } from "spark-core";

export function taskPlanSchema() {
  return Type.Object({
    objective: Type.Optional(Type.String({ description: "Plan objective for this task." })),
    contextRefs: Type.Optional(
      Type.Array(Type.String({ description: "Relevant context refs/paths." })),
    ),
    constraints: Type.Optional(Type.Array(Type.String({ description: "Task constraints." }))),
    nonGoals: Type.Optional(Type.Array(Type.String({ description: "Explicit non-goals." }))),
    successCriteria: Type.Optional(
      Type.Array(Type.String({ description: "Observable success criteria." })),
    ),
    evidenceRequired: Type.Optional(
      Type.Array(Type.String({ description: "Evidence required before completion." })),
    ),
    steps: Type.Optional(Type.Array(Type.String({ description: "Concrete plan steps." }))),
    decompositionRationale: Type.Optional(
      Type.String({ description: "Why this is the right smallest task boundary." }),
    ),
    riskLevel: Type.Optional(Type.String({ description: "trivial | normal | high" })),
    openQuestions: Type.Optional(
      Type.Array(Type.String({ description: "Material unresolved questions." })),
    ),
    askRefs: Type.Optional(Type.Array(Type.String({ description: "Ask artifact refs." }))),
  });
}

export function normalizeToolTaskPlan(
  plan: Partial<TaskPlan> | undefined,
  description: string,
  title: string,
): TaskPlan {
  const objective = plan?.objective?.trim() || description.trim() || title.trim();
  const steps = normalizeStringList(plan?.steps);
  return {
    objective,
    contextRefs: normalizeStringList(plan?.contextRefs),
    constraints: normalizeStringList(plan?.constraints),
    nonGoals: normalizeStringList(plan?.nonGoals),
    successCriteria: normalizeStringList(plan?.successCriteria),
    evidenceRequired: normalizeStringList(plan?.evidenceRequired),
    steps: steps.length ? steps : [description.trim() || title.trim()],
    decompositionRationale: plan?.decompositionRationale?.trim() || undefined,
    riskLevel:
      plan?.riskLevel === "trivial" || plan?.riskLevel === "high" ? plan.riskLevel : "normal",
    openQuestions: normalizeStringList(plan?.openQuestions),
    askRefs: normalizeStringList(plan?.askRefs) as TaskPlan["askRefs"],
  };
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function normalizeTaskKind(value: string | undefined): TaskKind | undefined {
  if (!value) return undefined;
  if (
    value === "research" ||
    value === "plan" ||
    value === "implement" ||
    value === "review" ||
    value === "ask" ||
    value === "cue" ||
    value === "interaction" ||
    value === "generic"
  )
    return value;
  return undefined;
}

export function normalizeTaskStatus(value: string | undefined): TaskStatus | undefined {
  if (!value) return undefined;
  if (
    value === "proposed" ||
    value === "pending" ||
    value === "ready" ||
    value === "running" ||
    value === "blocked" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled"
  )
    return value;
  return undefined;
}

export function escapeYamlLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(line.length > 160 ? `${line.slice(0, 157)}...` : line);
}
