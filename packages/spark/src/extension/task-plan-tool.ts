import { Type } from "typebox";

import type { Task, TaskKind, TaskPlan, TaskStatus } from "pi-extension-api";
import { type TaskPlanResult } from "pi-tasks";

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

const PUBLIC_TASK_KIND_DESCRIPTION =
  "research | implement | review; omit kind for normal implementation work";

export function taskKindDescription(): string {
  return PUBLIC_TASK_KIND_DESCRIPTION;
}

export function normalizeTaskKind(value: unknown): TaskKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "research" || value === "implement" || value === "review") return value;
  if (value === "generic") return value;
  if (typeof value === "string" && value.startsWith("proj:"))
    throw new Error(
      `kind received a project ref (${value}); pass it as project/projectRef, e.g. task({ action: "plan", project: "${value}", tasks: [...] })`,
    );
  if (value === "plan" || value === "ask" || value === "cue" || value === "interaction")
    throw new Error(
      `kind=${value} is internal/reserved; omit kind or use research, implement, or review`,
    );
  throw new Error("kind must be research, implement, or review; omit kind for normal work");
}

export function normalizeTaskStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === "pending" ||
    value === "ready" ||
    value === "running" ||
    value === "blocked" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled"
  )
    return value;
  throw new Error("status must be pending, ready, running, blocked, done, failed, or cancelled");
}

export function normalizeTaskPlanPatch(
  value: unknown,
  path: string,
): Partial<TaskPlan> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return {
    objective: normalizeOptionalToolString(value.objective, `${path}.objective`),
    contextRefs: normalizeToolStringArray(value.contextRefs, `${path}.contextRefs`),
    constraints: normalizeToolStringArray(value.constraints, `${path}.constraints`),
    nonGoals: normalizeToolStringArray(value.nonGoals, `${path}.nonGoals`),
    successCriteria: normalizeToolStringArray(value.successCriteria, `${path}.successCriteria`),
    evidenceRequired: normalizeToolStringArray(value.evidenceRequired, `${path}.evidenceRequired`),
    steps: normalizeToolStringArray(value.steps, `${path}.steps`),
    decompositionRationale: normalizeOptionalToolString(
      value.decompositionRationale,
      `${path}.decompositionRationale`,
    ),
    riskLevel: normalizeTaskPlanRiskLevel(value.riskLevel, `${path}.riskLevel`),
    openQuestions: normalizeToolStringArray(value.openQuestions, `${path}.openQuestions`),
    askRefs: normalizeToolStringArray(value.askRefs, `${path}.askRefs`) as TaskPlan["askRefs"],
  };
}

export function normalizeRequiredToolString(value: unknown, path: string): string {
  const normalized = normalizeOptionalToolString(value, path);
  if (!normalized) throw new Error(`${path} must be a non-empty string`);
  return normalized;
}

export function normalizeOptionalToolString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeToolStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${path} must be an array of strings`);
  const normalized = value.map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function compactTaskDetail(task: Task) {
  return {
    ref: task.ref,
    name: task.name,
    title: task.title,
    status: task.status,
    kind: task.kind,
    roleRef: task.roleRef,
    projectRef: task.projectRef,
    cancellation: task.cancellation,
    supersededBy: task.supersededBy,
  };
}

export function compactTaskPlanResult(result: TaskPlanResult) {
  return {
    created: result.created.map(compactTaskDetail),
    updated: result.updated.map(compactTaskDetail),
    skipped: result.skipped.length,
    dependencies: result.dependencies.length,
  };
}

export function escapeYamlLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(line.length > 160 ? `${line.slice(0, 157)}...` : line);
}

function normalizeTaskPlanRiskLevel(
  value: unknown,
  path: string,
): TaskPlan["riskLevel"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "trivial" || value === "normal" || value === "high") return value;
  throw new Error(`${path} must be trivial, normal, or high`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
