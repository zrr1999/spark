import { error } from "@sveltejs/kit";
import { createId } from "@zendev-lab/spark-protocol";
import { getManagedSessionSnapshotForCockpit } from "$lib/server/managed-sessions";
import { getDatabase } from "$lib/server/db";
import { latestEventCursor } from "$lib/server/events";
import { loadSessionActivity } from "$lib/server/session-activity";
import { loadModelControlForCockpit } from "$lib/server/model-control";
import { createCockpitSubmissionId } from "$lib/server/submission-idempotency";
import type { PageServerLoad } from "./$types";
import { workspaceIdForWorkbenchSession } from "../../../../lib/workbench-session-scope";
import { actions as sessionsActions } from "../+page.server";

export const load: PageServerLoad = async ({ params, parent }) => {
  const db = getDatabase();
  // Capture the event watermark before loading daemon truth. Events committed
  // during the load are replayed after this cursor; older history must not
  // invalidate and rebuild the freshly hydrated page.
  const eventCursor = latestEventCursor(db);
  const parentData = await parent();
  const selected = parentData.sessions.find((session) => session.sessionId === params.sessionId);
  const workspaceId = selected ? workspaceIdForWorkbenchSession(selected) : null;
  if (!selected || !workspaceId) {
    // Resolve scope before any session-specific RPC. Daemon-scoped sessions are
    // intentionally reachable only from the native TUI.
    throw error(404, "Session not found");
  }
  if (workspaceId !== parentData.activeWorkspace?.id) {
    // The layout only activates registered workspaces. Do not let a stale or
    // detached registry record re-enter the rail through a direct URL.
    throw error(404, "Session not found");
  }
  const [snapshotWindow, modelControl] = await Promise.all([
    getManagedSessionSnapshotForCockpit(params.sessionId),
    loadModelControlForCockpit(params.sessionId),
  ]);
  return {
    sessions: parentData.sessions,
    sessionsAvailable: parentData.sessionsAvailable,
    selectedSessionId: selected.sessionId,
    sendSubmissionIdSeed: createId("idem"),
    selectedSession: selected,
    sessionSnapshot: snapshotWindow?.snapshot ?? null,
    sessionHistory: snapshotWindow?.history ?? null,
    sessionEventCursor: eventCursor
      ? typeof eventCursor.sequence === "number"
        ? `${eventCursor.sequence}|${eventCursor.createdAt}|${eventCursor.id}`
        : `${eventCursor.createdAt}|${eventCursor.id}`
      : null,
    canAssign: selected.status !== "archived",
    modelControl,
    submissionId: createCockpitSubmissionId(),
    sessionActivity: loadSessionActivity(db, {
      workspaceId,
      sessionId: selected.sessionId,
    }),
  };
};

export const actions = sessionsActions;
