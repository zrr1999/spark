import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  nowIso,
  type ArtifactRef,
  type AskRef,
  type TaskPlan,
  type TaskRef,
  type ProjectRef,
} from "spark-core";
import { type TaskPlanInput } from "spark-tasks";

export type RoadmapRef = `roadmap:${string}`;
export type RoadmapItemRef = `roadmap-item:${string}`;

export interface ProjectRoadmapState {
  version: 1;
  activeRoadmapRef?: RoadmapRef;
  activeItemRef?: RoadmapItemRef;
  roadmaps: RoadmapRecord[];
}

export interface RoadmapRecord {
  ref: RoadmapRef;
  title: string;
  status?: "active" | "done";
  activeItemRef?: RoadmapItemRef;
  items: RoadmapItemRecord[];
  createdAt?: string;
  updatedAt?: string;
}

export interface RoadmapItemRecord {
  ref: RoadmapItemRef;
  title?: string;
  status?: "active" | "pending" | "blocked" | "done";
  objective: string;
  scope?: string | string[];
  constraints?: string[];
  successCriteria?: string[];
  acceptance?: string[];
  evidenceRequired?: string[];
  evidenceRefs?: string[];
  openQuestions?: string[];
  askRefs?: Array<AskRef | ArtifactRef | string>;
  projectRefs?: ProjectRef[];
  taskRefs?: TaskRef[];
  createdAt?: string;
  updatedAt?: string;
}

export interface RoadmapPlanningContext {
  roadmap: RoadmapRecord;
  item: RoadmapItemRecord;
  matchedByFocus: boolean;
}

export async function roadmapPlanningContext(
  cwd: string,
  focus?: string,
): Promise<RoadmapPlanningContext | undefined> {
  const state = await loadProjectRoadmap(cwd);
  if (!state) return undefined;
  const roadmap = activeRoadmap(state);
  if (!roadmap) return undefined;
  const focusMatch = focus?.trim() ? matchingRoadmapItem(roadmap, focus) : undefined;
  const item = focusMatch ?? activeRoadmapItem(state, roadmap);
  if (!item) return undefined;

  if (focusMatch) {
    const now = nowIso();
    state.activeRoadmapRef = roadmap.ref;
    state.activeItemRef = focusMatch.ref;
    roadmap.activeItemRef = focusMatch.ref;
    roadmap.updatedAt = now;
    focusMatch.status = "active";
    focusMatch.updatedAt = now;
    await saveProjectRoadmap(cwd, state);
  }

  return { roadmap, item, matchedByFocus: Boolean(focusMatch) };
}

export function applyRoadmapHintsToTaskPlanInput(
  input: TaskPlanInput,
  item: RoadmapItemRecord | undefined,
): TaskPlanInput {
  if (!item || !input.plan) return input;
  return {
    ...input,
    plan: applyRoadmapHintsToTaskPlan(input.plan, item),
  };
}

export function applyRoadmapHintsToTaskPlan(plan: TaskPlan, item: RoadmapItemRecord): TaskPlan {
  const scopeLines = normalizeStringList(item.scope);
  const constraints = [
    ...scopeLines.map((scope) => `Roadmap scope: ${scope}`),
    ...normalizeStringList(item.constraints),
  ];
  const contextRefs = [
    item.ref,
    item.objective.trim() ? `Roadmap objective: ${item.objective.trim()}` : undefined,
    ...normalizeStringList(item.evidenceRefs),
  ];
  return {
    ...plan,
    contextRefs: uniqueStrings([...plan.contextRefs, ...contextRefs]),
    constraints: uniqueStrings([...plan.constraints, ...constraints]),
    successCriteria: uniqueStrings([
      ...plan.successCriteria,
      ...normalizeStringList(item.successCriteria),
      ...normalizeStringList(item.acceptance),
    ]),
    evidenceRequired: uniqueStrings([
      ...plan.evidenceRequired,
      ...normalizeStringList(item.evidenceRequired),
    ]),
    askRefs: uniqueStrings([
      ...plan.askRefs,
      ...normalizeStringList(item.askRefs),
    ]) as TaskPlan["askRefs"],
  };
}

export async function attachRoadmapPlanningRefs(
  cwd: string,
  itemRef: RoadmapItemRef | undefined,
  projectRef: ProjectRef,
  taskRefs: TaskRef[],
): Promise<RoadmapItemRecord | undefined> {
  if (!itemRef) return undefined;
  const state = await loadProjectRoadmap(cwd);
  if (!state) return undefined;
  const found = findRoadmapItem(state, itemRef);
  if (!found) return undefined;
  found.item.projectRefs = uniqueStrings([
    ...(found.item.projectRefs ?? []),
    projectRef,
  ]) as ProjectRef[];
  found.item.taskRefs = uniqueStrings([...(found.item.taskRefs ?? []), ...taskRefs]) as TaskRef[];
  found.item.updatedAt = nowIso();
  found.roadmap.updatedAt = found.item.updatedAt;
  await saveProjectRoadmap(cwd, state);
  return found.item;
}

export function renderRoadmapPlanningContext(context: RoadmapPlanningContext | undefined): string {
  if (!context) return "";
  const { item, matchedByFocus } = context;
  const title = item.title?.trim() || item.objective.trim() || item.ref;
  const lines = [
    "Roadmap planning context:",
    `- Active item: ${title} (${item.ref})`,
    `- Objective: ${item.objective}`,
  ];
  const scopes = normalizeStringList(item.scope);
  if (scopes.length) lines.push(`- Scope: ${scopes.join("; ")}`);
  const successes = uniqueStrings([
    ...normalizeStringList(item.successCriteria),
    ...normalizeStringList(item.acceptance),
  ]);
  if (successes.length) lines.push(`- Success suggestions: ${successes.join("; ")}`);
  const evidence = normalizeStringList(item.evidenceRequired);
  if (evidence.length) lines.push(`- Evidence suggestions: ${evidence.join("; ")}`);
  if (matchedByFocus)
    lines.push(
      "- Planning focus matched this roadmap item; reuse/update it instead of creating a parallel item.",
    );
  lines.push(
    "- When planning tasks, map this item into TaskPlan contextRefs/constraints/successCriteria/evidenceRequired; spark_plan_tasks will attach produced project/task refs back to the item.",
  );
  return `\n\n${lines.join("\n")}`;
}

async function loadProjectRoadmap(cwd: string): Promise<ProjectRoadmapState | undefined> {
  const filePath = roadmapPath(cwd);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid Spark roadmap store: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  validateProjectRoadmapState(parsed, filePath);
  return parsed as ProjectRoadmapState;
}

async function saveProjectRoadmap(cwd: string, state: ProjectRoadmapState): Promise<void> {
  const filePath = roadmapPath(cwd);
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

function roadmapPath(cwd: string): string {
  return join(cwd, ".spark", "roadmap.json");
}

function activeRoadmap(state: ProjectRoadmapState): RoadmapRecord | undefined {
  if (state.activeRoadmapRef) {
    const active = state.roadmaps.find((roadmap) => roadmap.ref === state.activeRoadmapRef);
    if (active) return active;
  }
  return state.roadmaps.find((roadmap) => roadmap.status === "active") ?? state.roadmaps[0];
}

function activeRoadmapItem(
  state: ProjectRoadmapState,
  roadmap: RoadmapRecord,
): RoadmapItemRecord | undefined {
  const activeItemRef = roadmap.activeItemRef ?? state.activeItemRef;
  if (activeItemRef) {
    const active = roadmap.items.find((item) => item.ref === activeItemRef);
    if (active) return active;
  }
  return roadmap.items.find((item) => item.status === "active");
}

function matchingRoadmapItem(roadmap: RoadmapRecord, focus: string): RoadmapItemRecord | undefined {
  const refMatch = roadmap.items.find((item) => focus.includes(item.ref));
  if (refMatch) return refMatch;
  const normalizedFocus = normalizeMatchText(focus);
  if (normalizedFocus.length < 8) return undefined;
  return roadmap.items.find((item) => {
    return [item.title, item.objective]
      .map((value) => normalizeMatchText(value ?? ""))
      .filter((value) => value.length >= 8)
      .some(
        (value) =>
          normalizedFocus === value ||
          normalizedFocus.includes(value) ||
          value.includes(normalizedFocus),
      );
  });
}

function findRoadmapItem(
  state: ProjectRoadmapState,
  itemRef: RoadmapItemRef,
): { roadmap: RoadmapRecord; item: RoadmapItemRecord } | undefined {
  for (const roadmap of state.roadmaps) {
    const item = roadmap.items.find((candidate) => candidate.ref === itemRef);
    if (item) return { roadmap, item };
  }
  return undefined;
}

function validateProjectRoadmapState(value: unknown, filePath: string): void {
  const state = requireRecord(value, filePath, "snapshot");
  if (state.version !== 1) failRoadmapStore(filePath, "snapshot.version must be 1");
  const roadmaps = requireArray(state.roadmaps, filePath, "snapshot.roadmaps");
  for (const [roadmapIndex, roadmapValue] of roadmaps.entries())
    validateRoadmapRecord(roadmapValue, filePath, `snapshot.roadmaps[${roadmapIndex}]`);

  const activeRoadmapRef = optionalRoadmapRef(
    state.activeRoadmapRef,
    filePath,
    "snapshot.activeRoadmapRef",
  );
  if (activeRoadmapRef && !roadmaps.some((roadmap) => recordRef(roadmap) === activeRoadmapRef))
    failRoadmapStore(filePath, `snapshot.activeRoadmapRef ${activeRoadmapRef} is not present`);

  const activeItemRef = optionalRoadmapItemRef(
    state.activeItemRef,
    filePath,
    "snapshot.activeItemRef",
  );
  if (activeItemRef && !roadmaps.some((roadmap) => roadmapContainsItem(roadmap, activeItemRef)))
    failRoadmapStore(filePath, `snapshot.activeItemRef ${activeItemRef} is not present`);
}

function validateRoadmapRecord(value: unknown, filePath: string, path: string): void {
  const roadmap = requireRecord(value, filePath, path);
  requireRoadmapRef(roadmap.ref, filePath, `${path}.ref`);
  requireString(roadmap.title, filePath, `${path}.title`);
  optionalOneOf(roadmap.status, ["active", "done"], filePath, `${path}.status`);
  const activeItemRef = optionalRoadmapItemRef(
    roadmap.activeItemRef,
    filePath,
    `${path}.activeItemRef`,
  );
  const items = requireArray(roadmap.items, filePath, `${path}.items`);
  for (const [itemIndex, itemValue] of items.entries())
    validateRoadmapItemRecord(itemValue, filePath, `${path}.items[${itemIndex}]`);
  if (activeItemRef && !items.some((item) => recordRef(item) === activeItemRef))
    failRoadmapStore(filePath, `${path}.activeItemRef ${activeItemRef} is not present`);
  optionalString(roadmap.createdAt, filePath, `${path}.createdAt`);
  optionalString(roadmap.updatedAt, filePath, `${path}.updatedAt`);
}

function validateRoadmapItemRecord(value: unknown, filePath: string, path: string): void {
  const item = requireRecord(value, filePath, path);
  requireRoadmapItemRef(item.ref, filePath, `${path}.ref`);
  optionalString(item.title, filePath, `${path}.title`);
  requireString(item.objective, filePath, `${path}.objective`);
  optionalOneOf(item.status, ["active", "pending", "blocked", "done"], filePath, `${path}.status`);
  optionalStringOrStringArray(item.scope, filePath, `${path}.scope`);
  for (const key of [
    "constraints",
    "successCriteria",
    "acceptance",
    "evidenceRequired",
    "evidenceRefs",
    "openQuestions",
    "askRefs",
    "projectRefs",
    "taskRefs",
  ] as const)
    optionalStringArray(item[key], filePath, `${path}.${key}`);
  optionalString(item.createdAt, filePath, `${path}.createdAt`);
  optionalString(item.updatedAt, filePath, `${path}.updatedAt`);
}

function requireRecord(value: unknown, filePath: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    failRoadmapStore(filePath, `${path} must be an object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, filePath: string, path: string): unknown[] {
  if (!Array.isArray(value)) failRoadmapStore(filePath, `${path} must be an array`);
  return value;
}

function requireString(value: unknown, filePath: string, path: string): string {
  if (typeof value !== "string") failRoadmapStore(filePath, `${path} must be a string`);
  return value;
}

function optionalString(value: unknown, filePath: string, path: string): void {
  if (value !== undefined && typeof value !== "string")
    failRoadmapStore(filePath, `${path} must be a string`);
}

function optionalStringArray(value: unknown, filePath: string, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    failRoadmapStore(filePath, `${path} must be an array of strings`);
}

function optionalStringOrStringArray(value: unknown, filePath: string, path: string): void {
  if (value === undefined || typeof value === "string") return;
  optionalStringArray(value, filePath, path);
}

function optionalOneOf(
  value: unknown,
  allowed: readonly string[],
  filePath: string,
  path: string,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value))
    failRoadmapStore(filePath, `${path} must be one of ${allowed.join(", ")}`);
}

function requireRoadmapRef(value: unknown, filePath: string, path: string): RoadmapRef {
  const ref = requireString(value, filePath, path);
  if (!ref.startsWith("roadmap:")) failRoadmapStore(filePath, `${path} must be a roadmap: ref`);
  return ref as RoadmapRef;
}

function optionalRoadmapRef(
  value: unknown,
  filePath: string,
  path: string,
): RoadmapRef | undefined {
  if (value === undefined) return undefined;
  return requireRoadmapRef(value, filePath, path);
}

function requireRoadmapItemRef(value: unknown, filePath: string, path: string): RoadmapItemRef {
  const ref = requireString(value, filePath, path);
  if (!ref.startsWith("roadmap-item:"))
    failRoadmapStore(filePath, `${path} must be a roadmap-item: ref`);
  return ref as RoadmapItemRef;
}

function optionalRoadmapItemRef(
  value: unknown,
  filePath: string,
  path: string,
): RoadmapItemRef | undefined {
  if (value === undefined) return undefined;
  return requireRoadmapItemRef(value, filePath, path);
}

function recordRef(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).ref
    : undefined;
}

function roadmapContainsItem(value: unknown, itemRef: RoadmapItemRef): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const items = (value as Record<string, unknown>).items;
  return Array.isArray(items) && items.some((item) => recordRef(item) === itemRef);
}

function failRoadmapStore(filePath: string, message: string): never {
  throw new Error(`invalid Spark roadmap store: ${filePath}: ${message}`);
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
