import { redirect } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspacePath } from "$lib/workspace-routes";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const workspace = requireWorkspaceByRouteId(getDatabase(), params.workspaceId);
  redirect(303, workspacePath(workspace));
};
