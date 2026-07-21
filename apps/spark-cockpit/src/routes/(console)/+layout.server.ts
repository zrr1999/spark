import { loadShellWorkspaceLayout } from "$lib/server/shell-layout";
import { isGlobalConsolePath } from "$lib/console-nav";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ cookies, locals, url }) => {
  // Console settings pages are local-SQLite / daemon-RPC only. Skip remote
  // session listing so /settings/invocations and siblings stay fast.
  const layout = loadShellWorkspaceLayout({
    cookies,
    pathname: url.pathname,
    protocol: url.protocol,
    preferredWorkspaceSlug: url.searchParams.get("workspace"),
    authorizedWorkspaceId: locals?.workspaceId ?? null,
  });
  return {
    ...layout,
    sessions: [],
    sessionsAvailable: true,
    isGlobalConsole: isGlobalConsolePath(url.pathname),
  };
};
