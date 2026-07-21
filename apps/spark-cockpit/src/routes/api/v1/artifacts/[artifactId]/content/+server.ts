import { error, type RequestHandler } from "@sveltejs/kit";
import {
  readArtifactPreviewContent,
  type ArtifactPreviewStatus,
} from "@zendev-lab/spark-coordination/artifact-cache";
import { getDatabase } from "$lib/server/db";

/**
 * Lazy artifact content endpoint. Returns the cached preview body for `ready`
 * artifacts and an explicit JSON error envelope for missing/large/binary/error
 * states so the UI never has to guess the meaning of an empty body.
 */
export const GET: RequestHandler = ({ locals, params, request }) => {
  if (!params.artifactId) {
    throw error(400, "Missing artifact id");
  }
  if (locals.workspaceId) {
    const artifact = getDatabase()
      .prepare("SELECT workspace_id AS workspaceId FROM artifacts WHERE id = ? LIMIT 1")
      .get(params.artifactId) as { workspaceId: string } | undefined;
    if (artifact?.workspaceId !== locals.workspaceId) throw error(404, "Artifact not found");
  }

  let result: ReturnType<typeof readArtifactPreviewContent>;
  try {
    result = readArtifactPreviewContent(getDatabase(), params.artifactId);
  } catch (caught) {
    throw error(404, caught instanceof Error ? caught.message : "Artifact not found");
  }

  const { cache, body } = result;
  const previewStatus: ArtifactPreviewStatus = cache.previewStatus;

  if (previewStatus !== "ready" || !body) {
    return errorResponse(previewStatus, cache);
  }

  const mime = cache.mime ?? "application/octet-stream";
  const headers = new Headers({
    "Content-Type": mime,
    "Content-Length": String(body.byteLength),
    "X-Spark-Cockpit-Preview-Status": previewStatus,
    "Cache-Control": "private, max-age=60",
  });
  if (cache.hash) {
    headers.set("ETag", `"${cache.hash}"`);
    if (request.headers.get("if-none-match") === `"${cache.hash}"`) {
      return new Response(null, { status: 304, headers });
    }
  }
  // svelte-check resolves Response.BodyInit narrowly; fall back to text for
  // text-like previews (markdown/json/text) and a ReadableStream for any
  // future binary preview surface. Today, only text-like previews reach the
  // ready state (binary/blob is short-circuited as `unsupported_binary`).
  const responseBody = isTextMimeForResponse(mime) ? body.toString("utf8") : bufferToStream(body);
  return new Response(responseBody, { status: 200, headers });
};

function errorResponse(
  previewStatus: ArtifactPreviewStatus,
  cache: ReturnType<typeof readArtifactPreviewContent>["cache"],
): Response {
  const status = httpStatusForPreview(previewStatus);
  const payload = {
    previewStatus,
    state: cache.state,
    error: cache.error,
    sizeBytes: cache.sizeBytes,
    mime: cache.mime,
  };
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Spark-Cockpit-Preview-Status": previewStatus,
    },
  });
}

function isTextMimeForResponse(mime: string): boolean {
  const lower = mime.toLowerCase();
  return (
    lower.startsWith("text/") ||
    lower === "application/json" ||
    lower.startsWith("application/json;") ||
    lower.startsWith("application/xml")
  );
}

function bufferToStream(body: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
      controller.close();
    },
  });
}

function httpStatusForPreview(previewStatus: ArtifactPreviewStatus): number {
  switch (previewStatus) {
    case "missing":
    case "fetching":
      return 202;
    case "evicted":
      return 410;
    case "too_large":
      return 413;
    case "unsupported_binary":
      return 415;
    case "error":
      return 502;
    case "ready":
      return 200;
  }
}
