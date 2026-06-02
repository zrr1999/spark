import { defaultArtifactStore } from "spark-core";
import { type ArtifactRef, type JsonValue, type ProjectRef } from "spark-core";
import type { TaskGraph } from "spark-tasks";
import type { clarifyProjectIntentIfNeeded } from "../flows/project-intent-flow.ts";
import { isImportantStatus, type SparkProjectListStatus } from "./spark-status.ts";

export interface SparkProjectPatch {
  title?: string;
  description?: string;
  status?: "active" | "done";
  outputLanguage?: "zh" | "en";
}

export interface SparkNewProjectInput {
  project?: string;
  title?: string;
  description?: string;
  outputLanguage?: "zh" | "en";
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

export function normalizeSparkProjectStatus(value: unknown): "active" | "done" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "active" || value === "done") return value;
  throw new Error("status must be active or done");
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
    status: normalizeSparkProjectStatus(params.status),
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
    outputLanguage: normalizeSparkProjectOutputLanguage(params.outputLanguage),
  };
}

export function hasSparkProjectPatch(patch: SparkProjectPatch): boolean {
  return Boolean(patch.title || patch.description || patch.status || patch.outputLanguage);
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

export function collectSparkProjectSummaries(input: {
  graph: TaskGraph;
  status: SparkProjectListStatus;
  currentProjectRef?: ProjectRef;
}): Array<Record<string, unknown>> {
  return input.graph
    .projects()
    .filter((project) =>
      input.status === "all"
        ? true
        : input.status === "done"
          ? project.status === "done"
          : project.status !== "done",
    )
    .map((project) => {
      const tasks = input.graph.tasks(project.ref);
      return {
        ref: project.ref,
        title: project.title,
        status: project.status,
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

export async function saveProjectIntentTrace(
  cwd: string,
  projectRef: ProjectRef,
  clarification: Awaited<ReturnType<typeof clarifyProjectIntentIfNeeded>>,
): Promise<void> {
  if (!clarification.asked || !clarification.artifactRef) return;
  await defaultArtifactStore(cwd).put({
    kind: "run-trace",
    title: "Project intent clarification",
    format: "json",
    body: {
      projectRef,
      askArtifactRef: clarification.artifactRef,
      summary: clarification.summary,
      blocked: clarification.blocked,
    } as unknown as JsonValue,
    provenance: {
      producer: "spark",
      projectRef,
      parentArtifactRefs: [clarification.artifactRef as ArtifactRef],
    },
  });
}
