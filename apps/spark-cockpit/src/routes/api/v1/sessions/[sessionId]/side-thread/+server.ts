import {
  getManagedSessionForCockpit,
  getManagedSideThreadSnapshotForCockpit,
} from "$lib/server/managed-sessions";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * The parent session remains the authorization boundary. This endpoint is
 * intentionally GET-only: opening the Cockpit inspector cannot create or
 * mutate a daemon-owned Side Thread.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  // Side Thread content can include parent context. Authorize against the
  // daemon's current session record instead of a possibly stale projection.
  const session = await getManagedSessionForCockpit(params.sessionId);
  const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
  if (!session || !workspaceId || (locals?.workspaceId && locals.workspaceId !== workspaceId)) {
    return json({ error: "session_not_found" }, { status: 404 });
  }
  const beforeExchangeId = url.searchParams.get("before")?.trim() || undefined;
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 32;
  const snapshot = await getManagedSideThreadSnapshotForCockpit(params.sessionId, {
    workspaceId,
    ...(beforeExchangeId ? { beforeExchangeId } : {}),
    limit,
  });
  if (!snapshot) return json({ error: "side_thread_not_found" }, { status: 404 });
  return json(snapshot, { headers: { "cache-control": "no-store" } });
};
