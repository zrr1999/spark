import { error } from "@sveltejs/kit";
import {
  getManagedSessionForCockpit,
  listManagedSessionsForCockpit,
} from "$lib/server/managed-sessions";
import { getDatabase } from "$lib/server/db";
import { loadSessionActivity } from "$lib/server/session-activity";
import { loadModelControlForCockpit } from "$lib/server/model-control";
import type { PageServerLoad } from "./$types";
import { actions as sessionsActions } from "../+page.server";

export const load: PageServerLoad = async ({ params }) => {
  const [sessions, selected, modelControl] = await Promise.all([
    listManagedSessionsForCockpit(),
    getManagedSessionForCockpit(params.sessionId),
    loadModelControlForCockpit(params.sessionId),
  ]);
  if (!selected) {
    throw error(404, "Session not found");
  }
  const visibleSessions = sessions.some((session) => session.sessionId === selected.sessionId)
    ? sessions
    : [selected, ...sessions];
  return {
    sessions: visibleSessions,
    selectedSessionId: selected.sessionId,
    selectedSession: selected,
    canAssign: selected.status !== "archived",
    modelControl,
    sessionActivity: loadSessionActivity(getDatabase(), {
      workspaceId: selected.workspaceId,
      sessionId: selected.sessionId,
    }),
  };
};

export const actions = sessionsActions;
