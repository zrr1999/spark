import type { Cookies } from "@sveltejs/kit";
import { loadWorkbenchLayout } from "@zendev-lab/spark-coordination/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import { activeWorkspaceCookieName } from "$lib/server/active-workspace";

export function loadShellWorkspaceLayout(input: {
  cookies: Cookies;
  pathname: string;
  protocol: string;
  preferredWorkspaceId?: string | null;
  preferredWorkspaceSlug?: string | null;
}) {
  const preferredFromQuery = input.preferredWorkspaceSlug?.trim() || null;
  const preferredFromCookie = input.cookies.get(activeWorkspaceCookieName)?.trim() || null;
  const loadedLayout = loadWorkbenchLayout(getDatabase(), input.pathname, {
    preferredWorkspaceSlug: preferredFromQuery || preferredFromCookie,
  });
  const preferredById = input.preferredWorkspaceId
    ? loadedLayout.workspaces.find((workspace) => workspace.id === input.preferredWorkspaceId)
    : null;
  const layout = preferredById ? { ...loadedLayout, activeWorkspace: preferredById } : loadedLayout;

  if (layout.activeWorkspace) {
    input.cookies.set(activeWorkspaceCookieName, layout.activeWorkspace.slug, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: input.protocol === "https:",
      maxAge: 60 * 60 * 24 * 365,
    });
  } else if (preferredFromCookie) {
    input.cookies.delete(activeWorkspaceCookieName, { path: "/" });
  }

  return layout;
}
