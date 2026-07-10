import { redirect } from "@sveltejs/kit";
import { loadShellWorkspaceLayout } from "$lib/server/shell-layout";
import { workspacePath } from "$lib/workspace-routes";
import type { PageServerLoad } from "./$types";

/** Channels moved to workspace settings; keep a redirect for old bookmarks. */
export const load: PageServerLoad = ({ cookies, url }) => {
  const layout = loadShellWorkspaceLayout({
    cookies,
    pathname: url.pathname,
    protocol: url.protocol,
  });
  const workspace = layout.activeWorkspace;
  if (!workspace) {
    throw redirect(303, "/settings");
  }
  throw redirect(303, workspacePath(workspace, "/settings/channels"));
};
