import { error, redirect } from "@sveltejs/kit";
import { createId } from "@zendev-lab/spark-protocol";
import {
  getProjectedManagedSessionForCockpit,
  getProjectedManagedSessionSnapshotForCockpit,
} from "$lib/server/managed-sessions";
import { getDatabase } from "$lib/server/db";
import { latestEventCursor } from "@zendev-lab/spark-coordination/events";
import { loadSessionActivity } from "@zendev-lab/spark-coordination/session-activity";
import { loadProjectedModelControlForCockpit } from "$lib/server/model-control";
import { createCockpitSubmissionId } from "$lib/server/submission-idempotency";
import type { PageServerLoad } from "./$types";
import { workspaceIdForWorkbenchSession } from "../../../../lib/workbench-session-scope";
import { workspaceSessionPath } from "../../../../lib/workspace-routes";
import { actions as sessionsActions } from "../+page.server";

type SessionPageLoadEvent = Pick<Parameters<PageServerLoad>[0], "parent" | "url"> & {
  params: { sessionId: string };
};

export async function _loadSessionPage(
  { params, parent, url }: SessionPageLoadEvent,
  expectedWorkspaceId?: string,
) {
  const db = getDatabase();
  // Capture the event watermark before loading daemon truth. Events committed
  // during the load are replayed after this cursor; older history must not
  // invalidate and rebuild the freshly hydrated page.
  const eventCursor = latestEventCursor(db);
  const parentData = await parent();
  const selectedFromRail = parentData.sessions.find(
    (session) => session.sessionId === params.sessionId,
  );
  const projectedSelected =
    selectedFromRail == null ? getProjectedManagedSessionForCockpit(params.sessionId) : null;
  const selected = selectedFromRail ?? projectedSelected;
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
  // When control is available, a missing rail entry means the live owner no
  // longer admits this session into the workspace list.
  if (!selectedFromRail && parentData.sessionControlAvailable) {
    throw error(404, "Session not found");
  }
  if (expectedWorkspaceId && workspaceId !== expectedWorkspaceId) {
    throw error(404, "Session not found");
  }
  // Legacy `/sessions/:id` (including paths.base prefixes) must land on the
  // workspace-scoped URL. The workspace page passes expectedWorkspaceId so it
  // does not redirect into itself.
  if (!expectedWorkspaceId && parentData.activeWorkspace) {
    redirect(
      303,
      `${workspaceSessionPath(parentData.activeWorkspace, selected.sessionId)}${url?.search ?? ""}`,
    );
  }
  // Always paint from the local projection. Live snapshot/catalog RPC is a
  // navigation cliff under load; EventSource catches the conversation pane up.
  const [snapshotWindow, modelControl] = await Promise.all([
    Promise.resolve(getProjectedManagedSessionSnapshotForCockpit(params.sessionId)),
    loadProjectedModelControlForCockpit({ workspaceId }),
  ]);
  return {
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
    canAssign: parentData.sessionControlAvailable && selected.status !== "archived",
    modelControl,
    submissionId: createCockpitSubmissionId(),
    sessionActivity: loadSessionActivity(db, {
      workspaceId,
      sessionId: selected.sessionId,
    }),
  };
}

export const load: PageServerLoad = _loadSessionPage;

export const actions = sessionsActions;
