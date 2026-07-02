import {
  nowIso,
  type ProjectRoadmap,
  type RoadmapItem,
  type RoadmapItemRef,
  type RoadmapRef,
  type TaskRef,
} from "@zendev-lab/spark-extension-api";

export function createDefaultProjectRoadmap(title: string, now = nowIso()): ProjectRoadmap {
  return {
    ref: "roadmap:main" as RoadmapRef,
    title: title.trim() || "Project roadmap",
    status: "active",
    items: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeProjectRoadmap(
  roadmap: ProjectRoadmap,
  path = "project.roadmap",
): ProjectRoadmap {
  validateProjectRoadmap(roadmap, path);
  return {
    ref: roadmap.ref,
    title: roadmap.title.trim(),
    status: roadmap.status === "done" ? "done" : "active",
    activeItemRef: roadmap.activeItemRef,
    items: roadmap.items.map((item, index) =>
      normalizeRoadmapItem(item, `${path}.items[${index}]`),
    ),
    createdAt: roadmap.createdAt,
    updatedAt: roadmap.updatedAt,
  };
}

export function normalizeRoadmapItem(item: RoadmapItem, path: string): RoadmapItem {
  validateRoadmapItem(item, path);
  return {
    ref: item.ref,
    title: item.title?.trim() || undefined,
    status: item.status,
    objective: item.objective.trim(),
    scope: item.scope,
    constraints: normalizeStringList(item.constraints),
    successCriteria: normalizeStringList(item.successCriteria),
    acceptance: normalizeStringList(item.acceptance),
    evidenceRequired: normalizeStringList(item.evidenceRequired),
    evidenceRefs: normalizeStringList(item.evidenceRefs),
    openQuestions: normalizeStringList(item.openQuestions),
    askRefs: normalizeStringList(item.askRefs),
    taskRefs: uniqueTaskRefs(item.taskRefs ?? []),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function uniqueTaskRefs(values: TaskRef[]): TaskRef[] {
  const seen = new Set<string>();
  const result: TaskRef[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed as TaskRef);
  }
  return result;
}

function validateProjectRoadmap(value: unknown, path: string): void {
  const roadmap = requireRecord(value, path);
  requireRoadmapRef(roadmap.ref, `${path}.ref`);
  requireString(roadmap.title, `${path}.title`);
  optionalOneOf(roadmap.status, ["active", "done"], `${path}.status`);
  const activeItemRef = optionalRoadmapItemRef(roadmap.activeItemRef, `${path}.activeItemRef`);
  const items = requireArray(roadmap.items, `${path}.items`);
  for (const [itemIndex, itemValue] of items.entries())
    validateRoadmapItem(itemValue, `${path}.items[${itemIndex}]`);
  if (activeItemRef && !items.some((item) => recordRef(item) === activeItemRef))
    failRoadmap(`${path}.activeItemRef ${activeItemRef} is not present`);
  requireString(roadmap.createdAt, `${path}.createdAt`);
  requireString(roadmap.updatedAt, `${path}.updatedAt`);
}

function validateRoadmapItem(value: unknown, path: string): void {
  const item = requireRecord(value, path);
  requireRoadmapItemRef(item.ref, `${path}.ref`);
  optionalString(item.title, `${path}.title`);
  requireString(item.objective, `${path}.objective`);
  optionalOneOf(item.status, ["active", "pending", "blocked", "done"], `${path}.status`);
  optionalStringOrStringArray(item.scope, `${path}.scope`);
  for (const key of [
    "constraints",
    "successCriteria",
    "acceptance",
    "evidenceRequired",
    "evidenceRefs",
    "openQuestions",
    "askRefs",
    "taskRefs",
  ] as const)
    optionalStringArray(item[key], `${path}.${key}`);
  optionalString(item.createdAt, `${path}.createdAt`);
  optionalString(item.updatedAt, `${path}.updatedAt`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    failRoadmap(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) failRoadmap(`${path} must be an array`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") failRoadmap(`${path} must be a string`);
  return value;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "string") failRoadmap(`${path} must be a string`);
}

function optionalStringArray(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    failRoadmap(`${path} must be an array of strings`);
}

function optionalStringOrStringArray(value: unknown, path: string): void {
  if (value === undefined || typeof value === "string") return;
  optionalStringArray(value, path);
}

function optionalOneOf(value: unknown, allowed: readonly string[], path: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value))
    failRoadmap(`${path} must be one of ${allowed.join(", ")}`);
}

function requireRoadmapRef(value: unknown, path: string): RoadmapRef {
  const ref = requireString(value, path);
  if (!ref.startsWith("roadmap:")) failRoadmap(`${path} must be a roadmap: ref`);
  return ref as RoadmapRef;
}

function optionalRoadmapItemRef(value: unknown, path: string): RoadmapItemRef | undefined {
  if (value === undefined) return undefined;
  return requireRoadmapItemRef(value, path);
}

function requireRoadmapItemRef(value: unknown, path: string): RoadmapItemRef {
  const ref = requireString(value, path);
  if (!ref.startsWith("roadmap-item:")) failRoadmap(`${path} must be a roadmap-item: ref`);
  return ref as RoadmapItemRef;
}

function recordRef(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).ref
    : undefined;
}

function failRoadmap(message: string): never {
  throw new Error(`invalid project roadmap: ${message}`);
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return [];
}
