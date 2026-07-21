import {
  getManagedSessionForCockpit,
  getProjectedManagedSessionForCockpit,
} from "$lib/server/managed-sessions";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * Cheap status probe used only while a selected turn looks active.
 * SSE remains the fast path; this lets the workbench converge when an optional
 * Cockpit projection misses the terminal lifecycle event.
 *
 * Prefer the local projection when it already says the session is idle so the
 * probe cannot hang on a live `session.get`. Fall back to the owner only when
 * the projection is missing or still reports running.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  const projected = getProjectedManagedSessionForCockpit(params.sessionId);
  const session =
    projected && projected.status !== "running"
      ? projected
      : ((await getManagedSessionForCockpit(params.sessionId)) ?? projected);
  const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
  if (session && (!workspaceId || (locals?.workspaceId && locals.workspaceId !== workspaceId))) {
    return json({ error: "session_not_found" }, { status: 404 });
  }
  if (!session) {
    return json({ error: "session_status_unavailable" }, { status: 503 });
  }
  return json({
    sessionId: session.sessionId,
    status: session.status,
    updatedAt: session.updatedAt,
  });
};
