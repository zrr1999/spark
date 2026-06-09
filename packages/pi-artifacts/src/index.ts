import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ArtifactRef = `artifact:${string}` & { readonly __kind?: "artifact" };
export type ProjectRef = `proj:${string}` & { readonly __kind?: "proj" };
export type TaskRef = `task:${string}` & { readonly __kind?: "task" };
export type RoleRef = `role:${string}` & { readonly __kind?: "role" };
export type RunRef = `run:${string}` & { readonly __kind?: "run" };
export type ReviewRef = `review:${string}` & { readonly __kind?: "review" };
export type AskRef = `ask:${string}` & { readonly __kind?: "ask" };
export type CueJobRef = `cue-job:${string}` & { readonly __kind?: "cue-job" };
export type LinkableRef =
  | ArtifactRef
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
  parentArtifactRefs?: ArtifactRef[];
  note?: string;
}

export type ArtifactKind =
  | "spark-md"
  | "research"
  | "plan"
  | "task-breakdown"
  | "role-plan"
  | "handoff"
  | "review"
  | "cue-output"
  | "role-run"
  | "role-spec-proposal"
  | "ask-answer"
  | "run-trace"
  | "learning"
  | "learning-candidate"
  | "learning-export";

export const ARTIFACT_KINDS = [
  "spark-md",
  "research",
  "plan",
  "task-breakdown",
  "role-plan",
  "handoff",
  "review",
  "cue-output",
  "role-run",
  "role-spec-proposal",
  "ask-answer",
  "run-trace",
  "learning",
  "learning-candidate",
  "learning-export",
] as const satisfies readonly ArtifactKind[];

export type ArtifactFormat = "markdown" | "json" | "text";

export const ARTIFACT_FORMATS = [
  "markdown",
  "json",
  "text",
] as const satisfies readonly ArtifactFormat[];

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
  /** Bounded serialized body preview when full metadata body is stored out-of-line. */
  bodyPreview?: string;
  /** Serialized body byte size when known. */
  bodySize?: number;
  /** True when `body` contains only a preview and `blobPath` is the full body source. */
  bodyTruncated?: boolean;
  /** Audit metadata for historical full transcript blob replacement. */
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
  ref?: ArtifactRef;
}

export interface ArtifactStoreOptions {
  rootDir: string;
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

export class ArtifactStore {
  readonly rootDir: string;
  readonly blobDir: string;
  readonly inlineBodyThresholdBytes: number;
  readonly bodyPreviewChars: number;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.blobDir = join(options.rootDir, "blobs");
    this.inlineBodyThresholdBytes =
      options.inlineBodyThresholdBytes ?? DEFAULT_INLINE_BODY_THRESHOLD_BYTES;
    this.bodyPreviewChars = options.bodyPreviewChars ?? DEFAULT_BODY_PREVIEW_CHARS;
  }

  async put<T extends JsonValue | string>(input: PutArtifactInput<T>): Promise<Artifact<T>> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.blobDir, { recursive: true });
    const now = nowIso();
    const ref = input.ref ?? newArtifactRef();
    const existing = input.ref ? await this.tryGet<T>(input.ref) : null;
    const parentLinks: ArtifactLink[] = (input.provenance.parentArtifactRefs ?? []).map(
      (parent) => ({
        from: ref,
        to: parent,
        relation: "parent",
      }),
    );
    const artifact: Artifact<T> = {
      ref,
      kind: input.kind,
      title: input.title,
      format: input.format,
      body: input.body,
      links: [...parentLinks, ...(input.links ?? []).map((link) => ({ ...link, from: ref }))],
      provenance: input.provenance,
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
    ref: ArtifactRef,
    patch: Partial<Omit<PutArtifactInput<T>, "ref">>,
  ): Promise<Artifact<T>> {
    const existing = await this.get<T>(ref);
    return this.put<T>({
      ref,
      kind: patch.kind ?? existing.kind,
      title: patch.title ?? existing.title,
      format: patch.format ?? existing.format,
      body: patch.body ?? existing.body,
      provenance: patch.provenance ?? existing.provenance,
      links: patch.links ?? existing.links.map(({ from: _from, ...link }) => link),
    });
  }

  async get<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef,
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

  async getBody(ref: ArtifactRef): Promise<string> {
    const artifact = await this.readMetadata(ref);
    if (artifact.blobPath) {
      const blobPath = resolveArtifactBlobPath(this.rootDir, artifact.blobPath);
      if (!blobPath) throw new Error(`artifact blob path escapes artifact store: ${artifact.ref}`);
      return readFile(blobPath, "utf8");
    }
    return serializeArtifactBody(artifact.format, artifact.body);
  }

  async tryGet<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef,
  ): Promise<Artifact<T> | null> {
    try {
      return await this.get<T>(ref);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(filter: ArtifactQuery = {}): Promise<Artifact[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const artifacts: Artifact[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const artifact = await readArtifactMetadataFile(join(this.rootDir, entry.name));
      if (!matchesQuery(artifact, filter)) continue;
      artifacts.push(artifact);
    }
    return artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

  pathFor(ref: ArtifactRef): string {
    return join(this.rootDir, `${refId(ref)}.json`);
  }

  private async readMetadata<T extends JsonValue | string = JsonValue | string>(
    ref: ArtifactRef,
  ): Promise<Artifact<T>> {
    return (await readArtifactMetadataFile(this.pathFor(ref))) as Artifact<T>;
  }
}

/**
 * Default project artifact storage. Kept at `.spark/artifacts` for existing local evidence
 * compatibility while artifact ownership moves to this generic Pi capability package.
 */
export function defaultArtifactStore(cwd: string): ArtifactStore {
  return new ArtifactStore({ rootDir: join(cwd, ".spark", "artifacts") });
}

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
  try {
    validateArtifact(raw);
  } catch (error) {
    throw new ArtifactStoreFormatError(filePath, unknownErrorMessage(error));
  }
  return raw;
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
  assertRefValue(artifact.ref, "artifact", "artifact ref");
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

export function isArtifactLinkRelation(value: unknown): value is ArtifactLink["relation"] {
  return ARTIFACT_LINK_RELATIONS.includes(value as ArtifactLink["relation"]);
}

export function isArtifactProducer(value: unknown): value is ArtifactProducer {
  return ARTIFACT_PRODUCERS.includes(value as ArtifactProducer);
}

export function newArtifactRef(id: string = randomUUID()): ArtifactRef {
  if (!id || id.includes(":")) throw new ArtifactValidationError(`invalid artifact id: ${id}`);
  return `artifact:${id}` as ArtifactRef;
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

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFileAtomic(filePath: string, text: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await cleanupAtomicWriteTempFile(tempPath, error);
    throw error;
  }
}

function validateArtifactLink(link: unknown, index: number): void {
  if (!isRecord(link)) throw new ArtifactValidationError(`links[${index}] must be an object`);
  assertRefValue(link.from, "artifact", `links[${index}].from`);
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
  if (provenance.parentArtifactRefs !== undefined) {
    if (!Array.isArray(provenance.parentArtifactRefs)) {
      throw new ArtifactValidationError("provenance.parentArtifactRefs must be an array");
    }
    provenance.parentArtifactRefs.forEach((ref, index) =>
      assertRefValue(ref, "artifact", `provenance.parentArtifactRefs[${index}]`),
    );
  }
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

async function cleanupAtomicWriteTempFile(tempPath: string, writeError: unknown): Promise<void> {
  try {
    await rm(tempPath, { force: true });
  } catch (cleanupError) {
    throw new Error(
      `atomic write failed and temporary file cleanup also failed: ${tempPath}; write error: ${unknownErrorMessage(writeError)}; cleanup error: ${unknownErrorMessage(cleanupError)}`,
    );
  }
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
