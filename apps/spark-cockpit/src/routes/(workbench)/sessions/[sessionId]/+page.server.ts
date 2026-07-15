import { error } from "@sveltejs/kit";
import {
  getManagedSessionForCockpit,
  getManagedSessionSnapshotForCockpit,
  listManagedSessionsForCockpit,
} from "$lib/server/managed-sessions";
import { getDatabase } from "$lib/server/db";
import { latestEventCursor } from "$lib/server/events";
import { loadSessionActivity } from "$lib/server/session-activity";
import { loadModelControlForCockpit } from "$lib/server/model-control";
import { sessionSnapshotWindow } from "$lib/session-snapshot-window";
import type { PageServerLoad } from "./$types";
import {
  sessionsForWorkbench,
  workspaceIdForWorkbenchSession,
} from "../../../../lib/workbench-session-scope";
import { actions as sessionsActions } from "../+page.server";

export const load: PageServerLoad = async ({ params, parent }) => {
  const db = getDatabase();
  // Capture the event watermark before loading daemon truth. Events committed
  // during the load are replayed after this cursor; older history must not
  // invalidate and rebuild the freshly hydrated page.
  const eventCursor = latestEventCursor(db);
  const [managedSessions, selected, sessionSnapshot, modelControl] = await Promise.all([
    listManagedSessionsForCockpit(),
    getManagedSessionForCockpit(params.sessionId),
    getManagedSessionSnapshotForCockpit(params.sessionId),
    loadModelControlForCockpit(params.sessionId),
  ]);
  if (!selected) {
    throw error(404, "Session not found");
  }
  const workspaceId = workspaceIdForWorkbenchSession(selected);
  const parentData = await parent();
  const sessions = sessionsForWorkbench(managedSessions.sessions, parentData.activeWorkspace?.id);
  const visibleSessions = sessions.some((session) => session.sessionId === selected.sessionId)
    ? sessions
    : [selected, ...sessions];
  const snapshotWindow = sessionSnapshot ? sessionSnapshotWindow(sessionSnapshot) : null;
  return {
    sessions: visibleSessions,
    sessionsAvailable: managedSessions.available,
    selectedSessionId: selected.sessionId,
    selectedSession: selected,
    sessionSnapshot: snapshotWindow?.snapshot ?? null,
    sessionHistory: snapshotWindow?.history ?? null,
    sessionEventCursor: eventCursor ? `${eventCursor.createdAt}|${eventCursor.id}` : null,
    canAssign: selected.status !== "archived",
    modelControl,
    sessionActivity: workspaceId
      ? loadSessionActivity(db, {
          workspaceId,
          sessionId: selected.sessionId,
        })
      : { commands: [], reports: [] },
  };
};

export const actions = sessionsActions;
