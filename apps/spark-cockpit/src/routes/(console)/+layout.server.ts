import { loadShellWorkspaceLayout } from "$lib/server/shell-layout";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ cookies, url }) => {
  return loadShellWorkspaceLayout({
    cookies,
    pathname: url.pathname,
    protocol: url.protocol,
    preferredWorkspaceSlug: url.searchParams.get("workspace"),
  });
};
