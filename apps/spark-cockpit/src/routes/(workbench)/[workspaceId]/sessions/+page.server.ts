import { getDatabase } from "$lib/server/db";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { actions as sharedActions, _loadSessionsPage } from "../../sessions/+page.server";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  const workspace = requireWorkspaceByRouteId(getDatabase(), event.params.workspaceId);
  return await _loadSessionsPage(event, workspace.id);
};

export const actions: Actions = sharedActions;
