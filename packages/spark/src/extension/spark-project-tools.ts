import { defaultArtifactStore } from "@zendev-lab/pi-artifacts";
import type { ArtifactRef, JsonValue, ProjectRef } from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import type { clarifyProjectPurposeIfNeeded } from "../flows/project-purpose-flow.ts";
import { isImportantStatus } from "./spark-status.ts";

export interface SparkProjectPatch {
  title?: string;
  description?: string;
  purpose?: string;
  outputLanguage?: "zh" | "en";
}

export interface SparkNewProjectInput {
  project?: string;
  title?: string;
  description?: string;
  purpose?: string;
  outputLanguage?: "zh" | "en";
}

export interface SparkDuplicateProjectCandidate {
  ref: ProjectRef;
  title: string;
  score: number;
  reason: string;
}

export interface SparkDuplicateProjectGateResult {
  blocked: boolean;
  candidates: SparkDuplicateProjectCandidate[];
  guidance: string[];
}

export function normalizeSparkProjectOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string`);
  return trimmed;
}

export function normalizeSparkProjectOutputLanguage(value: unknown): "zh" | "en" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "zh" || value === "en") return value;
  throw new Error("outputLanguage must be zh or en");
}

export function normalizeSparkProjectPatch(params: Record<string, unknown>): SparkProjectPatch {
  return {
    title: normalizeSparkProjectOptionalString(params.title, "title"),
    description: normalizeSparkProjectOptionalString(params.description, "description"),
    purpose: normalizeSparkProjectOptionalString(params.purpose, "purpose"),
    outputLanguage: normalizeSparkProjectOutputLanguage(params.outputLanguage),
  };
}

export function normalizeSparkNewProjectInput(
  params: Record<string, unknown>,
): SparkNewProjectInput {
  return {
    project: normalizeSparkProjectOptionalString(params.project, "project"),
    title: normalizeSparkProjectOptionalString(params.title, "title"),
    description: normalizeSparkProjectOptionalString(params.description, "description"),
    purpose: normalizeSparkProjectOptionalString(params.purpose, "purpose"),
    outputLanguage: normalizeSparkProjectOutputLanguage(params.outputLanguage),
  };
}

export function hasSparkProjectPatch(patch: SparkProjectPatch): boolean {
  return Boolean(patch.title || patch.description || patch.purpose || patch.outputLanguage);
}

export function resolveSparkProject(
  graph: TaskGraph,
  query?: string,
): ReturnType<TaskGraph["projects"]>[number] | undefined {
  const projects = graph.projects();
  const needle = query?.trim();
  if (!needle) return undefined;
  return projects.find(
    (project) =>
      project.ref === needle || project.title === needle || project.title.startsWith(needle),
  );
}

const DUPLICATE_PROJECT_BLOCK_SCORE = 0.82;
const DUPLICATE_PROJECT_CANDIDATE_SCORE = 0.45;
const DUPLICATE_PROJECT_MAX_CANDIDATES = 3;

export function findDuplicateSparkProjects(input: {
  graph: TaskGraph;
  title: string;
  description?: string;
}): SparkDuplicateProjectGateResult {
  const requestedTitle = input.title.trim();
  const requestedDescription = input.description?.trim() || requestedTitle;
  const candidates = input.graph
    .projects()
    .map((project): SparkDuplicateProjectCandidate => {
      const score = scoreSparkProjectSimilarity(
        {
          title: requestedTitle,
          description: requestedDescription,
        },
        {
          title: project.title,
          description: project.description,
        },
      );
      return {
        ref: project.ref,
        title: project.title,
        score: score.score,
        reason: score.reason,
      };
    })
    .filter((candidate) => candidate.score >= DUPLICATE_PROJECT_CANDIDATE_SCORE)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, DUPLICATE_PROJECT_MAX_CANDIDATES);

  return {
    blocked: (candidates[0]?.score ?? 0) >= DUPLICATE_PROJECT_BLOCK_SCORE,
    candidates,
    guidance: [
      'Use task_write({ action: "project_use", project: <candidate ref or title> }) to select the existing Project when it is the same work.',
      "Ask the user which existing Project to use when multiple candidates look plausible.",
      "Only retry creation with a clearer differentiated title/description when this is genuinely new work.",
      "This gate does not merge, move tasks, or relink artifacts; selecting an existing Project is the only merge-like action in this slice.",
    ],
  };
}

function scoreSparkProjectSimilarity(
  requested: { title: string; description: string },
  existing: { title: string; description: string },
): { score: number; reason: string } {
  const requestedTitle = normalizeProjectSimilarityText(requested.title);
  const existingTitle = normalizeProjectSimilarityText(existing.title);
  if (requestedTitle && existingTitle && requestedTitle === existingTitle)
    return { score: 1, reason: "exact title match" };

  const titleContainment = scoreProjectTitleContainment(requestedTitle, existingTitle);
  const titleTokenScore = diceCoefficient(
    tokenizeProjectSimilarityText(requested.title),
    tokenizeProjectSimilarityText(existing.title),
  );
  const combinedScore = diceCoefficient(
    tokenizeProjectSimilarityText(`${requested.title} ${requested.description}`),
    tokenizeProjectSimilarityText(`${existing.title} ${existing.description}`),
  );
  const score = Math.max(titleContainment, titleTokenScore * 0.95, combinedScore);
  const reason =
    score === titleContainment
      ? "near title match"
      : score === combinedScore
        ? "similar title/description"
        : "similar title tokens";
  return { score, reason };
}

function normalizeProjectSimilarityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeProjectSimilarityText(value: string): string[] {
  const normalized = normalizeProjectSimilarityText(value);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length > 1);
}

function scoreProjectTitleContainment(left: string, right: string): number {
  if (!left || !right) return 0;
  const shorterLength = Math.min(left.length, right.length);
  const longerLength = Math.max(left.length, right.length);
  if (shorterLength < 8) return 0;
  if (!left.includes(right) && !right.includes(left)) return 0;
  const coverage = shorterLength / longerLength;
  return coverage >= 0.72 ? 0.9 * coverage + 0.1 : 0;
}

function diceCoefficient(leftTokens: string[], rightTokens: string[]): number {
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const rightCounts = new Map<string, number>();
  for (const token of rightTokens) rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of leftTokens) {
    const count = rightCounts.get(token) ?? 0;
    if (count === 0) continue;
    overlap += 1;
    if (count === 1) rightCounts.delete(token);
    else rightCounts.set(token, count - 1);
  }
  return (2 * overlap) / (leftTokens.length + rightTokens.length);
}

export function collectSparkProjectSummaries(input: {
  graph: TaskGraph;
  currentProjectRef?: ProjectRef;
}): Array<Record<string, unknown>> {
  return input.graph.projects().map((project) => {
    const tasks = input.graph.tasks(project.ref);
    return {
      ref: project.ref,
      title: project.title,
      taskCounts: {
        total: tasks.length,
        active: tasks.filter((task) => isImportantStatus(task.status)).length,
        done: tasks.filter((task) => task.status === "done").length,
        cancelled: tasks.filter((task) => task.status === "cancelled").length,
      },
      currentForSession: input.currentProjectRef === project.ref,
    };
  });
}

export async function saveProjectPurposeTrace(
  cwd: string,
  projectRef: ProjectRef,
  clarification: Awaited<ReturnType<typeof clarifyProjectPurposeIfNeeded>>,
): Promise<void> {
  if (!clarification.asked || !clarification.artifactRef) return;
  await defaultArtifactStore(cwd).put({
    kind: "trace",
    title: "Project purpose clarification",
    format: "json",
    body: {
      projectRef,
      askArtifactRef: clarification.artifactRef,
      summary: clarification.summary,
      blocked: clarification.blocked,
    } as unknown as JsonValue,
    provenance: {
      producer: "task",
      projectRef,
      parentArtifactRefs: [clarification.artifactRef as ArtifactRef],
    },
  });
}
