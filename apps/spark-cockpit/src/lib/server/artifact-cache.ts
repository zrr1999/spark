import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createId } from "@zendev-lab/spark-protocol";
import { resolveNaviaPaths } from "@zendev-lab/navia-system";

/**
 * Maximum body size the server is willing to materialize as an inline preview
 * cache. Anything larger is recorded with `state='failed'` and
 * `error.reason='too_large'` so the UI can surface it explicitly without ever
 * reading megabytes into the SvelteKit response path.
 */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/**
 * Stable reason codes carried in `artifact_cache_blobs.error_json` to tell
 * apart the explicit non-`ready` preview states. The DB-level `state`
 * remains the canonical lifecycle, but UI/API consumers should switch on
 * `previewStatus` derived from `(state, error.reason)` for display.
 */
export type ArtifactPreviewReason =
  | "too_large"
  | "unsupported_binary"
  | "fetch_error"
  | "read_error";

/**
 * Display-oriented preview status derived from the cache record. Distinct from
 * the DB `state` enum so callers can branch on user-meaningful states.
 */
export type ArtifactPreviewStatus =
  | "ready"
  | "missing"
  | "fetching"
  | "too_large"
  | "unsupported_binary"
  | "error"
  | "evicted";

export interface ArtifactCacheRecord {
  id: string;
  artifactId: string;
  hash: string | null;
  sizeBytes: number | null;
  mime: string | null;
  cachePath: string;
  sourceRef: Record<string, unknown>;
  state: "missing" | "fetching" | "ready" | "failed" | "evicted";
  isPreview: boolean;
  fetchedAt: string | null;
  lastAccessedAt: string | null;
  expiresAt: string | null;
  error: { reason?: ArtifactPreviewReason; message?: string } | null;
  /** Display-oriented status derived from `state` + `error.reason`. */
  previewStatus: ArtifactPreviewStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactCacheReadResult {
  cache: ArtifactCacheRecord;
  /** Body bytes when the preview is `ready` and not too large to inline. */
  body?: Buffer;
}

export function defaultArtifactCacheRoot() {
  return resolveNaviaPaths({ app: "server" }).artifactCacheDir;
}

/**
 * Ensure a preview-cache record exists for the artifact. Lazily materializes
 * inline content from the Spark-daemon-supplied `contentRef` when feasible, and
 * marks explicit `too_large`, `unsupported_binary`, or `error` states when
 * inline materialization is not possible.
 */
export function ensureArtifactPreviewCache(
  db: DatabaseSync,
  artifactId: string,
  options: { cacheRoot?: string; now?: string } = {},
): ArtifactCacheRecord {
  const artifact = db
    .prepare(
      `SELECT id,
              format,
              hash,
              size_bytes AS sizeBytes,
              content_ref_json AS contentRefJson
       FROM artifacts
       WHERE id = ?
       LIMIT 1`,
    )
    .get(artifactId) as
    | {
        id: string;
        format: string;
        hash: string | null;
        sizeBytes: number | null;
        contentRefJson: string;
      }
    | undefined;

  if (!artifact) {
    throw new Error(`Artifact not found: ${artifactId}`);
  }

  const timestamp = options.now ?? new Date().toISOString();
  const existing = db
    .prepare(
      `SELECT *
       FROM artifact_cache_blobs
       WHERE artifact_id = ? AND is_preview = 1 AND state != 'evicted'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(artifactId) as ArtifactCacheBlobRow | undefined;

  if (existing) {
    db.prepare(
      "UPDATE artifact_cache_blobs SET last_accessed_at = ?, updated_at = ? WHERE id = ?",
    ).run(timestamp, timestamp, existing.id);
    return mapCacheRow({ ...existing, last_accessed_at: timestamp, updated_at: timestamp });
  }

  const contentRef = parseJsonObject(artifact.contentRefJson);
  const explicit = explicitNonReadyReason({
    format: artifact.format,
    sizeBytes: artifact.sizeBytes,
    contentRef,
  });
  const inline = explicit ? null : extractInlinePreview(contentRef, artifact.format);
  const cachePath = resolve(
    options.cacheRoot ?? defaultArtifactCacheRoot(),
    safePathSegment(artifact.id),
    `preview${extensionForFormat(artifact.format, inline?.mime)}`,
  );
  const cacheId = createId("blob");
  const state: ArtifactCacheRecord["state"] = explicit ? "failed" : inline ? "ready" : "missing";
  const sizeBytes = inline ? Buffer.byteLength(inline.body) : artifact.sizeBytes;
  const mime = inline?.mime ?? mimeForFormat(artifact.format);
  const errorJson = explicit ? JSON.stringify(explicit) : null;

  mkdirSync(dirname(cachePath), { recursive: true });
  if (inline) {
    writeFileSync(cachePath, inline.body, "utf8");
  }

  db.prepare(
    `INSERT INTO artifact_cache_blobs
      (id, artifact_id, hash, size_bytes, mime, cache_path, source_ref_json, state, is_preview, pin_reason, fetched_at, last_accessed_at, expires_at, error_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    cacheId,
    artifact.id,
    artifact.hash,
    sizeBytes ?? null,
    mime,
    cachePath,
    JSON.stringify(contentRef),
    state,
    inline ? timestamp : null,
    timestamp,
    errorJson,
    timestamp,
    timestamp,
  );

  return {
    id: cacheId,
    artifactId: artifact.id,
    hash: artifact.hash,
    sizeBytes: sizeBytes ?? null,
    mime,
    cachePath,
    sourceRef: contentRef,
    state,
    isPreview: true,
    fetchedAt: inline ? timestamp : null,
    lastAccessedAt: timestamp,
    expiresAt: null,
    error: explicit ?? null,
    previewStatus: derivePreviewStatus(state, explicit ?? null),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Read the cached preview body, if available. Always touches
 * `last_accessed_at` so eviction policy can prefer cold previews. Returns the
 * cache record alongside the body when `previewStatus === 'ready'`.
 */
export function readArtifactPreviewContent(
  db: DatabaseSync,
  artifactId: string,
  options: { cacheRoot?: string; now?: string } = {},
): ArtifactCacheReadResult {
  const cache = ensureArtifactPreviewCache(db, artifactId, options);
  if (cache.previewStatus !== "ready") {
    return { cache };
  }

  if (!existsSync(cache.cachePath)) {
    const timestamp = options.now ?? new Date().toISOString();
    const errorJson = JSON.stringify({
      reason: "read_error" satisfies ArtifactPreviewReason,
      message: `Cached preview missing on disk at ${cache.cachePath}`,
    });
    db.prepare(
      `UPDATE artifact_cache_blobs
       SET state = 'failed', error_json = ?, updated_at = ?, last_accessed_at = ?
       WHERE id = ?`,
    ).run(errorJson, timestamp, timestamp, cache.id);
    const refreshed: ArtifactCacheRecord = {
      ...cache,
      state: "failed",
      error: {
        reason: "read_error",
        message: `Cached preview missing on disk at ${cache.cachePath}`,
      },
      previewStatus: "error",
      lastAccessedAt: timestamp,
      updatedAt: timestamp,
    };
    return { cache: refreshed };
  }

  let body: Buffer;
  try {
    body = readFileSync(cache.cachePath);
  } catch (caught) {
    const timestamp = options.now ?? new Date().toISOString();
    const message = caught instanceof Error ? caught.message : String(caught);
    const errorJson = JSON.stringify({
      reason: "read_error" satisfies ArtifactPreviewReason,
      message,
    });
    db.prepare(
      `UPDATE artifact_cache_blobs
       SET state = 'failed', error_json = ?, updated_at = ?, last_accessed_at = ?
       WHERE id = ?`,
    ).run(errorJson, timestamp, timestamp, cache.id);
    const refreshed: ArtifactCacheRecord = {
      ...cache,
      state: "failed",
      error: { reason: "read_error", message },
      previewStatus: "error",
      lastAccessedAt: timestamp,
      updatedAt: timestamp,
    };
    return { cache: refreshed };
  }

  return { cache, body };
}

function explicitNonReadyReason(input: {
  format: string;
  sizeBytes: number | null;
  contentRef: Record<string, unknown>;
}): { reason: ArtifactPreviewReason; message: string } | null {
  if (input.format === "blob") {
    return {
      reason: "unsupported_binary",
      message: "Binary artifacts are not previewed inline.",
    };
  }
  const declaredSize = typeof input.sizeBytes === "number" ? input.sizeBytes : null;
  const inlineSize = inlineByteSize(input.contentRef, input.format);
  const effectiveSize = inlineSize ?? declaredSize;
  if (effectiveSize !== null && effectiveSize > MAX_PREVIEW_BYTES) {
    return {
      reason: "too_large",
      message: `Preview exceeds the ${MAX_PREVIEW_BYTES}-byte budget (size ${effectiveSize}).`,
    };
  }
  return null;
}

function inlineByteSize(contentRef: Record<string, unknown>, format: string): number | null {
  const inline = extractInlinePreview(contentRef, format);
  if (!inline) {
    return null;
  }
  return Buffer.byteLength(inline.body, "utf8");
}

function derivePreviewStatus(
  state: ArtifactCacheRecord["state"],
  error: { reason?: ArtifactPreviewReason } | null,
): ArtifactPreviewStatus {
  if (state === "ready") return "ready";
  if (state === "fetching") return "fetching";
  if (state === "evicted") return "evicted";
  if (state === "missing") return "missing";
  // state === 'failed'
  if (error?.reason === "too_large") return "too_large";
  if (error?.reason === "unsupported_binary") return "unsupported_binary";
  return "error";
}

function extractInlinePreview(contentRef: Record<string, unknown>, format: string) {
  for (const key of ["inlineText", "inlineMarkdown", "text", "markdown", "content"]) {
    const value = contentRef[key];
    if (typeof value === "string") {
      return { body: value, mime: mimeForFormat(format) };
    }
  }

  for (const key of ["inlineJson", "json"]) {
    if (key in contentRef) {
      return { body: `${JSON.stringify(contentRef[key], null, 2)}\n`, mime: "application/json" };
    }
  }

  return null;
}

function extensionForFormat(format: string, mime?: string | null) {
  if (mime === "application/json") {
    return ".json";
  }

  if (format === "markdown") {
    return ".md";
  }
  if (format === "json") {
    return ".json";
  }
  if (format === "text") {
    return ".txt";
  }
  return extname(format) || ".blob";
}

function mimeForFormat(format: string) {
  if (format === "markdown") {
    return "text/markdown; charset=utf-8";
  }
  if (format === "json") {
    return "application/json";
  }
  if (format === "text") {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function parseJsonObject(value: string) {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

interface ArtifactCacheBlobRow {
  id: string;
  artifact_id: string;
  hash: string | null;
  size_bytes: number | null;
  mime: string | null;
  cache_path: string;
  source_ref_json: string;
  state: ArtifactCacheRecord["state"];
  is_preview: number;
  fetched_at: string | null;
  last_accessed_at: string | null;
  expires_at: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapCacheRow(row: ArtifactCacheBlobRow): ArtifactCacheRecord {
  const error = row.error_json
    ? (parseErrorJson(row.error_json) as { reason?: ArtifactPreviewReason; message?: string })
    : null;
  return {
    id: row.id,
    artifactId: row.artifact_id,
    hash: row.hash,
    sizeBytes: row.size_bytes,
    mime: row.mime,
    cachePath: row.cache_path,
    sourceRef: parseJsonObject(row.source_ref_json),
    state: row.state,
    isPreview: row.is_preview === 1,
    fetchedAt: row.fetched_at,
    lastAccessedAt: row.last_accessed_at,
    expiresAt: row.expires_at,
    error,
    previewStatus: derivePreviewStatus(row.state, error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseErrorJson(value: string): { reason?: ArtifactPreviewReason; message?: string } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        reason:
          typeof record.reason === "string" ? (record.reason as ArtifactPreviewReason) : undefined,
        message: typeof record.message === "string" ? record.message : undefined,
      };
    }
  } catch {
    // fall through
  }
  return {};
}
