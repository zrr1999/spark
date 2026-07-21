import { type Artifact } from "@zendev-lab/spark-artifacts";
import { isRef, type ArtifactRef } from "@zendev-lab/spark-core";

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

export function normalizeArtifactBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
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
