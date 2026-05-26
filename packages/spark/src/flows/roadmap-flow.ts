import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  nowIso,
  type ArtifactRef,
  type AskRef,
  type TaskPlan,
  type TaskRef,
  type ThreadRef,
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
  threadRefs?: ThreadRef[];
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
  threadRef: ThreadRef,
  taskRefs: TaskRef[],
): Promise<RoadmapItemRecord | undefined> {
  if (!itemRef) return undefined;
  const state = await loadProjectRoadmap(cwd);
  if (!state) return undefined;
  const found = findRoadmapItem(state, itemRef);
  if (!found) return undefined;
  found.item.threadRefs = uniqueStrings([
    ...(found.item.threadRefs ?? []),
    threadRef,
  ]) as ThreadRef[];
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
    "- When planning tasks, map this item into TaskPlan contextRefs/constraints/successCriteria/evidenceRequired; spark_plan_tasks will attach produced thread/task refs back to the item.",
  );
  return `\n\n${lines.join("\n")}`;
}

async function loadProjectRoadmap(cwd: string): Promise<ProjectRoadmapState | undefined> {
  try {
    const raw = await readFile(roadmapPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as ProjectRoadmapState;
    if (parsed?.version !== 1 || !Array.isArray(parsed.roadmaps)) return undefined;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
