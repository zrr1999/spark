import { redirect } from "@sveltejs/kit";
import { loadWorkbenchHome } from "@zendev-lab/spark-coordination/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  if (url.searchParams.get("create") === "workspace") {
    redirect(303, "/workspaces/new");
  }

  return loadWorkbenchHome(getDatabase(), {
    forceWorkspaceCreate: false,
    pendingWorkspaceSetup: null,
    authorizedWorkspaceId: locals?.workspaceId ?? null,
  });
};
