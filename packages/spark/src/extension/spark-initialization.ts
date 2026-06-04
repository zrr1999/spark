import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultArtifactStore, detectCopyLanguage } from "spark-core";
import type { CopyLanguage } from "spark-core";
import { builtinRoleRef } from "pi-roles";
import {
  newRef,
  nowIso,
  type ArtifactRef,
  type AskRef,
  type JsonValue,
  type SparkRunTrace,
  type ProjectRef,
  type ReviewGate,
} from "spark-core";
import { defaultTaskGraphStore, TaskGraph, type TaskTodoSummary } from "spark-tasks";
import { pathExists, readActiveSparkMd, shouldMaterializeSparkMd } from "./spark-activation.ts";
import {
  describeDeliveryMode,
  renderSparkMd,
  titleFromIdea,
  type SparkInitClarificationData,
} from "./spark-md-rendering.ts";
import { renderRolePlan, type SparkInitResult } from "./spark-init-rendering.ts";
import { sparkTodoStore, writeJsonFileAtomic } from "./session-state.ts";

export interface SparkInitOptions {
  projectTitle?: string;
  outputLanguage?: CopyLanguage;
  clarification?: SparkInitClarificationData;
  sparkMd?: string;
  askArtifactRefs?: ArtifactRef[];
  askRefs?: AskRef[];
  materializeSparkMd?: boolean;
}

export function shouldClarifyBeforeInit(idea: string): boolean {
  void idea;
  return false;
}

export async function initializeSparkIdea(
  cwd: string,
  idea: string,
  options: SparkInitOptions = {},
): Promise<SparkInitResult> {
  const sparkDir = join(cwd, ".spark");
  await mkdir(sparkDir, { recursive: true });

  const existingGraph = await defaultTaskGraphStore(cwd).load();
  if (existingGraph) return sparkInitResultFromExisting(cwd, idea, existingGraph, options);

  const graph = new TaskGraph();
  const projectTitle =
    options.projectTitle ?? options.clarification?.workingTitle ?? titleFromIdea(idea);
  const project = graph.createProject({
    title: projectTitle,
    description: options.clarification?.objective ?? idea,
    outputLanguage: options.outputLanguage ?? options.clarification?.outputLanguage,
  });

  createInitialSparkTasks(graph, project.ref, idea, options.clarification);

  const store = defaultArtifactStore(cwd);
  const sparkMd =
    options.sparkMd ??
    renderSparkMd({ idea, workingTitle: projectTitle, clarification: options.clarification });
  const sparkMdArtifact = await store.put({
    kind: "spark-md",
    title: "SPARK.md draft",
    format: "markdown",
    body: sparkMd,
    provenance: { producer: "spark", projectRef: project.ref },
  });
  const shouldWriteSparkMd =
    options.materializeSparkMd !== false && (await shouldMaterializeSparkMd(cwd));
  const sparkMdPath = shouldWriteSparkMd ? join(cwd, "SPARK.md") : undefined;
  if (sparkMdPath) await writeFile(sparkMdPath, sparkMd, "utf8");

  const rolePlan = renderRolePlan({ idea, tasks: graph.tasks(project.ref) });
  const rolePlanArtifact = await store.put({
    kind: "role-plan",
    title: "Initial role plan",
    format: "markdown",
    body: rolePlan,
    provenance: {
      producer: "spark",
      projectRef: project.ref,
      parentArtifactRefs: [sparkMdArtifact.ref],
    },
  });

  const gate: ReviewGate = {
    ref: newRef("review"),
    subject: rolePlanArtifact.ref,
    lens: "artifact",
    policy: "required",
    outcome: "blocked",
    summary: "Initial Spark flow created a review gate; reviewer execution is pending.",
    createdAt: nowIso(),
  };

  const trace: SparkRunTrace = {
    ref: newRef("spark"),
    idea,
    projectRef: project.ref,
    sparkMdArtifactRef: sparkMdArtifact.ref,
    taskRefs: graph.tasks(project.ref).map((task) => task.ref),
    reviewRefs: [gate.ref],
    askRefs: options.askRefs ?? [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await store.put({
    kind: "run-trace",
    title: "Spark run trace",
    format: "json",
    body: trace as unknown as JsonValue,
    provenance: {
      producer: "spark",
      projectRef: project.ref,
      parentArtifactRefs: [sparkMdArtifact.ref, rolePlanArtifact.ref],
    },
  });
  await defaultTaskGraphStore(cwd).save(graph);
  await sparkTodoStore(cwd, undefined).save(graph);
  await writeJsonFileAtomic(join(sparkDir, "review-gate.json"), gate);

  const currentTask = graph.currentTask(project.ref);
  const todoSummary = currentTask ? graph.todoSummary(currentTask.ref) : emptyTodoSummary();
  return {
    cwd,
    idea,
    projectTitle,
    projectRef: project.ref,
    taskCount: graph.tasks(project.ref).length,
    outputLanguage: options.clarification?.outputLanguage ?? detectCopyLanguage(idea),
    currentTaskRef: currentTask?.ref,
    currentTaskTitle: currentTask?.title,
    todoSummary: compactTodoSummary(todoSummary),
    sparkMdPath,
    sparkMdArtifactRef: sparkMdArtifact.ref,
    rolePlanArtifactRef: rolePlanArtifact.ref,
    traceRef: trace.ref,
    askArtifactRefs: options.askArtifactRefs ?? [],
  };
}

function createInitialSparkTasks(
  graph: TaskGraph,
  projectRef: ProjectRef,
  idea: string,
  clarification?: SparkInitClarificationData,
): void {
  if (hasScopedClarification(clarification)) {
    const scopedClarification = clarification;
    const scope = graph.createTask({
      projectRef,
      name: "validate-scoped-intent",
      title: "Validate scoped intent",
      description: compactInstruction([
        scopedClarification.objective
          ? `Objective: ${scopedClarification.objective}`
          : `Idea: ${idea}`,
        scopedClarification.targetUser
          ? `Target user: ${scopedClarification.targetUser}`
          : undefined,
        scopedClarification.nonGoals ? `Non-goals: ${scopedClarification.nonGoals}` : undefined,
        "Check the workspace context and surface only blockers that change this confirmed scope.",
      ]),
      kind: "research",
      roleRef: builtinRoleRef("scout"),
    });
    const slice = graph.createTask({
      projectRef,
      name: "execute-smallest-slice",
      title: "Execute smallest confirmed slice",
      description: compactInstruction([
        scopedClarification.smallestSlice
          ? `Smallest slice: ${scopedClarification.smallestSlice}`
          : "Implement the smallest confirmed slice from the clarified scope.",
        scopedClarification.deliveryMode
          ? `Delivery mode: ${describeDeliveryMode(scopedClarification.deliveryMode, scopedClarification.outputLanguage ?? "en")}`
          : undefined,
        "Keep changes inside the confirmed non-goals boundary.",
      ]),
      kind: "implement",
      roleRef: builtinRoleRef("worker"),
    });
    const verify = graph.createTask({
      projectRef,
      name: "verify-success-signal",
      title: "Verify success signal",
      description: compactInstruction([
        scopedClarification.successSignal
          ? `Success signal: ${scopedClarification.successSignal}`
          : "Verify the implemented slice against the clarified objective.",
        "Report whether another ask, review gate, or follow-up task is needed.",
      ]),
      kind: "review",
      roleRef: builtinRoleRef("reviewer"),
    });
    graph.addDependency(slice.ref, scope.ref);
    graph.addDependency(verify.ref, slice.ref);
  }
}

function hasScopedClarification(
  clarification: SparkInitClarificationData | undefined,
): clarification is SparkInitClarificationData {
  return Boolean(
    clarification?.smallestSlice?.trim() ||
    clarification?.successSignal?.trim() ||
    clarification?.nonGoals?.trim() ||
    clarification?.targetUser?.trim(),
  );
}

function compactInstruction(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part?.trim())).join(" ");
}

async function sparkInitResultFromExisting(
  cwd: string,
  idea: string,
  graph: TaskGraph,
  options: SparkInitOptions,
): Promise<SparkInitResult> {
  const project = graph.projects()[0];
  if (!project) throw new Error("existing Spark graph has no project");
  const currentTask = graph.currentTask(project.ref);
  const todoSummary = currentTask ? graph.todoSummary(currentTask.ref) : emptyTodoSummary();
  const latestSparkMd = await readActiveSparkMd(cwd);
  const sparkMdPath = (await pathExists(join(cwd, "SPARK.md"))) ? join(cwd, "SPARK.md") : undefined;
  return {
    cwd,
    idea,
    projectTitle: project.title,
    projectRef: project.ref,
    taskCount: graph.tasks(project.ref).length,
    outputLanguage:
      options.clarification?.outputLanguage ??
      (project.outputLanguage as CopyLanguage | undefined) ??
      detectCopyLanguage(latestSparkMd ?? idea),
    currentTaskRef: currentTask?.ref,
    currentTaskTitle: currentTask?.title,
    todoSummary: compactTodoSummary(todoSummary),
    sparkMdPath,
    sparkMdArtifactRef: "artifact:existing" as ArtifactRef,
    rolePlanArtifactRef: "artifact:existing" as ArtifactRef,
    traceRef: "spark:existing",
    askArtifactRefs: options.askArtifactRefs ?? [],
  };
}

function compactTodoSummary(summary: TaskTodoSummary): SparkInitResult["todoSummary"] {
  return {
    total: summary.total,
    inProgress: summary.inProgress,
    pending: summary.pending,
    done: summary.done,
    blocked: summary.blocked,
    cancelled: summary.cancelled,
  };
}

function emptyTodoSummary(): TaskTodoSummary {
  return {
    total: 0,
    pending: 0,
    inProgress: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
    deleted: 0,
    noteCount: 0,
  };
}
