import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ensureArtifactPreviewCache } from "$lib/server/artifact-cache";
import { getDatabase } from "$lib/server/db";

export const GET: RequestHandler = ({ locals, params }) => {
  if (!params.artifactId) {
    throw error(400, "Missing artifact id");
  }
  if (locals.workspaceId) {
    const artifact = getDatabase()
      .prepare("SELECT workspace_id AS workspaceId FROM artifacts WHERE id = ? LIMIT 1")
      .get(params.artifactId) as { workspaceId: string } | undefined;
    if (artifact?.workspaceId !== locals.workspaceId) throw error(404, "Artifact not found");
  }

  try {
    const cache = ensureArtifactPreviewCache(getDatabase(), params.artifactId);
    return json({ cache: serializeCacheRecord(cache) });
  } catch (caught) {
    throw error(404, caught instanceof Error ? caught.message : "Artifact not found");
  }
};

export const POST = GET;

function serializeCacheRecord(cache: ReturnType<typeof ensureArtifactPreviewCache>) {
  // The DB-level `cache_path` is private filesystem state; expose only the
  // bits the client can use to reason about the preview.
  return {
    id: cache.id,
    artifactId: cache.artifactId,
    state: cache.state,
    previewStatus: cache.previewStatus,
    isPreview: cache.isPreview,
    sizeBytes: cache.sizeBytes,
    mime: cache.mime,
    hash: cache.hash,
    fetchedAt: cache.fetchedAt,
    lastAccessedAt: cache.lastAccessedAt,
    expiresAt: cache.expiresAt,
    error: cache.error,
    sourceRef: cache.sourceRef,
    createdAt: cache.createdAt,
    updatedAt: cache.updatedAt,
  };
}
