import {
  type ProjectRef,
  type ProjectRoadmap,
  type RoadmapItem,
  type RoadmapItemRef,
  type TaskPlan,
  type TaskRef,
} from "@zendev-lab/pi-extension-api";
import { type TaskPlanInput, type TaskGraph } from "@zendev-lab/pi-tasks";

export type { ProjectRoadmap, RoadmapItem, RoadmapItemRef };
export type RoadmapRef = ProjectRoadmap["ref"];

export interface RoadmapPlanningContext {
  roadmap: ProjectRoadmap;
  item: RoadmapItem;
  matchedByFocus: boolean;
}

export interface RoadmapPlanningContextResult {
  context: RoadmapPlanningContext;
  mutated: boolean;
}

export function roadmapPlanningContext(
  graph: TaskGraph,
  projectRef: ProjectRef,
  focus?: string,
): RoadmapPlanningContextResult | undefined {
  const project = graph.getProject(projectRef);
  const roadmap = project.roadmap;
  const focusMatch = focus?.trim() ? matchingRoadmapItem(roadmap, focus) : undefined;
  const item = focusMatch ?? activeRoadmapItem(roadmap);
  if (!item) return undefined;

  if (focusMatch) {
    graph.activateRoadmapItem(projectRef, focusMatch.ref);
    return {
      context: {
        roadmap: graph.getProject(projectRef).roadmap,
        item: focusMatch,
        matchedByFocus: true,
      },
      mutated: true,
    };
  }

  return { context: { roadmap, item, matchedByFocus: false }, mutated: false };
}

export function applyRoadmapHintsToTaskPlanInput(
  input: TaskPlanInput,
  item: RoadmapItem | undefined,
): TaskPlanInput {
  if (!item || !input.plan) return input;
  return {
    ...input,
    plan: applyRoadmapHintsToTaskPlan(input.plan, item),
  };
}

export function applyRoadmapHintsToTaskPlan(plan: TaskPlan, item: RoadmapItem): TaskPlan {
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

export function attachRoadmapPlanningRefs(
  graph: TaskGraph,
  projectRef: ProjectRef,
  itemRef: RoadmapItemRef | undefined,
  taskRefs: TaskRef[],
): RoadmapItem | undefined {
  if (!itemRef) return undefined;
  return graph.attachRoadmapItemTaskRefs(projectRef, itemRef, taskRefs);
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
    '- When planning tasks, map this item into TaskPlan contextRefs/constraints/successCriteria/evidenceRequired; task_write({ action: "plan" }) will attach produced task refs back to the item.',
  );
  return `\n\n${lines.join("\n")}`;
}

function activeRoadmapItem(roadmap: ProjectRoadmap): RoadmapItem | undefined {
  if (roadmap.activeItemRef) {
    const active = roadmap.items.find((item) => item.ref === roadmap.activeItemRef);
    if (active) return active;
  }
  return roadmap.items.find((item) => item.status === "active");
}

function matchingRoadmapItem(roadmap: ProjectRoadmap, focus: string): RoadmapItem | undefined {
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
