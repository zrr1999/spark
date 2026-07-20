import { error, redirect } from "@sveltejs/kit";
import { createId } from "@zendev-lab/spark-protocol";
import {
  getManagedSessionSnapshotForCockpit,
  getProjectedManagedSessionSnapshotForCockpit,
} from "$lib/server/managed-sessions";
import { getDatabase } from "$lib/server/db";
import { latestEventCursor } from "$lib/server/events";
import { loadSessionActivity } from "$lib/server/session-activity";
import {
  loadModelControlForCockpit,
  loadProjectedModelControlForCockpit,
} from "$lib/server/model-control";
import { createCockpitSubmissionId } from "$lib/server/submission-idempotency";
import type { PageServerLoad } from "./$types";
import { SESSION_SNAPSHOT_PAGE_SIZE } from "../../../../lib/session-snapshot-window";
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
  if (expectedWorkspaceId && workspaceId !== expectedWorkspaceId) {
    throw error(404, "Session not found");
  }
  if (url?.pathname.startsWith("/sessions/")) {
    redirect(
      303,
      `${workspaceSessionPath(parentData.activeWorkspace, selected.sessionId)}${url.search}`,
    );
  }
  const [snapshotWindow, modelControl] = parentData.sessionControlAvailable
    ? await Promise.all([
        getManagedSessionSnapshotForCockpit(params.sessionId, {
          messageLimit: SESSION_SNAPSHOT_PAGE_SIZE,
        }).then(
          (snapshot) => snapshot ?? getProjectedManagedSessionSnapshotForCockpit(params.sessionId),
        ),
        // Catalog is daemon-global. Route it by workspace so a stale session
        // registry entry cannot blank the model picker (settings/models works
        // for the same reason). Session selection still comes from the snapshot.
        loadModelControlForCockpit({ workspaceId }).then((control) =>
          control.available ? control : loadProjectedModelControlForCockpit({ workspaceId }),
        ),
      ])
    : await Promise.all([
        Promise.resolve(getProjectedManagedSessionSnapshotForCockpit(params.sessionId)),
        loadProjectedModelControlForCockpit({ workspaceId }),
      ]);
  return {
    sessions: parentData.sessions,
    sessionsAvailable: parentData.sessionsAvailable,
    sessionControlAvailable: parentData.sessionControlAvailable,
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
