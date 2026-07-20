import {
  getManagedSessionForCockpit,
  getManagedSessionSnapshotForCockpit,
} from "$lib/server/managed-sessions";
import { normalizeSessionSnapshotLimit } from "$lib/session-snapshot-window";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const session = await getManagedSessionForCockpit(params.sessionId);
  const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
  if (!session || !workspaceId || (locals?.workspaceId && locals.workspaceId !== workspaceId)) {
    return json({ error: "session_not_found" }, { status: 404 });
  }
  const beforeMessageId = url.searchParams.get("before")?.trim() || undefined;
  const window = await getManagedSessionSnapshotForCockpit(params.sessionId, {
    messageLimit: normalizeSessionSnapshotLimit(url.searchParams.get("limit")),
    ...(beforeMessageId ? { beforeMessageId } : {}),
  });
  if (!window) {
    return json({ error: "session_snapshot_unavailable" }, { status: 503 });
  }
  return json(window, { headers: { "cache-control": "no-store" } });
};
