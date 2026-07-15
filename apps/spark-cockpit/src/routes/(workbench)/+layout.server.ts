import {
  getManagedSessionForCockpit,
  listManagedSessionsForCockpit,
} from "$lib/server/managed-sessions";
import { loadConversationSummaries } from "$lib/server/conversation-summaries";
import { getDatabase } from "$lib/server/db";
import { loadPendingWorkbenchAsk } from "$lib/server/pending-ask";
import { loadShellWorkspaceLayout } from "$lib/server/shell-layout";
import { sessionsForWorkbench, workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ cookies, url }) => {
  const managedSessions = await listManagedSessionsForCockpit();
  const selectedSessionId = sessionIdFromPath(url.pathname);
  const selectedSession = selectedSessionId
    ? (managedSessions.sessions.find((session) => session.sessionId === selectedSessionId) ??
      (await getManagedSessionForCockpit(selectedSessionId)))
    : null;
  const layout = loadShellWorkspaceLayout({
    cookies,
    pathname: url.pathname,
    protocol: url.protocol,
    preferredWorkspaceId: selectedSession ? workspaceIdForWorkbenchSession(selectedSession) : null,
    preferredWorkspaceSlug: url.searchParams.get("workspace"),
  });
  const db = getDatabase();
  const sessions = sessionsForWorkbench(
    loadConversationSummaries(db, managedSessions.sessions),
    layout.activeWorkspace?.id,
  );
  const pendingAsk = layout.activeWorkspace
    ? loadPendingWorkbenchAsk(db, layout.activeWorkspace.id)
    : null;
  return {
    ...layout,
    pendingAsk,
    sessions,
    sessionsAvailable: managedSessions.available,
  };
};

function sessionIdFromPath(pathname: string) {
  if (!pathname.startsWith("/sessions/")) return null;
  try {
    const sessionId = decodeURIComponent(pathname.slice("/sessions/".length).split("/")[0] ?? "");
    return sessionId.trim() || null;
  } catch {
    return null;
  }
}
