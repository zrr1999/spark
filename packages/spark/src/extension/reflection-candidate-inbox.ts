import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  isLikelyReflectionHarnessText,
  type ReflectionObservation,
  type ReflectionSignalKind,
} from "./reflection-session-scanner.ts";

export const REFLECTION_CANDIDATE_STORE_VERSION = 1;

export type ReflectionCandidateStatus = "open" | "ignored" | "resolved" | "exported";
export type ReflectionCandidateConfidence = "low" | "medium" | "high";

export interface ReflectionCandidateSourceRef {
  file: string;
  line: number;
  kind?: ReflectionObservation["kind"];
  entryId?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  customType?: string;
}

export interface ReflectionCandidate {
  id: string;
  fingerprint: string;
  status: ReflectionCandidateStatus;
  title: string;
  reason: string;
  suggestedNextAction: string;
  confidence: ReflectionCandidateConfidence;
  signals: ReflectionSignalKind[];
  excerpt: string;
  sourceRefs: ReflectionCandidateSourceRef[];
  occurrenceCount: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  dispositionNote?: string;
}

export interface ReflectionCandidateStore {
  version: typeof REFLECTION_CANDIDATE_STORE_VERSION;
  updatedAt: string;
  candidates: ReflectionCandidate[];
}

export interface ReflectionCandidateUpsertResult {
  store: ReflectionCandidateStore;
  created: ReflectionCandidate[];
  updated: ReflectionCandidate[];
  skipped: number;
}

export interface ReflectionCandidateBuildOptions {
  now?: string;
  maxCandidates?: number;
  includeHarnessPrompts?: boolean;
}

export function reflectionCandidateStorePath(cwd: string, name = "candidates"): string {
  return join(cwd, ".spark", "reflections", `${name}.json`);
}

export function emptyReflectionCandidateStore(
  now = new Date().toISOString(),
): ReflectionCandidateStore {
  return { version: REFLECTION_CANDIDATE_STORE_VERSION, updatedAt: now, candidates: [] };
}

export async function loadReflectionCandidateStore(
  path: string,
): Promise<ReflectionCandidateStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return normalizeReflectionCandidateStore(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyReflectionCandidateStore();
    throw error;
  }
}

export async function saveReflectionCandidateStore(
  path: string,
  store: ReflectionCandidateStore,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function upsertReflectionCandidates(
  store: ReflectionCandidateStore,
  observations: readonly ReflectionObservation[],
  options: ReflectionCandidateBuildOptions = {},
): ReflectionCandidateUpsertResult {
  const now = options.now ?? new Date().toISOString();
  const maxCandidates = options.maxCandidates ?? 200;
  const candidates = [...store.candidates];
  const byFingerprint = new Map(candidates.map((candidate) => [candidate.fingerprint, candidate]));
  const created: ReflectionCandidate[] = [];
  const updated: ReflectionCandidate[] = [];
  let skipped = 0;

  for (const observation of observations) {
    const candidate = candidateFromObservation(observation, now, options);
    if (!candidate) {
      skipped += 1;
      continue;
    }
    const existing = byFingerprint.get(candidate.fingerprint);
    if (!existing) {
      if (candidates.length >= maxCandidates) {
        skipped += 1;
        continue;
      }
      candidates.push(candidate);
      byFingerprint.set(candidate.fingerprint, candidate);
      created.push(candidate);
      continue;
    }
    mergeCandidate(existing, candidate, now);
    updated.push(existing);
  }

  candidates.sort(compareCandidates);
  return {
    store: { version: REFLECTION_CANDIDATE_STORE_VERSION, updatedAt: now, candidates },
    created,
    updated,
    skipped,
  };
}

export function listReflectionCandidates(
  store: ReflectionCandidateStore,
  status: ReflectionCandidateStatus | "all" = "open",
): ReflectionCandidate[] {
  const candidates =
    status === "all"
      ? [...store.candidates]
      : store.candidates.filter((candidate) => candidate.status === status);
  return candidates.sort(compareCandidates);
}

export function readReflectionCandidate(
  store: ReflectionCandidateStore,
  id: string,
): ReflectionCandidate | undefined {
  return store.candidates.find((candidate) => candidate.id === id);
}

export function dispositionReflectionCandidate(
  store: ReflectionCandidateStore,
  input: {
    id: string;
    status: Exclude<ReflectionCandidateStatus, "open">;
    note?: string;
    now?: string;
  },
): ReflectionCandidateStore {
  const now = input.now ?? new Date().toISOString();
  let found = false;
  const candidates = store.candidates.map((candidate) => {
    if (candidate.id !== input.id) return candidate;
    found = true;
    return {
      ...candidate,
      status: input.status,
      dispositionNote: input.note,
      updatedAt: now,
    } satisfies ReflectionCandidate;
  });
  if (!found) throw new Error(`reflection candidate not found: ${input.id}`);
  return { version: REFLECTION_CANDIDATE_STORE_VERSION, updatedAt: now, candidates };
}

export function renderReflectionCandidateReport(
  store: ReflectionCandidateStore,
  options: { status?: ReflectionCandidateStatus | "all"; limit?: number } = {},
): string {
  const status = options.status ?? "open";
  const candidates = listReflectionCandidates(store, status).slice(0, options.limit ?? 25);
  const lines = [
    "# Reflection candidate inbox",
    "",
    `Status filter: ${status}`,
    `Candidates shown: ${candidates.length}`,
    `Store updated: ${store.updatedAt}`,
    "",
  ];
  if (candidates.length === 0) {
    lines.push("No reflection candidates match this filter.");
    return lines.join("\n");
  }
  for (const [index, candidate] of candidates.entries()) {
    lines.push(
      `## ${index + 1}. ${candidate.title}`,
      "",
      `- id: ${candidate.id}`,
      `- status: ${candidate.status}`,
      `- confidence: ${candidate.confidence}`,
      `- signals: ${candidate.signals.join(", ")}`,
      `- occurrences: ${candidate.occurrenceCount}`,
      `- reason: ${candidate.reason}`,
      `- suggested next action: ${candidate.suggestedNextAction}`,
      `- first source: ${formatSourceRef(candidate.sourceRefs[0])}`,
      "",
      candidate.excerpt,
      "",
    );
  }
  return lines.join("\n");
}

export function candidateFromObservation(
  observation: ReflectionObservation,
  now = new Date().toISOString(),
  options: Pick<ReflectionCandidateBuildOptions, "includeHarnessPrompts"> = {},
): ReflectionCandidate | undefined {
  if (observation.signals.length === 0) return undefined;
  if (!options.includeHarnessPrompts && isLikelyReflectionHarnessText(observation.text))
    return undefined;
  const fingerprint = candidateFingerprint(observation);
  const id = `reflection:${fingerprint.slice(0, 12)}`;
  return {
    id,
    fingerprint,
    status: "open",
    title: candidateTitle(observation),
    reason: candidateReason(observation),
    suggestedNextAction: candidateSuggestedNextAction(observation),
    confidence: candidateConfidence(observation.signals),
    signals: observation.signals,
    excerpt: observation.excerpt,
    sourceRefs: [sourceRefFromObservation(observation)],
    occurrenceCount: 1,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: observation.source.timestamp ?? now,
  };
}

function mergeCandidate(
  target: ReflectionCandidate,
  incoming: ReflectionCandidate,
  now: string,
): void {
  target.updatedAt = now;
  target.lastSeenAt = incoming.lastSeenAt;
  target.occurrenceCount += 1;
  target.confidence = maxConfidence(target.confidence, incoming.confidence);
  target.signals = [...new Set([...target.signals, ...incoming.signals])];
  for (const sourceRef of incoming.sourceRefs) {
    if (!target.sourceRefs.some((existing) => sourceRefsEqual(existing, sourceRef)))
      target.sourceRefs.push(sourceRef);
  }
}

function candidateFingerprint(observation: ReflectionObservation): string {
  const normalizedText = observation.text
    .replace(/\s+/gu, " ")
    .replace(/\b[0-9a-f]{8,}\b/giu, "<hash>")
    .trim()
    .toLowerCase()
    .slice(0, 1_000);
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: normalizedText,
        cwd: observation.source.cwd,
        signals: observation.signals,
      }),
    )
    .digest("hex");
}

function candidateTitle(observation: ReflectionObservation): string {
  const text = observation.excerpt.replace(/[.:;。；]+$/u, "");
  return text.length <= 90 ? text : `${text.slice(0, 89).trimEnd()}…`;
}

function candidateReason(observation: ReflectionObservation): string {
  const parts = [`Detected ${observation.signals.join(", ")} signal(s)`];
  if (observation.kind === "custom_message") parts.push("from Spark/Pi extension context");
  if (observation.kind === "summary_hint") parts.push("from a low-authority summary hint");
  return `${parts.join(" ")} with source provenance.`;
}

function candidateSuggestedNextAction(observation: ReflectionObservation): string {
  if (observation.signals.includes("blocker"))
    return "Review the source context and decide whether this blocker still exists before planning work.";
  if (observation.signals.includes("todo_like"))
    return "Review the source context and either dismiss it or promote it into an explicit task plan.";
  return "Review the source context before taking any project/task mutation action.";
}

function candidateConfidence(
  signals: readonly ReflectionSignalKind[],
): ReflectionCandidateConfidence {
  if (signals.includes("blocker") && signals.includes("unfinished_intent")) return "high";
  if (signals.includes("todo_like") || signals.includes("task_intent")) return "medium";
  return "low";
}

function sourceRefFromObservation(
  observation: ReflectionObservation,
): ReflectionCandidateSourceRef {
  return {
    file: observation.source.file,
    line: observation.source.line,
    kind: observation.kind,
    entryId: observation.source.entryId,
    timestamp: observation.source.timestamp,
    sessionId: observation.source.sessionId,
    cwd: observation.source.cwd,
    customType: observation.source.customType,
  };
}

function compareCandidates(left: ReflectionCandidate, right: ReflectionCandidate): number {
  return (
    confidenceRank(right.confidence) - confidenceRank(left.confidence) ||
    right.occurrenceCount - left.occurrenceCount ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function confidenceRank(confidence: ReflectionCandidateConfidence): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function maxConfidence(
  left: ReflectionCandidateConfidence,
  right: ReflectionCandidateConfidence,
): ReflectionCandidateConfidence {
  return confidenceRank(right) > confidenceRank(left) ? right : left;
}

function sourceRefsEqual(
  left: ReflectionCandidateSourceRef,
  right: ReflectionCandidateSourceRef,
): boolean {
  return (
    left.file === right.file &&
    left.line === right.line &&
    left.entryId === right.entryId &&
    left.kind === right.kind
  );
}

function formatSourceRef(sourceRef: ReflectionCandidateSourceRef | undefined): string {
  if (!sourceRef) return "unknown";
  const kind = sourceRef.kind ? ` (${sourceRef.kind})` : "";
  return `${sourceRef.file}:${sourceRef.line}${kind}`;
}

function normalizeReflectionCandidateStore(input: unknown): ReflectionCandidateStore {
  if (!input || typeof input !== "object") return emptyReflectionCandidateStore();
  const record = input as { version?: unknown; updatedAt?: unknown; candidates?: unknown };
  if (record.version !== REFLECTION_CANDIDATE_STORE_VERSION || !Array.isArray(record.candidates))
    return emptyReflectionCandidateStore();
  return {
    version: REFLECTION_CANDIDATE_STORE_VERSION,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    candidates: record.candidates.flatMap(normalizeReflectionCandidate),
  };
}

function normalizeReflectionCandidate(input: unknown): ReflectionCandidate[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Partial<ReflectionCandidate>;
  if (
    typeof record.id !== "string" ||
    typeof record.fingerprint !== "string" ||
    !isCandidateStatus(record.status) ||
    !isCandidateConfidence(record.confidence) ||
    typeof record.title !== "string" ||
    typeof record.reason !== "string" ||
    typeof record.suggestedNextAction !== "string" ||
    typeof record.excerpt !== "string" ||
    !Array.isArray(record.signals) ||
    !Array.isArray(record.sourceRefs) ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    typeof record.lastSeenAt !== "string" ||
    typeof record.occurrenceCount !== "number"
  )
    return [];
  return [
    {
      id: record.id,
      fingerprint: record.fingerprint,
      status: record.status,
      title: record.title,
      reason: record.reason,
      suggestedNextAction: record.suggestedNextAction,
      confidence: record.confidence,
      signals: record.signals.filter(isSignalKind),
      excerpt: record.excerpt,
      sourceRefs: record.sourceRefs.filter(isSourceRef),
      occurrenceCount: record.occurrenceCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastSeenAt: record.lastSeenAt,
      dispositionNote:
        typeof record.dispositionNote === "string" ? record.dispositionNote : undefined,
    },
  ];
}

function isCandidateStatus(value: unknown): value is ReflectionCandidateStatus {
  return value === "open" || value === "ignored" || value === "resolved" || value === "exported";
}

function isCandidateConfidence(value: unknown): value is ReflectionCandidateConfidence {
  return value === "low" || value === "medium" || value === "high";
}

function isSignalKind(value: unknown): value is ReflectionSignalKind {
  return (
    value === "todo_like" ||
    value === "blocker" ||
    value === "unfinished_intent" ||
    value === "task_intent"
  );
}

function isSourceRef(value: unknown): value is ReflectionCandidateSourceRef {
  if (!value || typeof value !== "object") return false;
  const record = value as ReflectionCandidateSourceRef;
  return typeof record.file === "string" && typeof record.line === "number";
}
