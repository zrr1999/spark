import type { Artifact, ArtifactKind, Provenance } from "pi-artifacts";
import {
  isRef,
  type ArtifactRef,
  type ProjectRef,
  type RoleRef,
  type TaskRef,
} from "pi-extension-api";

export function normalizeArtifactLimit(value: unknown, fallback: number, field = "limit"): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer`);
  return value;
}

export function normalizePositiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

export function normalizeArtifactKind(value: unknown): ArtifactKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === "spark-md" ||
    value === "research" ||
    value === "plan" ||
    value === "task-breakdown" ||
    value === "role-plan" ||
    value === "handoff" ||
    value === "review" ||
    value === "cue-output" ||
    value === "role-run" ||
    value === "role-spec-proposal" ||
    value === "ask-answer" ||
    value === "run-trace" ||
    value === "learning" ||
    value === "learning-candidate" ||
    value === "learning-export"
  )
    return value;
  throw new Error(
    "kind must be spark-md, research, plan, task-breakdown, role-plan, handoff, review, cue-output, role-run, role-spec-proposal, ask-answer, run-trace, learning, learning-candidate, or learning-export",
  );
}

export function normalizeArtifactProducer(value: unknown): Provenance["producer"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === "spark" ||
    value === "role" ||
    value === "task" ||
    value === "ask" ||
    value === "cue" ||
    value === "review" ||
    value === "user"
  )
    return value;
  throw new Error("producer must be spark, role, task, ask, cue, review, or user");
}

export function normalizeArtifactBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function normalizeArtifactProjectRef(value: unknown): ProjectRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("projectRef must be a string");
  if (!isRef(value, "proj")) throw new Error("projectRef must be a proj: ref");
  return value;
}

export function normalizeArtifactTaskRef(value: unknown): TaskRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("taskRef must be a string");
  if (!isRef(value, "task")) throw new Error("taskRef must be a task: ref");
  return value;
}

export function normalizeArtifactRoleRef(value: unknown): RoleRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("roleRef must be a string");
  if (!isRef(value, "role")) throw new Error("roleRef must be a role: ref");
  return value;
}

export function normalizeArtifactRef(value: unknown): ArtifactRef {
  if (typeof value !== "string") throw new Error("artifactRef must be a string");
  if (!isRef(value, "artifact")) throw new Error("artifactRef must be an artifact: ref");
  return value;
}

export function compactArtifactDetail(artifact: Artifact) {
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    format: artifact.format,
    producer: artifact.provenance.producer,
    projectRef: artifact.provenance.projectRef,
    taskRef: artifact.provenance.taskRef,
    roleRef: artifact.provenance.roleRef,
    bodySize: artifact.bodySize,
    bodyTruncated: artifact.bodyTruncated,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

export function truncateBlock(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
