import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { defaultTaskGraphStore, type TaskGraph } from "@zendev-lab/spark-tasks";
import type { ProjectRef } from "@zendev-lab/spark-extension-api";

import type {
  SparkServerArtifactSummary,
  SparkServerCliOptions,
  SparkServerGoalSummary,
  SparkServerReviewSummary,
  SparkServerWorkflowSummary,
} from "./server.ts";

export interface SparkServerCoordinationState {
  cwd: string;
  graph: TaskGraph | null;
  currentProjectRef: ProjectRef | null;
  currentSessionKey: string | null;
  goal: SparkServerGoalSummary | null;
  artifacts: SparkServerArtifactSummary[];
  reviews: SparkServerReviewSummary[];
  workflows: SparkServerWorkflowSummary[];
}

export async function loadSparkServerCoordinationState(
  options: SparkServerCliOptions,
): Promise<SparkServerCoordinationState> {
  const cwd = options.cwd ?? process.cwd();
  const graph =
    options.graph !== undefined ? options.graph : await defaultTaskGraphStore(cwd).load();
  const currentProjectRef = options.currentProjectRef ?? firstProjectRef(graph) ?? null;
  return {
    cwd,
    graph,
    currentProjectRef,
    currentSessionKey: options.currentSessionKey ?? null,
    goal: options.goal === undefined ? await readGoalSummary(cwd) : options.goal,
    artifacts: options.artifacts ?? (await readArtifactSummaries(cwd)),
    reviews: options.reviews ?? (await readReviewSummaries(cwd)),
    workflows: options.workflows ?? (await readWorkflowSummaries(cwd)),
  };
}

function firstProjectRef(graph: TaskGraph | null): ProjectRef | undefined {
  return graph?.projects()[0]?.ref;
}

async function readGoalSummary(cwd: string): Promise<SparkServerGoalSummary | null> {
  const dir = join(cwd, ".spark", "session-goals");
  try {
    const names = await readdir(dir);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as {
        goal?: SparkServerGoalSummary;
      };
      if (raw.goal) return raw.goal;
    }
  } catch {
    return null;
  }
  return null;
}

async function readArtifactSummaries(cwd: string): Promise<SparkServerArtifactSummary[]> {
  const dir = join(cwd, ".spark", "artifacts");
  try {
    const names = await readdir(dir);
    const rows: SparkServerArtifactSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as Record<string, unknown>;
      const artifactRef =
        typeof raw.ref === "string" ? raw.ref : `artifact:${name.replace(/\.json$/u, "")}`;
      rows.push({
        artifactRef,
        title: stringField(raw.title),
        kind: stringField(raw.kind),
        status: stringField(raw.status),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

async function readReviewSummaries(cwd: string): Promise<SparkServerReviewSummary[]> {
  const dir = join(cwd, ".spark", "reviews");
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ reviewRef: `review:${name.replace(/\.json$/u, "")}` }));
  } catch {
    return [];
  }
}

async function readWorkflowSummaries(cwd: string): Promise<SparkServerWorkflowSummary[]> {
  try {
    const raw = JSON.parse(
      await readFile(join(cwd, ".spark", "dynamic-workflow-runs.json"), "utf8"),
    ) as {
      runs?: Array<{ ref?: string; status?: string; meta?: { name?: string } }>;
    };
    return (raw.runs ?? [])
      .filter(
        (run): run is { ref: string; status?: string; meta?: { name?: string } } =>
          typeof run.ref === "string",
      )
      .map((run) => ({ runRef: run.ref, status: run.status, name: run.meta?.name }));
  } catch {
    return [];
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
