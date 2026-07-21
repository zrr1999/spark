import {
  defaultEvidenceStore,
  type ArtifactRef,
  type ArtifactStore,
  type EvidenceRef,
} from "@zendev-lab/spark-artifacts";

import { defaultSparkMemoryStore, type SparkMemoryEntry, type SparkMemoryStore } from "./index.ts";
import { defaultRecallStore, type RecallCandidate, type RecallStore } from "./recall-store.ts";

export type SparkCompactionCandidateKind = "stable_fact" | "open_item";

export interface SparkCompactionStructuredSummary {
  preservedFacts?: string[];
  decisions?: string[];
  unresolved?: string[];
  inProgress?: string[];
  memoryRefs?: string[];
  changedFiles?: Array<{ path?: string; change?: string; evidenceRefs?: string[] }>;
  failures?: Array<{
    summary?: string;
    cause?: string;
    nextStep?: string;
    evidenceRefs?: string[];
  }>;
}

export interface SparkCompactionMemoryCandidate {
  kind: SparkCompactionCandidateKind;
  text: string;
  reason: string;
  evidenceRefs: string[];
  sourceSessionId?: string;
}

export interface SparkCompactionCandidatePipelineResult {
  candidates: RecallCandidate[];
  writtenMemory: SparkMemoryEntry[];
  rejectedForEvidence: number;
  failures: string[];
}

export interface SparkCompactionCandidatePipelineOptions {
  cwd: string;
  sessionId?: string;
  summary: unknown;
  details?: unknown;
  candidateStore?: Pick<RecallStore, "list" | "record">;
  memoryStore?: Pick<SparkMemoryStore, "list" | "remember">;
  evidenceStore?: Pick<ArtifactStore, "tryGet">;
  reviewCandidate?: (candidate: SparkCompactionMemoryCandidate) => Promise<"accept" | "reject">;
}

const EVIDENCE_REF_PATTERN =
  /\b(?:artifact|evidence):[A-Za-z0-9][A-Za-z0-9._-]*(?![:A-Za-z0-9._-])/gu;
const VALID_EVIDENCE_REF_PATTERN = /^(?:artifact|evidence):[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Extract only the durable portions of the structured Smart summary. Open work
 * remains a candidate forever; it is never promoted to durable Memory here.
 */
export function extractSparkCompactionCandidates(
  summary: unknown,
  options: { sessionId?: string } = {},
): SparkCompactionMemoryCandidate[] {
  const structured = normalizeStructuredSummary(summary);
  if (!structured) return [];
  const candidates: SparkCompactionMemoryCandidate[] = [];

  for (const text of uniqueNonEmpty(structured.preservedFacts ?? [])) {
    candidates.push({
      kind: "stable_fact",
      text,
      reason: "Preserved fact emitted by the completed Smart compaction summary.",
      evidenceRefs: refsInText(text),
      ...(options.sessionId ? { sourceSessionId: options.sessionId } : {}),
    });
  }
  for (const text of uniqueNonEmpty(structured.decisions ?? [])) {
    candidates.push({
      kind: "stable_fact",
      text,
      reason: "Decision emitted by the completed Smart compaction summary.",
      evidenceRefs: refsInText(text),
      ...(options.sessionId ? { sourceSessionId: options.sessionId } : {}),
    });
  }
  for (const changedFile of structured.changedFiles ?? []) {
    const text = [changedFile.path, changedFile.change].filter(Boolean).join(": ").trim();
    if (!text) continue;
    candidates.push({
      kind: "stable_fact",
      text,
      reason: "Changed file emitted by the completed Smart compaction summary.",
      evidenceRefs: uniqueNonEmpty(changedFile.evidenceRefs ?? []),
      ...(options.sessionId ? { sourceSessionId: options.sessionId } : {}),
    });
  }
  for (const text of uniqueNonEmpty([
    ...(structured.unresolved ?? []),
    ...(structured.inProgress ?? []),
  ])) {
    candidates.push({
      kind: "open_item",
      text,
      reason: "Open work emitted by the completed Smart compaction summary.",
      evidenceRefs: refsInText(text),
      ...(options.sessionId ? { sourceSessionId: options.sessionId } : {}),
    });
  }
  for (const failure of structured.failures ?? []) {
    const text = [failure.summary, failure.cause, failure.nextStep]
      .filter(Boolean)
      .join("; ")
      .trim();
    if (!text) continue;
    candidates.push({
      kind: "open_item",
      text,
      reason: "Failure follow-up emitted by the completed Smart compaction summary.",
      evidenceRefs: uniqueNonEmpty(failure.evidenceRefs ?? []),
      ...(options.sessionId ? { sourceSessionId: options.sessionId } : {}),
    });
  }
  return candidates;
}

/**
 * Run candidate persistence and evidence-gated Memory promotion independently
 * of the foreground compact request. Each candidate is isolated so one bad
 * artifact, reviewer, or store cannot prevent the remaining candidates.
 */
export async function runSparkCompactionCandidatePipeline(
  options: SparkCompactionCandidatePipelineOptions,
): Promise<SparkCompactionCandidatePipelineResult> {
  const candidateStore = options.candidateStore ?? defaultRecallStore(options.cwd, "workspace");
  const memoryStore = options.memoryStore ?? defaultSparkMemoryStore(options.cwd, "workspace");
  const evidenceStore = options.evidenceStore ?? defaultEvidenceStore(options.cwd);
  const extracted = extractSparkCompactionCandidates(options.details ?? options.summary, {
    sessionId: options.sessionId,
  });
  const persisted: RecallCandidate[] = [];
  const writtenMemory: SparkMemoryEntry[] = [];
  const failures: string[] = [];
  let rejectedForEvidence = 0;

  for (const candidate of extracted) {
    let stored: RecallCandidate | undefined;
    try {
      const existing = (await candidateStore.list()).find(
        (item) =>
          item.status === "candidate" &&
          item.kind === candidate.kind &&
          item.text === candidate.text &&
          item.sourceSessionId === candidate.sourceSessionId,
      );
      stored =
        existing ??
        (await candidateStore.record({
          scope: "workspace",
          text: candidate.text,
          reason: candidate.reason,
          evidenceRefs: candidate.evidenceRefs,
          kind: candidate.kind,
          ...(candidate.sourceSessionId ? { sourceSessionId: candidate.sourceSessionId } : {}),
        }));
      persisted.push(stored);
    } catch (error) {
      failures.push(`candidate ${candidate.kind} persistence failed: ${errorMessage(error)}`);
      continue;
    }

    if (candidate.kind !== "stable_fact") continue;
    try {
      const review = options.reviewCandidate ? await options.reviewCandidate(candidate) : "accept";
      if (review !== "accept") continue;
      const validEvidenceRefs = await resolveValidEvidenceRefs(
        evidenceStore,
        candidate.evidenceRefs,
      );
      if (validEvidenceRefs.length === 0) {
        rejectedForEvidence += 1;
        continue;
      }
      const existingMemory = (await memoryStore.list()).find(
        (entry) =>
          entry.status === "active" &&
          entry.text === candidate.text &&
          sameStrings(entry.evidenceRefs, validEvidenceRefs),
      );
      if (existingMemory) continue;
      const memory = await memoryStore.remember({
        scope: "workspace",
        category: "insight",
        text: candidate.text,
        reason: candidate.reason,
        evidenceRefs: validEvidenceRefs,
        tags: ["compaction", "stable-fact"],
      });
      writtenMemory.push(memory);
    } catch (error) {
      failures.push(`candidate ${stored.id} review or Memory write failed: ${errorMessage(error)}`);
    }
  }

  return { candidates: persisted, writtenMemory, rejectedForEvidence, failures };
}

function normalizeStructuredSummary(value: unknown): SparkCompactionStructuredSummary | undefined {
  if (!isRecord(value) || value.mode !== "smart" || !isRecord(value.structured)) return undefined;
  const root = value.structured;
  if (root.version !== 1 || typeof root.objective !== "string") return undefined;
  const requiredStringArrays = [
    "completed",
    "inProgress",
    "decisions",
    "preservedFacts",
    "unresolved",
    "memoryRefs",
  ] as const;
  if (requiredStringArrays.some((key) => !isStringArray(root[key]))) return undefined;
  if (!validChangedFileArray(root.changedFiles)) return undefined;
  if (!validCommandArray(root.commands)) return undefined;
  if (!validFailureArray(root.failures)) return undefined;
  return {
    preservedFacts: root.preservedFacts,
    decisions: root.decisions,
    unresolved: root.unresolved,
    inProgress: root.inProgress,
    memoryRefs: root.memoryRefs,
    changedFiles: root.changedFiles,
    failures: root.failures,
  } as SparkCompactionStructuredSummary;
}

function refsInText(text: string): string[] {
  return uniqueNonEmpty([...text.matchAll(EVIDENCE_REF_PATTERN)].map((match) => match[0]));
}

async function resolveValidEvidenceRefs(
  store: Pick<ArtifactStore, "tryGet">,
  refs: readonly string[],
): Promise<string[]> {
  const valid: string[] = [];
  for (const ref of uniqueNonEmpty([...refs])) {
    if (!VALID_EVIDENCE_REF_PATTERN.test(ref)) continue;
    try {
      if (await store.tryGet(ref as ArtifactRef | EvidenceRef)) valid.push(ref);
    } catch {
      // A malformed or unreadable evidence artifact fails closed for this candidate.
    }
  }
  return valid;
}

function validChangedFileArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.path === "string" &&
        typeof item.change === "string" &&
        isStringArray(item.evidenceRefs),
    )
  );
}

function validCommandArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.command === "string" &&
        (item.result === "passed" ||
          item.result === "failed" ||
          item.result === "blocked" ||
          item.result === "unknown") &&
        typeof item.detail === "string",
    )
  );
}

function validFailureArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.summary === "string" &&
        typeof item.cause === "string" &&
        typeof item.nextStep === "string" &&
        isStringArray(item.evidenceRefs),
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
