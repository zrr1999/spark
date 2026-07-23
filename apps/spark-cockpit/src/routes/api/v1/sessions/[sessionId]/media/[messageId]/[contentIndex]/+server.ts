import {
  getManagedSessionMediaForCockpit,
  getProjectedManagedSessionForCockpit,
} from "$lib/server/managed-sessions";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import { error, type RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async ({ locals, params }) => {
  const sessionId = params.sessionId?.trim();
  const messageId = params.messageId?.trim();
  if (!sessionId || !messageId) throw error(404, "Session media not found");
  const session = getProjectedManagedSessionForCockpit(sessionId);
  const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
  if (!session || !workspaceId || (locals?.workspaceId && locals.workspaceId !== workspaceId)) {
    throw error(404, "Session media not found");
  }
  const contentIndex = Number(params.contentIndex);
  if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) {
    throw error(400, "Invalid session media index");
  }
  const media = await getManagedSessionMediaForCockpit(sessionId, {
    messageId,
    contentIndex,
  });
  if (!media) throw error(503, "Session media is unavailable");

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(media.body.buffer, media.body.byteOffset, media.body.byteLength),
        );
        controller.close();
      },
    }),
    {
      headers: {
        "Content-Type": media.mediaType,
        "Content-Length": String(media.body.byteLength),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        ...(media.name
          ? {
              "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(media.name)}`,
            }
          : {}),
      },
    },
  );
};
