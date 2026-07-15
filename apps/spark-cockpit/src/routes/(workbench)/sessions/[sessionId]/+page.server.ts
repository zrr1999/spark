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
  workspaceIdForWorkbenchSession,
  workspaceSessionsForWorkbench,
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
  if (!workspaceId) {
    // Daemon-global sessions belong to the daemon/TUI control plane. Do not
    // make them reachable through a stale Cockpit URL.
    throw error(404, "Session not found");
  }
  const parentData = await parent();
  if (workspaceId !== parentData.activeWorkspace?.id) {
    // The layout only activates registered workspaces. Do not let a stale or
    // detached registry record re-enter the rail through a direct URL.
    throw error(404, "Session not found");
  }
  const sessions = workspaceSessionsForWorkbench(
    managedSessions.sessions,
    parentData.activeWorkspace?.id,
  );
  const snapshotWindow = sessionSnapshot ? sessionSnapshotWindow(sessionSnapshot) : null;
  return {
    sessions,
    sessionsAvailable: managedSessions.available,
    selectedSessionId: selected.sessionId,
    selectedSession: selected,
    sessionSnapshot: snapshotWindow?.snapshot ?? null,
    sessionHistory: snapshotWindow?.history ?? null,
    sessionEventCursor: eventCursor ? `${eventCursor.createdAt}|${eventCursor.id}` : null,
    canAssign: selected.status !== "archived",
    modelControl,
    sessionActivity: loadSessionActivity(db, {
      workspaceId,
      sessionId: selected.sessionId,
    }),
  };
};

export const actions = sessionsActions;
