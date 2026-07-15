import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import type { ProjectRef } from "@zendev-lab/spark-extension-api";

import type {
  SparkCockpitArtifactSummary,
  SparkCockpitCliOptions,
  SparkCockpitGoalSummary,
  SparkCockpitReviewSummary,
  SparkCockpitWorkflowSummary,
} from "./coordination.ts";

export interface SparkCockpitCoordinationState {
  cwd: string;
  graph: TaskGraph | null;
  currentProjectRef: ProjectRef | null;
  currentSessionKey: string | null;
  goal: SparkCockpitGoalSummary | null;
  artifacts: SparkCockpitArtifactSummary[];
  reviews: SparkCockpitReviewSummary[];
  workflows: SparkCockpitWorkflowSummary[];
}

export async function loadSparkCockpitCoordinationState(
  options: SparkCockpitCliOptions,
): Promise<SparkCockpitCoordinationState> {
  const cwd = options.cwd ?? process.cwd();
  const graph =
    options.graph !== undefined
      ? options.graph
      : ((await defaultTaskGraphStore(cwd).load()) ?? new TaskGraph());
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

async function readGoalSummary(cwd: string): Promise<SparkCockpitGoalSummary | null> {
  const dir = join(cwd, ".spark", "session-goals");
  try {
    const names = await readdir(dir);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as {
        goal?: SparkCockpitGoalSummary;
      };
      if (raw.goal) return raw.goal;
    }
  } catch {
    return null;
  }
  return null;
}

async function readArtifactSummaries(cwd: string): Promise<SparkCockpitArtifactSummary[]> {
  try {
    const { artifacts } = await defaultArtifactStore(cwd).listWithDiagnostics({
      includeRaw: true,
      includeArchived: true,
    });
    return artifacts.map((artifact) => ({
      artifactRef: artifact.ref,
      title: artifact.title,
      kind: artifact.kind,
      status: artifact.curation?.status,
    }));
  } catch {
    return [];
  }
}

async function readReviewSummaries(cwd: string): Promise<SparkCockpitReviewSummary[]> {
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

async function readWorkflowSummaries(cwd: string): Promise<SparkCockpitWorkflowSummary[]> {
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
