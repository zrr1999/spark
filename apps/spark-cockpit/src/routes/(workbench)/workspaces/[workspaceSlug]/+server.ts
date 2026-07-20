import { error, redirect } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { loadWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspaceSessionsPath } from "$lib/workspace-routes";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const workspace = loadWorkspaceByRouteId(getDatabase(), params.workspaceSlug);
  if (!workspace) {
    throw error(404, "Workspace not found.");
  }

  redirect(303, workspaceSessionsPath(workspace));
};
