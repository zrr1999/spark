import { readFile } from "node:fs/promises";
import {
  type LearningCategory,
  LearningExportFormatError,
  type LearningRecord,
  type LearningLocation,
  type LearningRecordInput,
  type LearningSearchResult,
  type LearningStatus,
  type LearningStoreDiagnostic,
  parseLearningExportMarkdown,
} from "@zendev-lab/spark-learnings";
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

export function normalizeLearningArtifactRef(value: unknown, field = "ref"): string {
  const ref = normalizeLearningString(value, field, { required: true });
  if (!ref) throw new Error(`${field} must be a non-empty string`);
  return ref;
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

export function compactLearningSearchResult(result: LearningSearchResult) {
  return {
    ref: result.ref,
    title: result.record.title,
    status: result.record.status,
    category: result.record.category,
    location: result.location,
    score: result.score,
    snippet: result.snippet,
    evidenceSummary: result.evidenceSummary,
  };
}

export function formatLearningLine(
  artifact: Artifact<LearningRecord>,
  location = inferLearningArtifactLocation(artifact),
): string {
  const tags = formatLearningTags(artifact.body.tags);
  return `- [${artifact.body.status}/${artifact.body.category}/${location}] ${artifact.ref}: ${artifact.body.title}${tags}`;
}

export function formatLearningSearchLine(result: LearningSearchResult): string {
  const tags = formatLearningTags(result.record.tags);
  return `- [${result.record.status}/${result.record.category}/${result.location}] ${result.ref}: ${result.record.title} — ${result.snippet}${tags}`;
}

export function formatLearningDiagnostics(
  diagnostics: readonly LearningStoreDiagnostic[],
): string[] {
  if (diagnostics.length === 0) return [];
  const visible = diagnostics.slice(0, 5);
  const lines = [`Warnings: skipped ${diagnostics.length} invalid learning artifact(s)`];
  for (const diagnostic of visible) {
    const source = diagnostic.ref ?? diagnostic.filePath ?? diagnostic.source;
    lines.push(`- skipped ${source}: ${diagnostic.message}`);
  }
  if (visible.length < diagnostics.length)
    lines.push(`- … ${diagnostics.length - visible.length} more invalid learning artifact(s)`);
  return lines;
}

export function compactLearningDiagnostic(diagnostic: LearningStoreDiagnostic) {
  return {
    source: diagnostic.source,
    ref: diagnostic.ref,
    filePath: diagnostic.filePath,
    message: diagnostic.message,
  };
}

function formatLearningTags(tags: readonly string[]): string {
  if (tags.length === 0) return "";
  const visible = tags.slice(0, 5);
  const hidden = tags.length - visible.length;
  return ` tags=${visible.join(",")}${hidden > 0 ? `,…+${hidden}` : ""}`;
}

function inferLearningArtifactLocation(artifact: Artifact<LearningRecord>): LearningLocation {
  const note = artifact.provenance.note ?? "";
  if (note.includes("location=user")) return "user";
  if (note.includes("location=repo")) return "repo";
  if (note.includes("location=workspace")) return "workspace";
  return "workspace";
}

export interface ParsedLearningImport {
  source: "spark-export";
  records: LearningRecord[];
  inputs: LearningRecordInput[];
}

export async function parseLearningImportPath(
  _cwd: string,
  inputPath: string,
): Promise<ParsedLearningImport> {
  const markdown = await readFile(inputPath, "utf8");
  let records: LearningRecord[];
  try {
    records = parseLearningExportMarkdown(markdown, inputPath);
  } catch (error) {
    if (error instanceof LearningExportFormatError) {
      throw new Error(actionableLearningImportError(inputPath, error.message));
    }
    throw error;
  }
  if (records.length === 0) throw new Error(actionableLearningImportError(inputPath));
  return { source: "spark-export", records, inputs: [] };
}

function actionableLearningImportError(inputPath: string, cause?: string): string {
  const lines = [
    `[E_LEARNING_IMPORT_FORMAT] ${inputPath} is not a Spark learning export Markdown file.`,
  ];
  if (cause) lines.push(`  cause: ${cause}`);
  lines.push(
    '  expected: Markdown produced by learning({ action: "export_markdown", outputPath }) containing ```json pi-learning fenced blocks.',
    '  dry-run: learning({ action: "import_markdown", inputPath }) parses without writing; set apply=true only after the dry-run count looks right.',
    '  next: export with learning({ action: "export_markdown" }) or convert each item to the pi-learning JSON fenced-block format before importing.',
  );
  return lines.join("\n");
}
