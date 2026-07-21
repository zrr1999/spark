import { error as kitError, fail } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import {
  loadArtifactDetailPage,
  prepareArtifactPreviewForWorkspace,
} from "@zendev-lab/spark-cockpit-coordination/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import type { ArtifactPreviewStatus } from "@zendev-lab/spark-cockpit-coordination/artifact-cache";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const page = loadArtifactDetailPage(getDatabase(), params.workspaceId, params.artifactId);
  if (!page) throw kitError(404, "Artifact not found");

  const previewBody =
    page.previewResult.cache.previewStatus === "ready" && page.previewResult.body
      ? truncatePreviewBody(page.previewResult.body, page.previewResult.cache.mime)
      : null;
  const preview = {
    status: page.previewResult.cache.previewStatus satisfies ArtifactPreviewStatus,
    state: page.previewResult.cache.state,
    mime: page.previewResult.cache.mime,
    sizeBytes: page.previewResult.cache.sizeBytes,
    fetchedAt: page.previewResult.cache.fetchedAt,
    lastAccessedAt: page.previewResult.cache.lastAccessedAt,
    error: page.previewResult.cache.error,
    body: previewBody,
    inlineLimitBytes: PREVIEW_INLINE_LIMIT_BYTES,
  };

  return {
    artifact: {
      ...page.artifact,
      contentRef: parseJsonObject(page.artifact.contentRefJson),
      provenance: parseJsonObject(page.artifact.provenanceJson),
    },
    links: page.links,
    preview,
    cacheBlobs: page.cacheBlobs.map((blob) => ({
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
    try {
      const cache = prepareArtifactPreviewForWorkspace(
        getDatabase(),
        params.workspaceId,
        params.artifactId,
      );
      if (!cache) throw kitError(404, "Artifact not found");
    } catch (caught) {
      if (caught && typeof caught === "object" && "status" in caught) throw caught;
      return fail(400, {
        message: caught instanceof Error ? caught.message : t.prepareFailed,
      });
    }

    return { prepared: true };
  },
};

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
