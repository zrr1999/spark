import { loadConversationSummaries } from "$lib/server/conversation-summaries";
import { getDatabase } from "$lib/server/db";
import { listManagedSessionsForCockpit } from "$lib/server/managed-sessions";
import { loadShellWorkspaceLayout } from "$lib/server/shell-layout";
import { workspaceSessionsForWorkbench } from "$lib/workbench-session-scope";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ cookies, url }) => {
  const managedSessions = await listManagedSessionsForCockpit();
  const layout = loadShellWorkspaceLayout({
    cookies,
    pathname: url.pathname,
    protocol: url.protocol,
    preferredWorkspaceSlug: url.searchParams.get("workspace"),
  });
  return {
    ...layout,
    sessions: workspaceSessionsForWorkbench(
      loadConversationSummaries(getDatabase(), managedSessions.sessions),
      layout.activeWorkspace?.id,
    ),
    sessionsAvailable: managedSessions.available,
  };
};
