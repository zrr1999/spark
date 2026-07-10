import { error } from "@sveltejs/kit";
import {
  getManagedSessionForCockpit,
  getManagedSessionSnapshotForCockpit,
  listManagedSessionsForCockpit,
} from "$lib/server/managed-sessions";
import { getDatabase } from "$lib/server/db";
import { loadSessionActivity } from "$lib/server/session-activity";
import { loadModelControlForCockpit } from "$lib/server/model-control";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import type { PageServerLoad } from "./$types";
import { actions as sessionsActions } from "../+page.server";

export const load: PageServerLoad = async ({ params }) => {
  const [sessions, selected, sessionSnapshot, modelControl] = await Promise.all([
    listManagedSessionsForCockpit(),
    getManagedSessionForCockpit(params.sessionId),
    getManagedSessionSnapshotForCockpit(params.sessionId),
    loadModelControlForCockpit(params.sessionId),
  ]);
  if (!selected) {
    throw error(404, "Session not found");
  }
  const visibleSessions = sessions.some((session) => session.sessionId === selected.sessionId)
    ? sessions
    : [selected, ...sessions];
  const workspaceId = workspaceIdForWorkbenchSession(selected);
  return {
    sessions: visibleSessions,
    selectedSessionId: selected.sessionId,
    selectedSession: selected,
    sessionSnapshot,
    canAssign: selected.status !== "archived",
    modelControl,
    sessionActivity: workspaceId
      ? loadSessionActivity(getDatabase(), {
          workspaceId,
          sessionId: selected.sessionId,
        })
      : { commands: [], reports: [] },
  };
};

export const actions = sessionsActions;
