import {
  getProjectedManagedSessionForCockpit,
  listManagedSessionsForCockpit,
} from "$lib/server/managed-sessions";
import { loadConversationSummaries } from "$lib/server/conversation-summaries";
import { getDatabase } from "$lib/server/db";
import { loadPendingWorkbenchAsk } from "$lib/server/pending-ask";
import { loadShellWorkspaceLayout } from "$lib/server/shell-layout";
import {
  workspaceIdForWorkbenchSession,
  workspaceSessionsForWorkbench,
} from "$lib/workbench-session-scope";
import {
  workbenchSessionIdFromPath,
  workbenchSessionsPathFromPathname,
} from "$lib/workspace-routes";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ cookies, locals, url }) => {
  const selectedSessionId = workbenchSessionIdFromPath(url.pathname);
  const sessionsPath = workbenchSessionsPathFromPathname(url.pathname);
  const projectedSelectedSession = selectedSessionId
    ? getProjectedManagedSessionForCockpit(selectedSessionId)
    : null;
  const layout = loadShellWorkspaceLayout({
    cookies,
    pathname: url.pathname,
    protocol: url.protocol,
    preferredWorkspaceId:
      sessionsPath === "/sessions" && projectedSelectedSession
        ? workspaceIdForWorkbenchSession(projectedSelectedSession)
        : null,
    preferredWorkspaceSlug: url.searchParams.get("workspace"),
    authorizedWorkspaceId: locals?.workspaceId ?? null,
  });
  const activeWorkspaceId = layout.activeWorkspace?.id ?? null;
  const managedSessions = activeWorkspaceId
    ? await listManagedSessionsForCockpit({
        scope: { kind: "workspace", workspaceId: activeWorkspaceId },
        workspaceId: activeWorkspaceId,
      })
    : { available: true, controlAvailable: false, sessions: [] };
  const selectedSession = selectedSessionId
    ? (managedSessions.sessions.find((session) => session.sessionId === selectedSessionId) ??
      (managedSessions.controlAvailable ? null : projectedSelectedSession))
    : null;
  const db = getDatabase();
  const projectedSessions = workspaceSessionsForWorkbench(
    managedSessions.sessions,
    layout.activeWorkspace?.id,
  );
  if (
    selectedSession &&
    workspaceIdForWorkbenchSession(selectedSession) === activeWorkspaceId &&
    !projectedSessions.some((session) => session.sessionId === selectedSession.sessionId)
  ) {
    projectedSessions.unshift(selectedSession);
  }
  // Filter before the SQLite enrichment query so daemon-global registry rows
  // cannot increase Cockpit navigation work.
  const sessions = loadConversationSummaries(db, projectedSessions);
  const pendingAsk = layout.activeWorkspace
    ? loadPendingWorkbenchAsk(db, layout.activeWorkspace.id)
    : null;
  return {
    ...layout,
    pendingAsk,
    sessions,
    sessionsAvailable: managedSessions.available,
    sessionControlAvailable: managedSessions.controlAvailable,
  };
};
