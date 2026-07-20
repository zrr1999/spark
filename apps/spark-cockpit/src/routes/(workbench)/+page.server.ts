import { redirect } from "@sveltejs/kit";
import { loadWorkbenchHome } from "@zendev-lab/spark-coordination/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import { workspaceSessionsPath } from "$lib/workspace-routes";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => {
  if (url.searchParams.get("create") === "workspace") {
    redirect(303, "/workspaces/new");
  }

  const page = loadWorkbenchHome(getDatabase(), {
    forceWorkspaceCreate: false,
    pendingWorkspaceSetup: null,
  });
  if (page.redirectWorkspace || page.workspaces.length > 0) {
    redirect(303, workspaceSessionsPath(page.redirectWorkspace ?? page.workspaces[0]!));
  }
  redirect(303, "/workspaces/new");
};
