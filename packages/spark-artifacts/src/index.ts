import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeJsonFileAtomic, writeTextFileAtomic } from "@zendev-lab/spark-core";
import { isProductArtifactKind } from "./product/types.ts";

export { writeJsonFileAtomic, writeTextFileAtomic };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Legacy generic-store ref union. Public evidence and product APIs use narrower refs. */
export type ArtifactRef = (`artifact:${string}` | `evidence:${string}`) & {
  readonly __kind?: "artifact" | "evidence";
};
/** Canonical identity for all new evidence writes. */
export type EvidenceRef = `evidence:${string}` & { readonly __kind?: "evidence" };
export type ProjectRef = `proj:${string}` & { readonly __kind?: "proj" };
export type TaskRef = `task:${string}` & { readonly __kind?: "task" };
export type RoleRef = `role:${string}` & { readonly __kind?: "role" };
export type RunRef = `run:${string}` & { readonly __kind?: "run" };
export type ReviewRef = `review:${string}` & { readonly __kind?: "review" };
export type AskRef = `ask:${string}` & { readonly __kind?: "ask" };
export type CueJobRef = `cue-job:${string}` & { readonly __kind?: "cue-job" };
export type LinkableRef =
  | ArtifactRef
  | EvidenceRef
  | ProjectRef
  | TaskRef
  | RoleRef
  | RunRef
  | ReviewRef
  | AskRef
  | CueJobRef;

export type ArtifactProducer = "spark" | "role" | "task" | "review" | "ask" | "cue" | "user";

export const ARTIFACT_PRODUCERS = [
  "spark",
  "role",
  "task",
  "review",
  "ask",
  "cue",
  "user",
] as const satisfies readonly ArtifactProducer[];

export interface Provenance {
  producer: ArtifactProducer;
  runRef?: RunRef;
  projectRef?: ProjectRef;
  taskRef?: TaskRef;
  roleRef?: RoleRef;
  parentEvidenceRefs?: EvidenceRef[];
  /** @deprecated Legacy evidence identity only. */
  parentArtifactRefs?: ArtifactRef[];
  note?: string;
}

/**
 * Agent-internal evidence kinds (not Cockpit/user content). Product artifacts are
 * issue|pr|preview in `./product/`.
 *
 * Prefer compact JSON `record` notes. Keep `trace` for prunable raw output.
 * `knowledge` is owned by the learning capability; `document` is rare long prose.
 */
export type ArtifactKind = "document" | "record" | "trace" | "knowledge";
/** @deprecated Prefer EvidenceKind — ArtifactKind remains for compatibility. */
export type EvidenceKind = ArtifactKind;

export const ARTIFACT_KINDS = [
  "document",
  "record",
  "trace",
  "knowledge",
] as const satisfies readonly ArtifactKind[];

export type ArtifactFormat = "markdown" | "json" | "text";

export const ARTIFACT_FORMATS = [
  "markdown",
  "json",
  "text",
] as const satisfies readonly ArtifactFormat[];

export type ArtifactCurationStatus = "raw" | "candidate" | "curated" | "archived" | "superseded";

export const ARTIFACT_CURATION_STATUSES = [
  "raw",
  "candidate",
  "curated",
  "archived",
  "superseded",
] as const satisfies readonly ArtifactCurationStatus[];

export type ArtifactRetention = "ephemeral" | "task" | "project" | "durable";

export const ARTIFACT_RETENTIONS = [
  "ephemeral",
  "task",
  "project",
  "durable",
] as const satisfies readonly ArtifactRetention[];

export interface ArtifactCuration {
  /** Lifecycle for keeping only the useful artifact essence visible by default. */
  status: ArtifactCurationStatus;
  /** Intended retention horizon; storage owners may use it for sweeps. */
  retention?: ArtifactRetention;
  /** Human-readable justification for promotion, archive, or supersession. */
  reason?: string;
  /** Raw/candidate artifacts folded into this curated artifact. */
  promotedFrom?: ArtifactRef[];
  /** Better artifact(s) that replace this one. */
  supersededBy?: ArtifactRef[];
  /** Essence/summary artifact that compacted this artifact. */
  compactedInto?: ArtifactRef;
  /** Optional expiry for raw/ephemeral artifacts. */
  expiresAt?: string;
}

export interface ArtifactTranscriptRetention {
  schemaVersion: 1;
  strategy: "role-run-compact-summary-tail";
  candidateReason: string;
  originalBlobPath?: string;
  originalHash?: string;
  originalBodySize?: number;
  originalMetadataBytes?: number;
  replacementSummary: string;
  transcriptTail?: {
    bytes: number;
    tailBytes: number;
    truncated: boolean;
    source: "serialized-artifact-body-tail";
    tail: string;
  };
  exportPath?: string;
  compactedAt: string;
  fullTranscriptDeletedAt?: string;
}

export interface Artifact<T extends JsonValue | string = JsonValue | string> {
  ref: ArtifactRef;
  kind: ArtifactKind;
  title: string;
  format: ArtifactFormat;
  body: T;
  /** Bounded serialized body preview when metadata body is stored out-of-line. */
  bodyPreview?: string;
  /** Serialized body byte size when known. */
  bodySize?: number;
  /** True when `body` contains only a preview and `blobPath` is the body source. */
  bodyTruncated?: boolean;
  /** Curation lifecycle used to keep raw evidence from overwhelming default views/search. */
  curation?: ArtifactCuration;
  /** Audit metadata for historical transcript blob replacement. */
  transcriptRetention?: ArtifactTranscriptRetention;
  hash?: string;
  blobPath?: string;
  links: ArtifactLink[];
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactLink {
  from: ArtifactRef;
  to: LinkableRef;
  relation: "parent" | "input" | "output" | "review-of" | "answer-to" | "trace-of" | "derived-from";
}

export const ARTIFACT_LINK_RELATIONS = [
  "parent",
  "input",
  "output",
  "review-of",
  "answer-to",
  "trace-of",
  "derived-from",
] as const satisfies readonly ArtifactLink["relation"][];

export interface PutArtifactInput<T extends JsonValue | string = JsonValue | string> {
  kind: ArtifactKind;
  title: string;
  format: ArtifactFormat;
  body: T;
  provenance: Provenance;
  links?: Omit<ArtifactLink, "from">[];
  curation?: ArtifactCuration;
  ref?: ArtifactRef;
}

export interface ArtifactStoreOptions {
  rootDir: string;
  /** Optional legacy evidence root (typically `.spark/artifacts`) read as fallback. */
  legacyRootDir?: string;
  /** Identity emitted by new writes. Evidence stores must use `evidence:`. */
  refKind?: "artifact" | "evidence";
  inlineBodyThresholdBytes?: number;
  bodyPreviewChars?: number;
}

export interface ArtifactQuery {
  kind?: ArtifactKind;
  projectRef?: string;
  taskRef?: string;
  roleRef?: string;
  producer?: Provenance["producer"];
  linkedTo?: string;
  curationStatus?: ArtifactCurationStatus | ArtifactCurationStatus[];
  retention?: ArtifactRetention;
  /** Defaults are caller-owned; when false, artifacts explicitly marked raw are hidden. */
  includeRaw?: boolean;
  /** Defaults are caller-owned; when false, archived/superseded artifacts are hidden. */
  includeArchived?: boolean;
}

export interface ArtifactMetadataCompactionOptions {
  /** Defaults to true so callers must opt in before rewriting metadata files. */
  dryRun?: boolean;
  inlineBodyThresholdBytes?: number;
  bodyPreviewChars?: number;
}

export interface ArtifactMetadataCompactionCandidate {
  ref: ArtifactRef;
  path: string;
  blobPath: string;
  metadataBytesBefore: number;
  metadataBytesAfter: number;
  bodyBytes: number;
  reclaimableBytes: number;
}

export interface ArtifactMetadataCompactionSkipped {
  path: string;
  reason:
    | "already_compacted"
    | "invalid_json"
    | "invalid_metadata"
    | "invalid_blob_path"
    | "missing_blob_path"
    | "missing_blob"
    | "hash_mismatch"
    | "small_body";
  message?: string;
}

export interface ArtifactMetadataCompactionResult {
  dryRun: boolean;
  scanned: number;
  compacted: number;
  skipped: ArtifactMetadataCompactionSkipped[];
  candidates: ArtifactMetadataCompactionCandidate[];
  metadataBytesBefore: number;
  metadataBytesAfter: number;
  reclaimableBytes: number;
}

export interface ArtifactListDiagnostic {
  filePath: string;
  message: string;
  reason?: string;
}

export interface ArtifactListWithDiagnosticsResult {
  artifacts: Artifact[];
  diagnostics: ArtifactListDiagnostic[];
}

type ArtifactStoreFormatReason = "invalid_json" | "invalid_metadata";

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

export class ArtifactStoreFormatError extends Error {
  readonly filePath: string;
  readonly reason: ArtifactStoreFormatReason;

  constructor(
    filePath: string,
    message: string,
    reason: ArtifactStoreFormatReason = "invalid_metadata",
  ) {
    super(`${filePath}: ${message}`);
    this.name = "ArtifactStoreFormatError";
    this.filePath = filePath;
    this.reason = reason;
  }
}

const DEFAULT_INLINE_BODY_THRESHOLD_BYTES = 64 * 1024;
const DEFAULT_BODY_PREVIEW_CHARS = 4_000;

const LEGACY_ARTIFACT_KIND_MAP: Readonly<Record<string, ArtifactKind>> = {
  "agent-plan": "document",
  "ask-answer": "record",
  "cue-output": "trace",
  review: "record",
  "role-plan": "document",
  "run-trace": "trace",
  "spark-md": "document",
  validation: "record",
  verification: "record",
};

export function canonicalArtifactKindForPersistedKind(value: unknown): ArtifactKind | undefined {
  if (typeof value !== "string") return undefined;
  if (isArtifactKind(value)) return value;
  return LEGACY_ARTIFACT_KIND_MAP[value];
}

export class ArtifactStore {
  readonly rootDir: string;
  readonly legacyRootDir?: string;
  readonly refKind: "artifact" | "evidence";
  readonly blobDir: string;
  readonly inlineBodyThresholdBytes: number;
  readonly bodyPreviewChars: number;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.legacyRootDir = options.legacyRootDir;
    this.refKind = options.refKind ?? "artifact";
    this.blobDir = join(options.rootDir, "blobs");
    this.inlineBodyThresholdBytes =
      options.inlineBodyThresholdBytes ?? DEFAULT_INLINE_BODY_THRESHOLD_BYTES;
    this.bodyPreviewChars = options.bodyPreviewChars ?? DEFAULT_BODY_PREVIEW_CHARS;
  }

  async put<T extends JsonValue | string>(input: PutArtifactInput<T>): Promise<Artifact<T>> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.blobDir, { recursive: true });
    const now = nowIso();
    const ref = input.ref ?? (this.refKind === "evidence" ? newEvidenceRef() : newArtifactRef());
    const existing = input.ref ? await this.tryGet<T>(input.ref) : null;
    const parentLinks: ArtifactLink[] = [
      ...(input.provenance.parentEvidenceRefs ?? []),
      ...(input.provenance.parentArtifactRefs ?? []),
    ].map((parent) => ({
      from: ref,
      to: parent,
      relation: "parent",
    }));
    const artifact: Artifact<T> = {
      ref,
      kind: input.kind,
      title: input.title,
      format: input.format,
      body: input.body,
      links: [...parentLinks, ...(input.links ?? []).map((link) => ({ ...link, from: ref }))],
      provenance: input.provenance,
      curation:
        input.curation ??
        existing?.curation ??
        defaultArtifactCuration(input.kind, input.provenance),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    validateArtifact(artifact);

    const serializedBody = serializeArtifactBody(input.format, input.body);
    const hash = contentHash(serializedBody);
    const blobPath = join("blobs", `${hash}.${extensionForFormat(input.format)}`);
    const storedArtifact: Artifact<T> = {
      ...artifact,
      body: metadataBodyFor(input.body, serializedBody, {
        thresholdBytes: this.inlineBodyThresholdBytes,
        previewChars: this.bodyPreviewChars,
      }),
      hash,
      blobPath,
    };
    addBodyCompactionMetadata(storedArtifact, serializedBody, {
      thresholdBytes: this.inlineBodyThresholdBytes,
      previewChars: this.bodyPreviewChars,
    });
    validateArtifact(storedArtifact);
    await writeTextFileAtomic(join(this.rootDir, blobPath), serializedBody);
    await writeJsonFileAtomic(this.pathFor(ref), storedArtifact);
    return { ...storedArtifact, body: input.body };
  }

  async update<T extends JsonValue | string>(
    ref: ArtifactRef | EvidenceRef,
    patch: Partial<Omit<PutArtifactInput<T>, "ref">>,
  ): Promise<Artifact<T>> {
    const existing = await this.get<T>(ref);
    return this.put<T>({
      ref: asArtifactRef(ref),
      kind: patch.kind ?? existing.kind,
      title: patch.title ?? existing.title,
      format: patch.format ?? existing.format,
      body: patch.body ?? existing.body,
      provenance: patch.provenance ?? existing.provenance,
      links: patch.links ?? existing.links.map(({ from: _from, ...link }) => link),
      curation: patch.curation ?? existing.curation,
    });
  }

  async get<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef | EvidenceRef,
  ): Promise<Artifact<T>> {
    const artifact = await this.readMetadata<T>(ref);
    if (artifact.bodyTruncated && artifact.blobPath) {
      const body = await this.getBody(ref);
      return {
        ...artifact,
        body: parseArtifactBody(artifact.format, body) as T,
      };
    }
    return artifact;
  }

  async getBody(ref: ArtifactRef | EvidenceRef): Promise<string> {
    const artifact = await this.readMetadata(ref);
    if (artifact.blobPath) {
      for (const root of this.evidenceRoots()) {
        const blobPath = resolveArtifactBlobPath(root, artifact.blobPath);
        if (!blobPath) continue;
        try {
          return await readFile(blobPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      throw new Error(`artifact blob path escapes artifact store: ${artifact.ref}`);
    }
    return serializeArtifactBody(artifact.format, artifact.body);
  }

  async tryGet<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef | EvidenceRef,
  ): Promise<Artifact<T> | null> {
    try {
      return await this.get<T>(ref);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(filter: ArtifactQuery = {}): Promise<Artifact[]> {
    const { artifacts, diagnostics } = await this.listWithDiagnostics(filter);
    const fatal = diagnostics.find((diagnostic) => diagnostic.reason !== undefined);
    if (fatal) {
      throw new ArtifactStoreFormatError(
        fatal.filePath,
        fatal.message.replace(`${fatal.filePath}: `, ""),
        (fatal.reason as "invalid_json" | "invalid_metadata") ?? "invalid_metadata",
      );
    }
    if (diagnostics.length > 0) {
      throw new ArtifactStoreFormatError(
        diagnostics[0]!.filePath,
        diagnostics[0]!.message.replace(`${diagnostics[0]!.filePath}: `, ""),
        "invalid_metadata",
      );
    }
    return artifacts;
  }

  async listWithDiagnostics(
    filter: ArtifactQuery = {},
  ): Promise<ArtifactListWithDiagnosticsResult> {
    await mkdir(this.rootDir, { recursive: true });
    const roots = this.evidenceRoots();
    const artifacts: Artifact[] = [];
    const diagnostics: ArtifactListDiagnostic[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const filePath = join(root, entry.name);
        let artifact: Artifact;
        try {
          artifact = this.normalizeStoredIdentity(await readArtifactMetadataFile(filePath));
        } catch (error) {
          // Product issue/pr/preview files may share a legacy root; skip quietly.
          if (isSkippableNonEvidenceMetadata(error)) continue;
          diagnostics.push(artifactListDiagnostic(filePath, error));
          continue;
        }
        if (seen.has(artifact.ref)) continue;
        seen.add(artifact.ref);
        if (!matchesQuery(artifact, filter)) continue;
        artifacts.push(artifact);
      }
    }
    return {
      artifacts: artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      diagnostics,
    };
  }

  private evidenceRoots(): string[] {
    const roots = [this.rootDir];
    if (this.legacyRootDir && this.legacyRootDir !== this.rootDir) {
      roots.push(this.legacyRootDir);
    }
    return roots;
  }

  async linksTo(targetRef: string): Promise<ArtifactLink[]> {
    const artifacts = await this.list({ linkedTo: targetRef });
    return artifacts.flatMap((artifact) => artifact.links.filter((link) => link.to === targetRef));
  }

  async diff(
    left: ArtifactRef,
    right: ArtifactRef,
  ): Promise<{ same: boolean; leftHash?: string; rightHash?: string }> {
    const leftArtifact = await this.get(left);
    const rightArtifact = await this.get(right);
    return {
      same: leftArtifact.hash === rightArtifact.hash,
      leftHash: leftArtifact.hash,
      rightHash: rightArtifact.hash,
    };
  }

  async compactMetadata(
    options: ArtifactMetadataCompactionOptions = {},
  ): Promise<ArtifactMetadataCompactionResult> {
    return compactArtifactMetadata(this.rootDir, {
      inlineBodyThresholdBytes: options.inlineBodyThresholdBytes ?? this.inlineBodyThresholdBytes,
      bodyPreviewChars: options.bodyPreviewChars ?? this.bodyPreviewChars,
      dryRun: options.dryRun,
    });
  }

  pathFor(ref: ArtifactRef | EvidenceRef): string {
    return join(this.rootDir, `${refId(ref)}.json`);
  }

  private async readMetadata<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef | EvidenceRef,
  ): Promise<Artifact<T>> {
    try {
      return this.normalizeStoredIdentity(
        (await readArtifactMetadataFile(this.pathFor(ref))) as Artifact<T>,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !this.legacyRootDir) throw error;
      const legacyPath = join(this.legacyRootDir, `${refId(ref)}.json`);
      return this.normalizeStoredIdentity(
        (await readArtifactMetadataFile(legacyPath)) as Artifact<T>,
      );
    }
  }

  private normalizeStoredIdentity<T extends JsonValue | string>(
    artifact: Artifact<T>,
  ): Artifact<T> {
    if (this.refKind !== "evidence" || !artifact.ref.startsWith("artifact:")) return artifact;
    const ref = `evidence:${refId(artifact.ref)}` as EvidenceRef;
    return {
      ...artifact,
      ref,
      links: artifact.links.map((link) => ({ ...link, from: ref })),
    };
  }
}

function isSkippableNonEvidenceMetadata(error: unknown): boolean {
  if (!(error instanceof ArtifactStoreFormatError)) return false;
  return /product (?:issue|pr|preview) skipped/u.test(error.message);
}

function artifactListDiagnostic(filePath: string, error: unknown): ArtifactListDiagnostic {
  if (error instanceof ArtifactStoreFormatError) {
    return { filePath: error.filePath, reason: error.reason, message: error.message };
  }
  return { filePath, message: unknownErrorMessage(error) };
}

/**
 * Internal evidence store used by the `evidence` tool. New writes go to
 * `.spark/evidence`; legacy evidence under `.spark/artifacts` remains readable.
 * Product issue/pr/preview also live under `.spark/artifacts` (kind-filtered).
 */
export function defaultEvidenceStore(cwd: string): EvidenceStore {
  return new EvidenceStore({
    rootDir: join(cwd, ".spark", "evidence"),
    legacyRootDir: join(cwd, ".spark", "artifacts"),
  });
}

/**
 * Legacy generic store under `.spark/artifacts`. Active hosts must use
 * `defaultEvidenceStore` or `defaultProductArtifactStore`; this remains only for
 * migration and compatibility tests.
 */
export function defaultArtifactStore(cwd: string): ArtifactStore {
  return new ArtifactStore({ rootDir: join(cwd, ".spark", "artifacts") });
}

/** Evidence store with canonical `evidence:` identity and legacy read fallback. */
export class EvidenceStore extends ArtifactStore {
  constructor(options: Omit<ArtifactStoreOptions, "refKind">) {
    super({ ...options, refKind: "evidence" });
  }

  override async put<T extends JsonValue | string>(
    input: PutArtifactInput<T>,
  ): Promise<Evidence<T>> {
    return (await super.put(input)) as Evidence<T>;
  }

  override async update<T extends JsonValue | string>(
    ref: ArtifactRef | EvidenceRef,
    patch: Partial<Omit<PutArtifactInput<T>, "ref">>,
  ): Promise<Evidence<T>> {
    return (await super.update(ref, patch)) as Evidence<T>;
  }

  override async get<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef | EvidenceRef,
  ): Promise<Evidence<T>> {
    return (await super.get<T>(ref)) as Evidence<T>;
  }

  override async tryGet<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef | EvidenceRef,
  ): Promise<Evidence<T> | null> {
    return (await super.tryGet<T>(ref)) as Evidence<T> | null;
  }

  override async list(filter: ArtifactQuery = {}): Promise<Evidence[]> {
    return (await super.list(filter)) as Evidence[];
  }
}

/** Canonical evidence-domain names. Artifact-prefixed exports below remain migration-only. */
export type Evidence<T extends JsonValue | string = JsonValue | string> = Omit<
  Artifact<T>,
  "ref"
> & { ref: EvidenceRef };
export type EvidenceProducer = ArtifactProducer;
export type EvidenceProvenance = Provenance;
export type EvidenceFormat = ArtifactFormat;
export type EvidenceCurationStatus = ArtifactCurationStatus;
export type EvidenceRetention = ArtifactRetention;
export type EvidenceCuration = ArtifactCuration;
export type EvidenceTranscriptRetention = ArtifactTranscriptRetention;
export type EvidenceLink = ArtifactLink;
export type PutEvidenceInput<T extends JsonValue | string = JsonValue | string> =
  PutArtifactInput<T>;
export type EvidenceQuery = ArtifactQuery;
export type EvidenceMetadataCompactionOptions = ArtifactMetadataCompactionOptions;
export type EvidenceMetadataCompactionCandidate = ArtifactMetadataCompactionCandidate;
export type EvidenceMetadataCompactionResult = ArtifactMetadataCompactionResult;
export type EvidenceListDiagnostic = ArtifactListDiagnostic;
export type EvidenceListWithDiagnosticsResult = ArtifactListWithDiagnosticsResult;
export const EVIDENCE_PRODUCERS = ARTIFACT_PRODUCERS;
export const EVIDENCE_KINDS = ARTIFACT_KINDS;
export const EVIDENCE_FORMATS = ARTIFACT_FORMATS;
export const EVIDENCE_CURATION_STATUSES = ARTIFACT_CURATION_STATUSES;
export const EVIDENCE_RETENTIONS = ARTIFACT_RETENTIONS;
export const EVIDENCE_LINK_RELATIONS = ARTIFACT_LINK_RELATIONS;

export async function readArtifactMetadataFile(filePath: string): Promise<Artifact> {
  const text = await readFile(filePath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ArtifactStoreFormatError(
      filePath,
      `invalid JSON: ${unknownErrorMessage(error)}`,
      "invalid_json",
    );
  }
  if (isRecord(raw) && isProductArtifactKind(raw.kind)) {
    throw new ArtifactStoreFormatError(
      filePath,
      `kind must be a valid artifact kind (product ${String(raw.kind)} skipped)`,
      "invalid_metadata",
    );
  }
  const metadata = normalizePersistedArtifactMetadata(raw);
  try {
    validateArtifact(metadata);
  } catch (error) {
    throw new ArtifactStoreFormatError(filePath, unknownErrorMessage(error));
  }
  return metadata;
}

function normalizePersistedArtifactMetadata(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const canonicalKind = canonicalArtifactKindForPersistedKind(raw.kind);
  if (!canonicalKind || canonicalKind === raw.kind) return raw;
  return {
    ...raw,
    kind: canonicalKind,
    legacyKind: raw.kind,
  };
}

export function resolveArtifactBlobPath(rootDir: string, blobPath: string): string | undefined {
  if (!blobPath.trim() || blobPath.includes("\0") || isAbsolute(blobPath)) return undefined;
  const root = resolve(rootDir);
  const blobRoot = resolve(root, "blobs");
  const resolved = resolve(root, blobPath);
  const scoped = relative(blobRoot, resolved);
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) return undefined;
  return resolved;
}

export async function compactArtifactMetadata(
  rootDir: string,
  options: ArtifactMetadataCompactionOptions = {},
): Promise<ArtifactMetadataCompactionResult> {
  await mkdir(rootDir, { recursive: true });
  const dryRun = options.dryRun ?? true;
  const thresholdBytes = options.inlineBodyThresholdBytes ?? DEFAULT_INLINE_BODY_THRESHOLD_BYTES;
  const previewChars = options.bodyPreviewChars ?? DEFAULT_BODY_PREVIEW_CHARS;
  const entries = await readdir(rootDir, { withFileTypes: true });
  const result: ArtifactMetadataCompactionResult = {
    dryRun,
    scanned: 0,
    compacted: 0,
    skipped: [],
    candidates: [],
    metadataBytesBefore: 0,
    metadataBytesAfter: 0,
    reclaimableBytes: 0,
  };
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(rootDir, entry.name);
    result.scanned += 1;
    const metadataBytesBefore = await fileSize(path);
    result.metadataBytesBefore += metadataBytesBefore;
    let artifact: Artifact;
    try {
      artifact = await readArtifactMetadataFile(path);
    } catch (error) {
      if (error instanceof ArtifactStoreFormatError) {
        result.skipped.push({
          path,
          reason: error.reason,
          message: error.message,
        });
      } else {
        result.skipped.push({
          path,
          reason: "invalid_json",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    if (artifact.bodyTruncated) {
      result.skipped.push({ path, reason: "already_compacted" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    if (!artifact.blobPath) {
      result.skipped.push({ path, reason: "missing_blob_path" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    const blobPath = resolveArtifactBlobPath(rootDir, artifact.blobPath);
    if (!blobPath) {
      result.skipped.push({ path, reason: "invalid_blob_path" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    let blobText: string;
    try {
      blobText = await readFile(blobPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        result.skipped.push({ path, reason: "missing_blob" });
        result.metadataBytesAfter += metadataBytesBefore;
        continue;
      }
      throw error;
    }
    if (artifact.hash && contentHash(blobText) !== artifact.hash) {
      result.skipped.push({ path, reason: "hash_mismatch" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    if (Buffer.byteLength(blobText, "utf8") <= thresholdBytes) {
      result.skipped.push({ path, reason: "small_body" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    const compactedArtifact = compactStoredArtifact(artifact, blobText, {
      thresholdBytes,
      previewChars,
    });
    const compactedText = `${JSON.stringify(compactedArtifact, null, 2)}\n`;
    const metadataBytesAfter = Buffer.byteLength(compactedText, "utf8");
    const candidate: ArtifactMetadataCompactionCandidate = {
      ref: artifact.ref,
      path,
      blobPath: artifact.blobPath,
      metadataBytesBefore,
      metadataBytesAfter,
      bodyBytes: Buffer.byteLength(blobText, "utf8"),
      reclaimableBytes: Math.max(0, metadataBytesBefore - metadataBytesAfter),
    };
    result.candidates.push(candidate);
    result.metadataBytesAfter += metadataBytesAfter;
    result.reclaimableBytes += candidate.reclaimableBytes;
    if (!dryRun) {
      await writeTextFileAtomic(path, compactedText);
      result.compacted += 1;
    }
  }
  return result;
}

export function validateArtifact(artifact: unknown): asserts artifact is Artifact {
  if (!isRecord(artifact)) throw new ArtifactValidationError("artifact metadata must be an object");
  assertEvidenceRefValue(artifact.ref, "artifact ref");
  if (!isArtifactKind(artifact.kind)) {
    throw new ArtifactValidationError("kind must be a valid artifact kind");
  }
  assertNonEmpty(artifact.title, "artifact title");
  if (!isArtifactFormat(artifact.format)) {
    throw new ArtifactValidationError(`invalid artifact format: ${String(artifact.format)}`);
  }
  if (!isJsonValue(artifact.body)) {
    throw new ArtifactValidationError("body must be a JSON value");
  }
  assertOptionalNonEmptyString(artifact.bodyPreview, "bodyPreview");
  assertOptionalPositiveNumber(artifact.bodySize, "bodySize");
  assertOptionalBoolean(artifact.bodyTruncated, "bodyTruncated");
  assertOptionalNonEmptyString(artifact.hash, "hash");
  assertOptionalNonEmptyString(artifact.blobPath, "blobPath");
  if (artifact.bodyTruncated === true) {
    assertNonEmpty(artifact.bodyPreview, "bodyPreview");
    assertPositiveNumber(artifact.bodySize, "bodySize");
    assertNonEmpty(artifact.blobPath, "blobPath");
  }
  if (artifact.curation !== undefined) validateArtifactCuration(artifact.curation);
  if (artifact.transcriptRetention !== undefined) {
    validateArtifactTranscriptRetention(artifact.transcriptRetention);
  }
  if (!Array.isArray(artifact.links)) throw new ArtifactValidationError("links must be an array");
  artifact.links.forEach((link, index) => validateArtifactLink(link, index));
  validateProvenance(artifact.provenance);
  assertNonEmpty(artifact.createdAt, "createdAt");
  assertNonEmpty(artifact.updatedAt, "updatedAt");
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return ARTIFACT_KINDS.includes(value as ArtifactKind);
}

export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return ARTIFACT_FORMATS.includes(value as ArtifactFormat);
}

export function isArtifactCurationStatus(value: unknown): value is ArtifactCurationStatus {
  return ARTIFACT_CURATION_STATUSES.includes(value as ArtifactCurationStatus);
}

export function isArtifactRetention(value: unknown): value is ArtifactRetention {
  return ARTIFACT_RETENTIONS.includes(value as ArtifactRetention);
}

export function isArtifactLinkRelation(value: unknown): value is ArtifactLink["relation"] {
  return ARTIFACT_LINK_RELATIONS.includes(value as ArtifactLink["relation"]);
}

export function isArtifactProducer(value: unknown): value is ArtifactProducer {
  return ARTIFACT_PRODUCERS.includes(value as ArtifactProducer);
}

export const isEvidenceKind = isArtifactKind;
export const isEvidenceFormat = isArtifactFormat;
export const isEvidenceCurationStatus = isArtifactCurationStatus;
export const isEvidenceRetention = isArtifactRetention;
export const isEvidenceLinkRelation = isArtifactLinkRelation;
export const isEvidenceProducer = isArtifactProducer;
export const validateEvidence = validateArtifact;

export function newArtifactRef(id: string = randomUUID()): ArtifactRef {
  if (!id || id.includes(":")) throw new ArtifactValidationError(`invalid artifact id: ${id}`);
  return `artifact:${id}` as ArtifactRef;
}

/** Create a canonical evidence ref. */
export function newEvidenceRef(id: string = randomUUID()): EvidenceRef {
  if (!id || id.includes(":")) throw new ArtifactValidationError(`invalid evidence id: ${id}`);
  return `evidence:${id}` as EvidenceRef;
}

export function asArtifactRef(ref: ArtifactRef | EvidenceRef): ArtifactRef {
  return ref as ArtifactRef;
}

function assertEvidenceRefValue(value: unknown, label: string): void {
  if (typeof value !== "string" || !isRef(value)) {
    throw new ArtifactValidationError(`${label} must be a valid evidence or artifact ref`);
  }
  if (!value.startsWith("artifact:") && !value.startsWith("evidence:")) {
    throw new ArtifactValidationError(`${label} must be evidence:… or artifact:…`);
  }
}

export function refId(ref: string): string {
  const index = ref.indexOf(":");
  if (index < 0) throw new ArtifactValidationError(`invalid ref: ${ref}`);
  return ref.slice(index + 1);
}

export function contentHash(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultArtifactCuration(
  kind: ArtifactKind,
  provenance: Provenance,
): ArtifactCuration {
  if (kind === "knowledge") return { status: "curated", retention: "durable" };
  if (kind === "trace") return { status: "raw", retention: "ephemeral" };
  if (provenance.producer === "review") return { status: "raw", retention: "task" };
  if (provenance.producer === "user") return { status: "candidate", retention: "project" };
  if (kind === "document") return { status: "candidate", retention: "project" };
  return { status: "raw", retention: "task" };
}

export const defaultEvidenceCuration = defaultArtifactCuration;

function validateArtifactLink(link: unknown, index: number): void {
  if (!isRecord(link)) throw new ArtifactValidationError(`links[${index}] must be an object`);
  assertEvidenceRefValue(link.from, `links[${index}].from`);
  if (typeof link.to !== "string" || !isRef(link.to)) {
    throw new ArtifactValidationError(`links[${index}].to must be a valid ref`);
  }
  if (!isArtifactLinkRelation(link.relation)) {
    throw new ArtifactValidationError(`links[${index}].relation must be valid`);
  }
}

function validateProvenance(provenance: unknown): void {
  if (!isRecord(provenance)) throw new ArtifactValidationError("provenance must be an object");
  if (!isArtifactProducer(provenance.producer)) {
    throw new ArtifactValidationError("provenance.producer must be valid");
  }
  assertOptionalRefValue(provenance.runRef, "run", "provenance.runRef");
  assertOptionalRefValue(provenance.projectRef, "proj", "provenance.projectRef");
  assertOptionalRefValue(provenance.taskRef, "task", "provenance.taskRef");
  assertOptionalRefValue(provenance.roleRef, "role", "provenance.roleRef");
  assertOptionalNonEmptyString(provenance.note, "provenance.note");
  if (provenance.parentEvidenceRefs !== undefined) {
    if (!Array.isArray(provenance.parentEvidenceRefs)) {
      throw new ArtifactValidationError("provenance.parentEvidenceRefs must be an array");
    }
    provenance.parentEvidenceRefs.forEach((ref, index) =>
      assertRefValue(ref, "evidence", `provenance.parentEvidenceRefs[${index}]`),
    );
  }
  if (provenance.parentArtifactRefs !== undefined) {
    if (!Array.isArray(provenance.parentArtifactRefs)) {
      throw new ArtifactValidationError("provenance.parentArtifactRefs must be an array");
    }
    provenance.parentArtifactRefs.forEach((ref, index) =>
      assertRefValue(ref, "artifact", `provenance.parentArtifactRefs[${index}]`),
    );
  }
}

function validateArtifactCuration(curation: unknown): void {
  if (!isRecord(curation)) throw new ArtifactValidationError("curation must be an object");
  if (!isArtifactCurationStatus(curation.status)) {
    throw new ArtifactValidationError("curation.status must be valid");
  }
  if (curation.retention !== undefined && !isArtifactRetention(curation.retention)) {
    throw new ArtifactValidationError("curation.retention must be valid");
  }
  assertOptionalNonEmptyString(curation.reason, "curation.reason");
  assertOptionalArtifactRefArray(curation.promotedFrom, "curation.promotedFrom");
  assertOptionalArtifactRefArray(curation.supersededBy, "curation.supersededBy");
  if (curation.compactedInto !== undefined) {
    assertEvidenceRefValue(curation.compactedInto, "curation.compactedInto");
  }
  assertOptionalNonEmptyString(curation.expiresAt, "curation.expiresAt");
}

function validateArtifactTranscriptRetention(retention: unknown): void {
  if (!isRecord(retention))
    throw new ArtifactValidationError("transcriptRetention must be an object");
  if (retention.schemaVersion !== 1) {
    throw new ArtifactValidationError("transcriptRetention.schemaVersion must be 1");
  }
  if (retention.strategy !== "role-run-compact-summary-tail") {
    throw new ArtifactValidationError(
      "transcriptRetention.strategy must be role-run-compact-summary-tail",
    );
  }
  assertNonEmpty(retention.candidateReason, "transcriptRetention.candidateReason");
  assertOptionalNonEmptyString(retention.originalBlobPath, "transcriptRetention.originalBlobPath");
  assertOptionalNonEmptyString(retention.originalHash, "transcriptRetention.originalHash");
  assertOptionalPositiveNumber(retention.originalBodySize, "transcriptRetention.originalBodySize");
  assertOptionalPositiveNumber(
    retention.originalMetadataBytes,
    "transcriptRetention.originalMetadataBytes",
  );
  assertNonEmpty(retention.replacementSummary, "transcriptRetention.replacementSummary");
  if (retention.transcriptTail !== undefined) validateTranscriptTail(retention.transcriptTail);
  assertOptionalNonEmptyString(retention.exportPath, "transcriptRetention.exportPath");
  assertNonEmpty(retention.compactedAt, "transcriptRetention.compactedAt");
  assertOptionalNonEmptyString(
    retention.fullTranscriptDeletedAt,
    "transcriptRetention.fullTranscriptDeletedAt",
  );
}

function validateTranscriptTail(tail: unknown): void {
  if (!isRecord(tail))
    throw new ArtifactValidationError("transcriptRetention.transcriptTail must be an object");
  assertPositiveNumber(tail.bytes, "transcriptRetention.transcriptTail.bytes");
  assertPositiveNumber(tail.tailBytes, "transcriptRetention.transcriptTail.tailBytes");
  if (typeof tail.truncated !== "boolean") {
    throw new ArtifactValidationError(
      "transcriptRetention.transcriptTail.truncated must be a boolean",
    );
  }
  if (tail.source !== "serialized-artifact-body-tail") {
    throw new ArtifactValidationError(
      "transcriptRetention.transcriptTail.source must be serialized-artifact-body-tail",
    );
  }
  assertString(tail.tail, "transcriptRetention.transcriptTail.tail");
}

function matchesQuery(artifact: Artifact, query: ArtifactQuery): boolean {
  if (query.kind && artifact.kind !== query.kind) return false;
  if (query.producer && artifact.provenance.producer !== query.producer) return false;
  if (query.projectRef && artifact.provenance.projectRef !== query.projectRef) return false;
  if (query.taskRef && artifact.provenance.taskRef !== query.taskRef) return false;
  if (query.roleRef && artifact.provenance.roleRef !== query.roleRef) return false;
  if (query.linkedTo && !artifact.links.some((link) => link.to === query.linkedTo)) return false;
  if (query.retention && artifact.curation?.retention !== query.retention) return false;
  if (query.curationStatus) {
    const statuses = Array.isArray(query.curationStatus)
      ? query.curationStatus
      : [query.curationStatus];
    if (!artifact.curation || !statuses.includes(artifact.curation.status)) return false;
  }
  if (query.includeRaw === false && artifact.curation?.status === "raw") return false;
  if (
    query.includeArchived === false &&
    (artifact.curation?.status === "archived" || artifact.curation?.status === "superseded")
  ) {
    return false;
  }
  return true;
}

function compactStoredArtifact(
  artifact: Artifact,
  serializedBody: string,
  options: { thresholdBytes: number; previewChars: number },
): Artifact {
  const compacted: Artifact = {
    ...artifact,
    body: previewBody(serializedBody, options.previewChars),
  };
  addBodyCompactionMetadata(compacted, serializedBody, options);
  return compacted;
}

function metadataBodyFor<T extends JsonValue | string>(
  body: T,
  serializedBody: string,
  options: { thresholdBytes: number; previewChars: number },
): T {
  if (Buffer.byteLength(serializedBody, "utf8") <= options.thresholdBytes) return body;
  return previewBody(serializedBody, options.previewChars) as T;
}

function addBodyCompactionMetadata(
  artifact: Artifact,
  serializedBody: string,
  options: { thresholdBytes: number; previewChars: number },
): void {
  const bodySize = Buffer.byteLength(serializedBody, "utf8");
  if (bodySize <= options.thresholdBytes) return;
  artifact.bodyPreview = previewBody(serializedBody, options.previewChars);
  artifact.bodySize = bodySize;
  artifact.bodyTruncated = true;
}

function previewBody(serializedBody: string, previewChars: number): string {
  return serializedBody.length > previewChars
    ? `${serializedBody.slice(0, previewChars)}\n… truncated ${serializedBody.length - previewChars} char(s)`
    : serializedBody;
}

function serializeArtifactBody(format: ArtifactFormat, body: JsonValue | string): string {
  if (typeof body === "string") return body;
  if (format === "json") return JSON.stringify(body, null, 2);
  return JSON.stringify(body, null, 2);
}

function parseArtifactBody(format: ArtifactFormat, body: string): JsonValue | string {
  if (format === "json") return JSON.parse(body) as JsonValue;
  return body;
}

function extensionForFormat(format: ArtifactFormat): string {
  if (format === "markdown") return "md";
  if (format === "json") return "json";
  return "txt";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRef(value: string): boolean {
  const index = value.indexOf(":");
  return index > 0 && index < value.length - 1;
}

function assertRefValue(value: unknown, kind: string, label: string): void {
  if (typeof value !== "string" || !value.startsWith(`${kind}:`) || !isRef(value)) {
    throw new ArtifactValidationError(`${label} must be a valid ${kind} ref`);
  }
}

function assertOptionalRefValue(value: unknown, kind: string, label: string): void {
  if (value === undefined) return;
  assertRefValue(value, kind, label);
}

function assertOptionalArtifactRefArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new ArtifactValidationError(`${label} must be an array`);
  value.forEach((entry, index) => assertEvidenceRefValue(entry, `${label}[${index}]`));
}

function assertString(value: unknown, label: string): void {
  if (typeof value !== "string") throw new ArtifactValidationError(`${label} must be a string`);
}

function assertNonEmpty(value: unknown, label: string): void {
  if (typeof value !== "string") throw new ArtifactValidationError(`${label} must be a string`);
  if (!value.trim()) throw new ArtifactValidationError(`${label} is required`);
}

function assertOptionalNonEmptyString(value: unknown, label: string): void {
  if (value === undefined) return;
  assertNonEmpty(value, label);
}

function assertPositiveNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ArtifactValidationError(`${label} must be a positive number`);
  }
}

function assertOptionalPositiveNumber(value: unknown, label: string): void {
  if (value === undefined) return;
  assertPositiveNumber(value, label);
}

function assertOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ArtifactValidationError(`${label} must be a boolean`);
  }
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export {
  PRODUCT_ARTIFACT_KINDS,
  PRODUCT_ARTIFACT_FORMATS,
  ProductArtifactStore,
  ProductArtifactValidationError,
  applyWorktreeToPrBody,
  attachPrWorktree,
  defaultProductArtifactStore,
  isProductArtifactBody,
  isProductArtifactFormat,
  isProductArtifactKind,
  issueBodyFromSnapshot,
  newProductArtifactRef,
  parseForgeUrl,
  prBodyFromSnapshot,
  prWorktreePath,
  removePrWorktree,
  syncForgeIssue,
  syncForgePr,
  type AttachPrWorktreeInput,
  type AttachPrWorktreeResult,
  type CommandRunner,
  type ForgeHost,
  type ForgeIssueSnapshot,
  type ForgePrSnapshot,
  type ForgeSyncOptions,
  type IssueArtifactBody,
  type PrArtifactBody,
  type PreviewArtifactBody,
  type PreviewContentFormat,
  type PreviewProgress,
  type ProductArtifact,
  type ProductArtifactBody,
  type ProductArtifactFormat,
  type ProductArtifactKind,
  type ProductArtifactQuery,
  type ProductArtifactRef,
  type ProductArtifactStoreOptions,
  type PutProductArtifactInput,
  type WorktreeCommandRunner,
  type WorktreeStatus,
} from "./product/index.ts";
