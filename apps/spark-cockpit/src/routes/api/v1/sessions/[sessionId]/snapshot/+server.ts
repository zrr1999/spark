import {
  getManagedSessionForCockpit,
  getManagedSessionSnapshotForCockpit,
} from "$lib/server/managed-sessions";
import { normalizeSessionSnapshotLimit, sessionSnapshotWindow } from "$lib/session-snapshot-window";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url }) => {
  const session = await getManagedSessionForCockpit(params.sessionId);
  if (!session) {
    return json({ error: "session_not_found" }, { status: 404 });
  }
  const snapshot = await getManagedSessionSnapshotForCockpit(params.sessionId);
  if (!snapshot) {
    return json({ error: "session_snapshot_unavailable" }, { status: 503 });
  }
  return json(
    sessionSnapshotWindow(snapshot, normalizeSessionSnapshotLimit(url.searchParams.get("limit"))),
    {
      headers: { "cache-control": "no-store" },
    },
  );
};
