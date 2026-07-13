import { loadConversationSummaries } from "$lib/server/conversation-summaries";
import { getDatabase } from "$lib/server/db";
import { listManagedSessionsForCockpit } from "$lib/server/managed-sessions";
import { loadShellWorkspaceLayout } from "$lib/server/shell-layout";
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
    sessions: loadConversationSummaries(getDatabase(), managedSessions),
  };
};
