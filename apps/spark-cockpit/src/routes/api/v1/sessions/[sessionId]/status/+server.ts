import { getManagedSessionForCockpit } from "$lib/server/managed-sessions";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * Cheap daemon-owned status probe used only while a selected turn is active.
 * SSE remains the fast path; this lets the workbench converge when an optional
 * Cockpit projection misses the terminal lifecycle event.
 */
export const GET: RequestHandler = async ({ params }) => {
  const session = await getManagedSessionForCockpit(params.sessionId);
  if (!session) {
    return json({ error: "session_status_unavailable" }, { status: 503 });
  }
  return json({
    sessionId: session.sessionId,
    status: session.status,
    updatedAt: session.updatedAt,
  });
};
