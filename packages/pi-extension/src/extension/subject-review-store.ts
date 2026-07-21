import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  nowIso,
  type ArtifactRef,
  type JsonValue,
  type ProjectRef,
  type RoleRef,
  type Task,
} from "@zendev-lab/spark-core";
import type { Artifact } from "@zendev-lab/spark-artifacts";
import { readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import { sessionDirectoryNameForKey } from "@zendev-lab/spark-loop";
import type { SparkSessionGoal } from "./spark-session-goals.ts";
import type {
  GoalReviewInput,
  GoalReviewVerdict,
  ReviewerRunResult,
  TaskReviewVerdict,
} from "./reviewer-runner.ts";

export type SubjectReviewKind = "task" | "goal";

export interface SubjectReviewRecord {
  version: 1;
  subjectKind: SubjectReviewKind;
  subjectRef: string;
  artifactRef: ArtifactRef;
  projectRef?: ProjectRef;
  sessionKey?: string;
  transition: {
    requestedStatus: string;
    policy: "required";
  };
  status: "resolved";
  outcome: string;
  summary: string;
  requestedAt: string;
  resolvedAt: string;
  reviewedAt: string;
  recordedAt: string;
  updatedAt: string;
  reviewerRun: {
    runRef?: string;
    roleRef?: RoleRef;
    runName?: string;
    startedAt?: string;
    finishedAt?: string;
    thinking?: string;
  };
  verdict: JsonValue;
  reviewPacket?: JsonValue;
  legacyImportOnly: string[];
}

export interface SubjectReviewIndexEntry {
  subjectKind: SubjectReviewKind;
  subjectRef: string;
  artifactRef: ArtifactRef;
  path: string;
  status: "resolved";
  outcome: string;
  reviewedAt: string;
  projectRef?: ProjectRef;
  sessionKey?: string;
}

export interface SubjectReviewIndexSnapshot {
  version: 1;
  rebuildable: true;
  generatedAt: string;
  source: "subject-review-records";
  legacyImportOnly: string[];
  reviews: SubjectReviewIndexEntry[];
}

export interface WorkspaceSubjectReviewIndexEntry extends SubjectReviewIndexEntry {
  path: string;
}

export interface WorkspaceSubjectReviewIndexSnapshot {
  version: 1;
  rebuildable: true;
  generatedAt: string;
  source: "subject-review-records";
  legacyImportOnly: string[];
  reviews: WorkspaceSubjectReviewIndexEntry[];
}

const LEGACY_REVIEW_IMPORT_ONLY = [".spark/review-gate.json"];

export async function recordTaskSubjectReview(
  cwd: string,
  projectRef: ProjectRef,
  task: Task,
  artifact: Artifact<JsonValue>,
  review: ReviewerRunResult,
): Promise<SubjectReviewRecord> {
  const verdict = review.verdict as TaskReviewVerdict;
  const record: SubjectReviewRecord = {
    version: 1,
    subjectKind: "task",
    subjectRef: task.ref,
    artifactRef: artifact.ref,
    projectRef,
    transition: { requestedStatus: "done", policy: "required" },
    status: "resolved",
    outcome: verdict.outcome,
    summary: verdict.summary,
    requestedAt: review.record.startedAt ?? nowIso(),
    resolvedAt: review.record.finishedAt ?? nowIso(),
    reviewedAt: review.record.finishedAt ?? nowIso(),
    recordedAt: nowIso(),
    updatedAt: nowIso(),
    reviewerRun: compactReviewerRun(review),
    verdict: verdict as unknown as JsonValue,
    legacyImportOnly: LEGACY_REVIEW_IMPORT_ONLY,
  };
  await writeSubjectReviewRecord(
    cwd,
    taskReviewDirectory(cwd, projectRef, task.ref),
    artifact.ref,
    record,
  );
  return record;
}

export async function recordGoalSubjectReview(
  cwd: string,
  goal: SparkSessionGoal,
  artifact: Artifact<JsonValue>,
  review: ReviewerRunResult,
  input: GoalReviewInput,
): Promise<SubjectReviewRecord> {
  const verdict = review.verdict as GoalReviewVerdict;
  const record: SubjectReviewRecord = {
    version: 1,
    subjectKind: "goal",
    subjectRef: goal.goalId,
    artifactRef: artifact.ref,
    ...(input.projectRef ? { projectRef: input.projectRef } : {}),
    sessionKey: goal.sessionKey,
    transition: { requestedStatus: input.requestedStatus, policy: "required" },
    status: "resolved",
    outcome: verdict.outcome,
    summary: verdict.summary,
    requestedAt: review.record.startedAt ?? nowIso(),
    resolvedAt: review.record.finishedAt ?? nowIso(),
    reviewedAt: review.record.finishedAt ?? nowIso(),
    recordedAt: nowIso(),
    updatedAt: nowIso(),
    reviewerRun: compactReviewerRun(review),
    verdict: verdict as unknown as JsonValue,
    reviewPacket: {
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
      originalObjective: input.originalObjective ?? goal.originalObjective ?? goal.objective,
      objective: input.objective,
      currentProjectSelected: input.currentProjectSelected ?? false,
      projectEvidenceSource: input.projectEvidenceSource ?? "none",
      ...(input.projectStatus
        ? { projectStatus: input.projectStatus as unknown as JsonValue }
        : {}),
      evidenceRefs: input.evidenceRefs,
      requirements: input.requirements ?? [],
      validationRuns: input.validationRuns ?? [],
      unresolved: input.unresolved ?? [],
    } as unknown as JsonValue,
    legacyImportOnly: LEGACY_REVIEW_IMPORT_ONLY,
  };
  await writeSubjectReviewRecord(cwd, goalReviewDirectory(cwd, goal), artifact.ref, record);
  return record;
}

export function taskReviewDirectory(cwd: string, projectRef: ProjectRef, taskRef: string): string {
  return join(
    cwd,
    ".spark",
    "projects",
    storeDirName(projectRef),
    "tasks",
    storeDirName(taskRef),
    "reviews",
  );
}

export function goalReviewDirectory(
  cwd: string,
  goal: Pick<SparkSessionGoal, "goalId" | "sessionKey">,
): string {
  return join(
    cwd,
    ".spark",
    "sessions",
    sessionDirectoryNameForKey(goal.sessionKey),
    "goal-reviews",
    storeDirName(goal.goalId),
  );
}

export function subjectReviewRecordPath(reviewDirectory: string, artifactRef: ArtifactRef): string {
  return join(reviewDirectory, `${storeDirName(artifactRef)}.json`);
}

export async function rebuildSubjectReviewIndex(
  reviewDirectory: string,
): Promise<SubjectReviewIndexSnapshot> {
  const entries: SubjectReviewIndexEntry[] = [];
  for (const fileName of await listReviewRecordFiles(reviewDirectory)) {
    const filePath = join(reviewDirectory, fileName);
    const record = await readJsonFileOptional<Record<string, unknown>>(filePath);
    if (!record) continue;
    entries.push(subjectReviewIndexEntry(record, fileName));
  }
  entries.sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt));
  const snapshot: SubjectReviewIndexSnapshot = {
    version: 1,
    rebuildable: true,
    generatedAt: nowIso(),
    source: "subject-review-records",
    legacyImportOnly: LEGACY_REVIEW_IMPORT_ONLY,
    reviews: entries,
  };
  await writeJsonFileAtomic(join(reviewDirectory, "index.json"), snapshot);
  return snapshot;
}

export async function rebuildWorkspaceReviewIndex(
  cwd: string,
): Promise<WorkspaceSubjectReviewIndexSnapshot> {
  const root = join(cwd, ".spark");
  const files = [
    ...(await findSubjectReviewRecordFiles(join(root, "projects"))),
    ...(await findSubjectReviewRecordFiles(join(root, "sessions"))),
  ];
  const reviews: WorkspaceSubjectReviewIndexEntry[] = [];
  for (const filePath of files) {
    const record = await readJsonFileOptional<Record<string, unknown>>(filePath);
    if (!record) continue;
    reviews.push({
      ...subjectReviewIndexEntry(record, relative(root, filePath)),
      path: relative(root, filePath),
    });
  }
  reviews.sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt));
  const snapshot: WorkspaceSubjectReviewIndexSnapshot = {
    version: 1,
    rebuildable: true,
    generatedAt: nowIso(),
    source: "subject-review-records",
    legacyImportOnly: LEGACY_REVIEW_IMPORT_ONLY,
    reviews,
  };
  await writeJsonFileAtomic(join(root, "reviews", "index.json"), snapshot);
  return snapshot;
}

async function writeSubjectReviewRecord(
  cwd: string,
  reviewDirectory: string,
  artifactRef: ArtifactRef,
  record: SubjectReviewRecord,
): Promise<void> {
  await writeJsonFileAtomic(subjectReviewRecordPath(reviewDirectory, artifactRef), record);
  await rebuildSubjectReviewIndex(reviewDirectory);
  await rebuildWorkspaceReviewIndex(cwd);
}

function compactReviewerRun(review: ReviewerRunResult): SubjectReviewRecord["reviewerRun"] {
  return {
    ...(review.record.runRef ? { runRef: review.record.runRef } : {}),
    roleRef: review.record.roleRef,
    ...(review.record.runName ? { runName: review.record.runName } : {}),
    startedAt: review.record.startedAt,
    finishedAt: review.record.finishedAt,
    ...(review.record.thinking ? { thinking: review.record.thinking } : {}),
  };
}

async function listReviewRecordFiles(reviewDirectory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(reviewDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .sort();
}

async function findSubjectReviewRecordFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectSubjectReviewRecordFiles(root, files);
  return files.sort();
}

async function collectSubjectReviewRecordFiles(root: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectSubjectReviewRecordFiles(path, files);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      entry.name !== "index.json" &&
      (path.includes(`${sep}reviews${sep}`) || path.includes(`${sep}goal-reviews${sep}`))
    ) {
      files.push(path);
    }
  }
}

function subjectReviewIndexEntry(
  value: Record<string, unknown>,
  fileName: string,
): SubjectReviewIndexEntry {
  return {
    subjectKind: subjectReviewKind(value.subjectKind),
    subjectRef: stringField(value.subjectRef, "subjectRef"),
    artifactRef: stringField(value.artifactRef, "artifactRef") as ArtifactRef,
    path: fileName,
    status: "resolved",
    outcome: stringField(value.outcome, "outcome"),
    reviewedAt: stringField(value.reviewedAt, "reviewedAt"),
    ...(typeof value.projectRef === "string" ? { projectRef: value.projectRef as ProjectRef } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
  };
}

function subjectReviewKind(value: unknown): SubjectReviewKind {
  if (value === "task" || value === "goal") return value;
  throw new Error("subject review record subjectKind must be task or goal");
}

function stringField(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`subject review record ${field} must be a non-empty string`);
}

function storeDirName(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-");
}
