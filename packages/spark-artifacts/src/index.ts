import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  type Artifact,
  type ArtifactKind,
  type ArtifactLink,
  type ArtifactRef,
  type JsonValue,
  type Provenance,
  contentHash,
  newRef,
  nowIso,
  refId,
  validateArtifact,
} from "spark-core";

const DEFAULT_INLINE_BODY_THRESHOLD_BYTES = 64 * 1024;
const DEFAULT_BODY_PREVIEW_CHARS = 4_000;

export interface PutArtifactInput<T extends JsonValue | string = JsonValue | string> {
  kind: ArtifactKind;
  title: string;
  format: Artifact["format"];
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
    const ref = input.ref ?? newRef("artifact");
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
    await writeFile(join(this.rootDir, blobPath), serializedBody, "utf8");
    await writeFile(this.pathFor(ref), `${JSON.stringify(storedArtifact, null, 2)}\n`, "utf8");
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

export function defaultArtifactStore(cwd: string): ArtifactStore {
  return new ArtifactStore({ rootDir: join(cwd, ".spark", "artifacts") });
}

async function readArtifactMetadataFile(filePath: string): Promise<Artifact> {
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
      const tmpPath = `${path}.${process.pid}.tmp`;
      await writeFile(tmpPath, compactedText, "utf8");
      await rename(tmpPath, path);
      result.compacted += 1;
    }
  }
  return result;
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

function serializeArtifactBody(format: Artifact["format"], body: JsonValue | string): string {
  if (typeof body === "string") return body;
  if (format === "json") return JSON.stringify(body, null, 2);
  return JSON.stringify(body, null, 2);
}

function parseArtifactBody(format: Artifact["format"], body: string): JsonValue | string {
  if (format === "json") return JSON.parse(body) as JsonValue;
  return body;
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

function extensionForFormat(format: Artifact["format"]): string {
  if (format === "markdown") return "md";
  if (format === "json") return "json";
  return "txt";
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
