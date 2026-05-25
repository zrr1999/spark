import {
  type Artifact,
  type ArtifactFormat,
  type ArtifactKind,
  type ArtifactLink,
  type ArtifactRef,
  type JsonValue,
  type Provenance,
  isRef,
  newRef,
  nowIso,
  stableId,
} from "spark-core";
import { defaultArtifactStore } from "spark-artifacts";

export type LearningCategory = "pattern" | "gotcha" | "decision" | "workflow" | "tool" | "project";
export type LearningScope = "global" | "project" | "thread" | "task";
export type LearningStatus = "candidate" | "active" | "stale" | "superseded" | "rejected";

export interface LearningRecord extends Record<string, JsonValue> {
  id: string;
  title: string;
  statement: string;
  category: LearningCategory;
  scope: LearningScope;
  status: LearningStatus;
  applicability: string;
  nonApplicability: string | null;
  rationale: string | null;
  evidenceRefs: string[];
  sourcePaths: string[];
  sourceHash: string | null;
  sourceContent: string | null;
  dependsOn: string[];
  supersedes: string[];
  supersededBy: string[];
  contradictedBy: string[];
  tags: string[];
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
  staleReason: string | null;
  staleAt: string | null;
  rejectedReason: string | null;
  rejectedAt: string | null;
}

export interface LearningRecordInput {
  id?: string;
  title: string;
  statement: string;
  category?: LearningCategory;
  scope?: LearningScope;
  status?: LearningStatus;
  applicability?: string;
  nonApplicability?: string;
  rationale?: string;
  evidenceRefs?: string[];
  sourcePaths?: string[];
  sourceHash?: string;
  sourceContent?: string;
  dependsOn?: string[];
  supersedes?: string[];
  supersededBy?: string[];
  contradictedBy?: string[];
  tags?: string[];
  confidence?: number;
}

export interface LearningListFilter {
  status?: LearningStatus | LearningStatus[];
  scope?: LearningScope;
  category?: LearningCategory;
  tag?: string;
  includeCandidates?: boolean;
  includeInactive?: boolean;
}

export interface LearningSearchFilter extends LearningListFilter {
  query: string;
  limit?: number;
}

export interface LearningSearchResult {
  ref: ArtifactRef;
  record: LearningRecord;
  score: number;
  snippet: string;
  evidenceSummary: string;
}

export interface LearningStoreOptions {
  artifactStore: LearningArtifactStore;
}

export interface LearningArtifactStore {
  put<T extends JsonValue | string>(input: LearningPutArtifactInput<T>): Promise<Artifact<T>>;
  get<T extends JsonValue | string = JsonValue | string>(ref: ArtifactRef): Promise<Artifact<T>>;
  tryGet<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef,
  ): Promise<Artifact<T> | null>;
  list(filter?: { kind?: ArtifactKind }): Promise<Artifact[]>;
}

export interface LearningPutArtifactInput<T extends JsonValue | string = JsonValue | string> {
  kind: ArtifactKind;
  title: string;
  format: ArtifactFormat;
  body: T;
  provenance: Provenance;
  links?: Omit<ArtifactLink, "from">[];
  ref?: ArtifactRef;
}

const DEFAULT_ACTIVE_STATUSES: LearningStatus[] = ["active"];
const LEARNING_STATUSES: LearningStatus[] = [
  "candidate",
  "active",
  "stale",
  "superseded",
  "rejected",
];
const LEARNING_CATEGORIES: LearningCategory[] = [
  "pattern",
  "gotcha",
  "decision",
  "workflow",
  "tool",
  "project",
];
const LEARNING_SCOPES: LearningScope[] = ["global", "project", "thread", "task"];

export class LearningStore {
  readonly artifactStore: LearningArtifactStore;

  constructor(options: LearningStoreOptions) {
    this.artifactStore = options.artifactStore;
  }

  async record(input: LearningRecordInput): Promise<Artifact<LearningRecord>> {
    const now = nowIso();
    const id = input.id ?? stableLearningId(input);
    const ref = newRef("artifact", id);
    const existing = await this.artifactStore.tryGet<LearningRecord>(ref);
    const record: LearningRecord = normalizeLearningRecord(input, {
      id,
      createdAt: existing?.body.createdAt ?? now,
      updatedAt: now,
    });
    validateLearningRecord(record);
    return this.artifactStore.put({
      ref,
      kind: artifactKindForLearningStatus(record.status),
      title: record.title,
      format: "json",
      body: record,
      provenance: {
        producer: "spark",
        note: "spark-learnings record",
      },
      links: relationLinks(record),
    });
  }

  async restore(record: LearningRecord): Promise<Artifact<LearningRecord>> {
    validateLearningRecord(record);
    const ref = newRef("artifact", record.id);
    return this.artifactStore.put({
      ref,
      kind: artifactKindForLearningStatus(record.status),
      title: record.title,
      format: "json",
      body: record,
      provenance: {
        producer: "spark",
        note: "spark-learnings import restore",
      },
      links: relationLinks(record),
    });
  }

  async get(refOrId: string): Promise<Artifact<LearningRecord>> {
    const artifact = await this.artifactStore.get<LearningRecord>(learningRef(refOrId));
    validateLearningRecord(artifact.body);
    return artifact;
  }

  async list(filter: LearningListFilter = {}): Promise<Array<Artifact<LearningRecord>>> {
    const artifacts = await hydrateLearningArtifacts(
      [
        ...(await this.artifactStore.list({ kind: "learning" })),
        ...(await this.artifactStore.list({ kind: "learning-candidate" })),
      ],
      this.artifactStore,
    );
    return artifacts
      .filter((artifact) => isLearningRecord(artifact.body))
      .filter((artifact) => matchesLearningFilter(artifact.body, filter))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async search(filter: LearningSearchFilter): Promise<LearningSearchResult[]> {
    const query = filter.query.trim();
    const artifacts = await this.list(filter);
    const results = artifacts
      .map((artifact) => scoreLearning(artifact, query))
      .filter((result) => result.score > 0 || !query)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return right.record.updatedAt.localeCompare(left.record.updatedAt);
      });
    return results.slice(0, filter.limit ?? 10);
  }

  async activate(refOrId: string): Promise<Artifact<LearningRecord>> {
    return this.patchStatus(refOrId, { status: "active" });
  }

  async markStale(refOrId: string, reason: string): Promise<Artifact<LearningRecord>> {
    const staleAt = nowIso();
    return this.patchStatus(refOrId, {
      status: "stale",
      staleReason: requireNonEmpty(reason, "stale reason"),
      staleAt,
    });
  }

  async rejectCandidate(refOrId: string, reason: string): Promise<Artifact<LearningRecord>> {
    const rejectedAt = nowIso();
    return this.patchStatus(refOrId, {
      status: "rejected",
      rejectedReason: requireNonEmpty(reason, "rejected reason"),
      rejectedAt,
    });
  }

  async markSuperseded(
    refOrId: string,
    supersededBy: string | string[],
    reason?: string,
  ): Promise<Artifact<LearningRecord>> {
    const replacementRefs = Array.isArray(supersededBy) ? supersededBy : [supersededBy];
    const existing = await this.get(refOrId);
    const record = {
      ...existing.body,
      status: "superseded" as const,
      supersededBy: uniqueStrings([...existing.body.supersededBy, ...replacementRefs]),
      staleReason: reason?.trim() || existing.body.staleReason,
      updatedAt: nowIso(),
    };
    return this.writeUpdatedRecord(existing.ref, record);
  }

  private async patchStatus(
    refOrId: string,
    patch: Partial<
      Pick<LearningRecord, "status" | "staleReason" | "staleAt" | "rejectedReason" | "rejectedAt">
    >,
  ): Promise<Artifact<LearningRecord>> {
    const existing = await this.get(refOrId);
    const record = { ...existing.body, ...patch, updatedAt: nowIso() };
    return this.writeUpdatedRecord(existing.ref, record);
  }

  private async writeUpdatedRecord(
    ref: ArtifactRef,
    record: LearningRecord,
  ): Promise<Artifact<LearningRecord>> {
    validateLearningRecord(record);
    return this.artifactStore.put({
      ref,
      kind: artifactKindForLearningStatus(record.status),
      title: record.title,
      format: "json",
      body: record,
      provenance: {
        producer: "spark",
        note: "spark-learnings status update",
      },
      links: relationLinks(record),
    });
  }
}

export function defaultLearningStore(cwd: string): LearningStore {
  return new LearningStore({ artifactStore: defaultArtifactStore(cwd) });
}

async function hydrateLearningArtifacts(
  artifacts: Artifact[],
  store: LearningArtifactStore,
): Promise<Array<Artifact<LearningRecord>>> {
  const hydrated: Array<Artifact<LearningRecord>> = [];
  for (const artifact of artifacts) {
    if (artifact.bodyTruncated) hydrated.push(await store.get<LearningRecord>(artifact.ref));
    else hydrated.push(artifact as Artifact<LearningRecord>);
  }
  return hydrated;
}

export function validateLearningRecord(record: LearningRecord): void {
  requireNonEmpty(record.id, "learning id");
  requireNonEmpty(record.title, "learning title");
  requireNonEmpty(record.statement, "learning statement");
  if (!LEARNING_CATEGORIES.includes(record.category)) {
    throw new Error(`invalid learning category: ${record.category}`);
  }
  if (!LEARNING_SCOPES.includes(record.scope)) {
    throw new Error(`invalid learning scope: ${record.scope}`);
  }
  if (!LEARNING_STATUSES.includes(record.status)) {
    throw new Error(`invalid learning status: ${record.status}`);
  }
  assertStringArray(record.evidenceRefs, "learning evidenceRefs");
  assertStringArray(record.sourcePaths, "learning sourcePaths");
  assertStringArray(record.dependsOn, "learning dependsOn");
  assertStringArray(record.supersedes, "learning supersedes");
  assertStringArray(record.supersededBy, "learning supersededBy");
  assertStringArray(record.contradictedBy, "learning contradictedBy");
  assertStringArray(record.tags, "learning tags");
  if (record.confidence !== null && (record.confidence < 0 || record.confidence > 1)) {
    throw new Error("learning confidence must be between 0 and 1");
  }
}

function normalizeLearningRecord(
  input: LearningRecordInput,
  generated: Pick<LearningRecord, "id" | "createdAt" | "updatedAt">,
): LearningRecord {
  return {
    ...generated,
    title: input.title.trim(),
    statement: input.statement.trim(),
    category: input.category ?? "pattern",
    scope: input.scope ?? "project",
    status: input.status ?? "active",
    applicability: input.applicability?.trim() ?? "",
    nonApplicability: emptyToNull(input.nonApplicability),
    rationale: emptyToNull(input.rationale),
    evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
    sourcePaths: uniqueStrings(input.sourcePaths ?? []),
    sourceHash: emptyToNull(input.sourceHash),
    sourceContent: emptyToNull(input.sourceContent),
    dependsOn: uniqueStrings(input.dependsOn ?? []),
    supersedes: uniqueStrings(input.supersedes ?? []),
    supersededBy: uniqueStrings(input.supersededBy ?? []),
    contradictedBy: uniqueStrings(input.contradictedBy ?? []),
    tags: uniqueStrings(input.tags ?? []),
    confidence: input.confidence ?? null,
    staleReason: null,
    staleAt: null,
    rejectedReason: null,
    rejectedAt: null,
  };
}

function artifactKindForLearningStatus(status: LearningStatus): "learning" | "learning-candidate" {
  return status === "candidate" || status === "rejected" ? "learning-candidate" : "learning";
}

function stableLearningId(input: LearningRecordInput): string {
  const sourceKey = input.sourceHash
    ? `${input.sourcePaths?.join("\n") ?? ""}\n${input.sourceHash}`
    : `${input.scope ?? "project"}\n${input.category ?? "pattern"}\n${input.title}\n${input.statement}`;
  return `learning-${stableId(sourceKey)}`;
}

function learningRef(refOrId: string): ArtifactRef {
  return isRef(refOrId, "artifact") ? refOrId : newRef("artifact", refOrId);
}

function matchesLearningFilter(record: LearningRecord, filter: LearningListFilter): boolean {
  const statuses = filter.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : filter.includeInactive
      ? LEARNING_STATUSES
      : filter.includeCandidates
        ? ["active", "candidate"]
        : DEFAULT_ACTIVE_STATUSES;
  if (!statuses.includes(record.status)) return false;
  if (filter.scope && record.scope !== filter.scope) return false;
  if (filter.category && record.category !== filter.category) return false;
  if (filter.tag && !record.tags.includes(filter.tag)) return false;
  return true;
}

function scoreLearning(artifact: Artifact<LearningRecord>, query: string): LearningSearchResult {
  const record = artifact.body;
  const haystack = searchableLearningText(record);
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  let score = 0;
  for (const term of terms) {
    if (record.title.toLowerCase().includes(term)) score += 5;
    if (record.statement.toLowerCase().includes(term)) score += 3;
    if (record.tags.some((tag: string) => tag.toLowerCase().includes(term))) score += 2;
    if (haystack.includes(term)) score += 1;
  }
  if (!terms.length) score = 1;
  score += record.confidence ?? 0;
  if (record.status === "active") score += 0.25;
  return {
    ref: artifact.ref,
    record,
    score,
    snippet: learningSnippet(record, terms),
    evidenceSummary: summarizeEvidence(record.evidenceRefs),
  };
}

function searchableLearningText(record: LearningRecord): string {
  return [
    record.title,
    record.statement,
    record.applicability,
    record.nonApplicability,
    record.rationale,
    record.sourceContent,
    record.category,
    record.scope,
    record.status,
    ...record.tags,
    ...record.sourcePaths,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function learningSnippet(record: LearningRecord, terms: string[]): string {
  const text = [record.statement, record.applicability, record.rationale].filter(Boolean).join(" ");
  if (!terms.length) return truncate(text, 180);
  const lower = text.toLowerCase();
  const index = terms.map((term) => lower.indexOf(term)).find((item) => item >= 0) ?? 0;
  const start = Math.max(0, index - 60);
  return truncate(text.slice(start), 180);
}

function summarizeEvidence(evidenceRefs: string[]): string {
  if (!evidenceRefs.length) return "no evidence refs";
  if (evidenceRefs.length === 1) return evidenceRefs[0] ?? "no evidence refs";
  return `${evidenceRefs[0]} +${evidenceRefs.length - 1} more`;
}

function relationLinks(record: LearningRecord): Omit<ArtifactLink, "from">[] {
  return evidenceArtifactRefs(record.evidenceRefs).map((artifactRef) => ({
    to: artifactRef,
    relation: "derived-from" as const,
  }));
}

function evidenceArtifactRefs(evidenceRefs: string[]): ArtifactRef[] {
  return evidenceRefs.filter((ref): ref is ArtifactRef => isRef(ref, "artifact"));
}

function isLearningRecord(value: JsonValue | string): value is LearningRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "status" in value;
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function assertStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 1)}…`;
}
