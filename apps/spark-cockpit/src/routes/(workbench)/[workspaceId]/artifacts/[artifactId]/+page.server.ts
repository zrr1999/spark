import { error as kitError, fail } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import {
  ensureArtifactPreviewCache,
  readArtifactPreviewContent,
  type ArtifactPreviewStatus,
} from "$lib/server/artifact-cache";
import { getDatabase } from "$lib/server/db";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import type { Actions, PageServerLoad } from "./$types";

interface ArtifactDetailRow {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  projectId: string | null;
  projectName: string | null;
  scope: string;
  kind: string;
  title: string;
  format: string;
  source: string;
  hash: string | null;
  sizeBytes: number | null;
  contentRefJson: string;
  provenanceJson: string;
  createdAt: string;
  updatedAt: string;
  runtimeWorkspaceBindingId: string | null;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
  invocationId: string | null;
  runtimeInvocationId: string | null;
  invocationStatus: string | null;
  agentName: string | null;
  humanRequestId: string | null;
  humanRequestTitle: string | null;
}

export const load: PageServerLoad = ({ params }) => {
  const workspace = requireWorkspaceByRouteId(getDatabase(), params.workspaceId);
  const artifact = loadArtifactDetail(params.artifactId);
  if (artifact.workspaceId !== workspace.id) {
    throw kitError(404, "Artifact not found");
  }
  const links = getDatabase()
    .prepare(
      `SELECT id, target_kind AS targetKind, target_id AS targetId, relation, created_at AS createdAt
       FROM artifact_links
       WHERE artifact_id = ?
       ORDER BY created_at ASC`,
    )
    .all(artifact.id) as Array<{
    id: string;
    targetKind: string;
    targetId: string;
    relation: string;
    createdAt: string;
  }>;

  const cacheBlobs = getDatabase()
    .prepare(
      `SELECT id,
              state,
              is_preview AS isPreview,
              cache_path AS cachePath,
              size_bytes AS sizeBytes,
              mime,
              fetched_at AS fetchedAt,
              last_accessed_at AS lastAccessedAt,
              expires_at AS expiresAt,
              error_json AS errorJson,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM artifact_cache_blobs
       WHERE artifact_id = ?
       ORDER BY is_preview DESC, created_at DESC`,
    )
    .all(artifact.id) as Array<{
    id: string;
    state: string;
    isPreview: number;
    cachePath: string;
    sizeBytes: number | null;
    mime: string | null;
    fetchedAt: string | null;
    lastAccessedAt: string | null;
    expiresAt: string | null;
    errorJson: string | null;
    createdAt: string;
    updatedAt: string;
  }>;

  // Lazily resolve the preview cache record + body so the detail page can
  // render real preview content for `ready` artifacts and an explicit
  // missing/large/binary/error state otherwise. We never load oversized
  // bodies here: `readArtifactPreviewContent` short-circuits before reading.
  const previewResult = readArtifactPreviewContent(getDatabase(), artifact.id);
  const previewBody =
    previewResult.cache.previewStatus === "ready" && previewResult.body
      ? truncatePreviewBody(previewResult.body, previewResult.cache.mime)
      : null;
  const preview = {
    status: previewResult.cache.previewStatus satisfies ArtifactPreviewStatus,
    state: previewResult.cache.state,
    mime: previewResult.cache.mime,
    sizeBytes: previewResult.cache.sizeBytes,
    fetchedAt: previewResult.cache.fetchedAt,
    lastAccessedAt: previewResult.cache.lastAccessedAt,
    error: previewResult.cache.error,
    body: previewBody,
    inlineLimitBytes: PREVIEW_INLINE_LIMIT_BYTES,
  };

  return {
    artifact: {
      ...artifact,
      contentRef: parseJsonObject(artifact.contentRefJson),
      provenance: parseJsonObject(artifact.provenanceJson),
    },
    links,
    preview,
    cacheBlobs: cacheBlobs.map((blob) => ({
      ...blob,
      isPreview: blob.isPreview === 1,
      error: blob.errorJson ? parseJsonObject(blob.errorJson) : null,
    })),
  };
};

export const actions: Actions = {
  preparePreview: async ({ cookies, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).artifactDetail.formMessages;
    const workspace = requireWorkspaceByRouteId(getDatabase(), params.workspaceId);
    const artifact = loadArtifactDetail(params.artifactId);
    if (artifact.workspaceId !== workspace.id) {
      throw kitError(404, "Artifact not found");
    }
    try {
      ensureArtifactPreviewCache(getDatabase(), params.artifactId);
    } catch (caught) {
      return fail(400, {
        message: caught instanceof Error ? caught.message : t.prepareFailed,
      });
    }

    return { prepared: true };
  },
};

function loadArtifactDetail(artifactId: string) {
  const row = getDatabase()
    .prepare(
      `SELECT a.id,
              a.workspace_id AS workspaceId,
              w.slug AS workspaceSlug,
              w.name AS workspaceName,
              a.project_id AS projectId,
              p.name AS projectName,
              a.scope,
              a.kind,
              a.title,
              a.format,
              a.source,
              a.hash,
              a.size_bytes AS sizeBytes,
              a.content_ref_json AS contentRefJson,
              a.provenance_json AS provenanceJson,
              a.created_at AS createdAt,
              a.updated_at AS updatedAt,
              a.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              rb.display_name AS runtimeWorkspaceName,
              rc.name AS runtimeName,
              a.invocation_id AS invocationId,
              mi.runtime_invocation_id AS runtimeInvocationId,
              mi.status AS invocationStatus,
              mi.agent_name AS agentName,
              a.human_request_id AS humanRequestId,
              hr.title AS humanRequestTitle
       FROM artifacts a
       JOIN workspaces w ON w.id = a.workspace_id
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = a.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN mirrored_invocations mi ON mi.id = a.invocation_id
       LEFT JOIN human_requests hr ON hr.id = a.human_request_id
       WHERE a.id = ?
       LIMIT 1`,
    )
    .get(artifactId) as ArtifactDetailRow | undefined;

  if (!row) {
    throw kitError(404, "Artifact not found");
  }

  return row;
}

function parseJsonObject(value: string) {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/** Cap the inline preview body shown on the detail page; full content stays
 * available via the `/api/v1/artifacts/[id]/content` endpoint. */
const PREVIEW_INLINE_LIMIT_BYTES = 32 * 1024;

function truncatePreviewBody(
  body: Buffer,
  mime: string | null,
): { text: string | null; truncated: boolean; bytes: number; mime: string | null } {
  const isTextLike = isTextMime(mime);
  if (!isTextLike) {
    return { text: null, truncated: false, bytes: body.byteLength, mime };
  }
  const truncated = body.byteLength > PREVIEW_INLINE_LIMIT_BYTES;
  const slice = truncated ? body.subarray(0, PREVIEW_INLINE_LIMIT_BYTES) : body;
  return {
    text: slice.toString("utf8"),
    truncated,
    bytes: body.byteLength,
    mime,
  };
}

function isTextMime(mime: string | null): boolean {
  if (!mime) return false;
  const lower = mime.toLowerCase();
  return (
    lower.startsWith("text/") ||
    lower === "application/json" ||
    lower.startsWith("application/json;") ||
    lower === "application/xml" ||
    lower.startsWith("application/xml;")
  );
}
