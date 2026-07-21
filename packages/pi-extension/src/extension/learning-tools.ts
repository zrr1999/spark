import {
  type LearningCategory,
  type LearningRecord,
  type LearningLocation,
  type LearningRecordInput,
  type LearningStatus,
} from "@zendev-lab/spark-memory";
import type { Artifact } from "@zendev-lab/spark-artifacts";

const LEARNING_STATUSES = ["candidate", "active", "stale", "superseded", "rejected"] as const;
const LEARNING_LOCATIONS = ["user", "workspace", "repo"] as const;
const LEARNING_CATEGORIES = [
  "pattern",
  "gotcha",
  "decision",
  "workflow",
  "tool",
  "project",
] as const;

export function normalizeLearningStatus(value: unknown): LearningStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (LEARNING_STATUSES.includes(value as LearningStatus)) return value as LearningStatus;
  throw new Error("status must be candidate, active, stale, superseded, or rejected");
}

export function normalizeLearningStatusFilter(
  value: unknown,
): LearningStatus | LearningStatus[] | undefined {
  if (Array.isArray(value)) {
    const statuses = value.map((item) => {
      const status = normalizeLearningStatus(item);
      if (!status)
        throw new Error(
          "status array entries must be candidate, active, stale, superseded, or rejected",
        );
      return status;
    });
    return statuses.length ? statuses : undefined;
  }
  return normalizeLearningStatus(value);
}

export function normalizeLearningLocation(value: unknown): LearningLocation | undefined {
  if (value === undefined || value === null) return undefined;
  if (LEARNING_LOCATIONS.includes(value as LearningLocation)) return value as LearningLocation;
  throw new Error("location must be user, workspace, or repo");
}

export function normalizeLearningCategory(value: unknown): LearningCategory | undefined {
  if (value === undefined || value === null) return undefined;
  if (LEARNING_CATEGORIES.includes(value as LearningCategory)) return value as LearningCategory;
  throw new Error("category must be pattern, gotcha, decision, workflow, tool, or project");
}

export function normalizeStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${field} must be a string array`);
  return value;
}

export function normalizeLearningBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function normalizeLearningString(
  value: unknown,
  field: string,
  options: { required?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${field} must be a non-empty string`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (options.required && value.trim().length === 0)
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

export function normalizeLearningConfidence(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("confidence must be a finite number between 0 and 1");
  return value;
}

export function normalizeLearningInput(params: Record<string, unknown>): LearningRecordInput {
  return {
    title: normalizeLearningString(params.title, "title", { required: true }) ?? "",
    statement: normalizeLearningString(params.statement, "statement", { required: true }) ?? "",
    id: normalizeLearningString(params.id, "id"),
    category: normalizeLearningCategory(params.category),
    status: normalizeLearningStatus(params.status),
    applicability: normalizeLearningString(params.applicability, "applicability"),
    nonApplicability: normalizeLearningString(params.nonApplicability, "nonApplicability"),
    rationale: normalizeLearningString(params.rationale, "rationale"),
    evidenceRefs: normalizeStringArray(params.evidenceRefs, "evidenceRefs"),
    sourcePaths: normalizeStringArray(params.sourcePaths, "sourcePaths"),
    sourceHash: normalizeLearningString(params.sourceHash, "sourceHash"),
    sourceContent: normalizeLearningString(params.sourceContent, "sourceContent"),
    dependsOn: normalizeStringArray(params.dependsOn, "dependsOn"),
    supersedes: normalizeStringArray(params.supersedes, "supersedes"),
    supersededBy: normalizeStringArray(params.supersededBy, "supersededBy"),
    contradictedBy: normalizeStringArray(params.contradictedBy, "contradictedBy"),
    tags: normalizeStringArray(params.tags, "tags"),
    confidence: normalizeLearningConfidence(params.confidence),
  };
}

export function compactLearningDetail(
  artifact: Artifact<LearningRecord>,
  location = inferLearningArtifactLocation(artifact),
) {
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.body.title,
    status: artifact.body.status,
    category: artifact.body.category,
    location,
    tags: artifact.body.tags,
    evidenceRefs: artifact.body.evidenceRefs,
    dependsOn: artifact.body.dependsOn,
    supersedes: artifact.body.supersedes,
    supersededBy: artifact.body.supersededBy,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function inferLearningArtifactLocation(artifact: Artifact<LearningRecord>): LearningLocation {
  const note = artifact.provenance.note ?? "";
  if (note.includes("location=user")) return "user";
  if (note.includes("location=repo")) return "repo";
  if (note.includes("location=workspace")) return "workspace";
  return "workspace";
}
