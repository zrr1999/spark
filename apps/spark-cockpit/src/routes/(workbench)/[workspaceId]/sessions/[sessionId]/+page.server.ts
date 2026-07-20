import { getDatabase } from "$lib/server/db";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { _loadSessionPage } from "../../../sessions/[sessionId]/+page.server";
import { actions as sharedActions } from "../../../sessions/+page.server";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  const workspace = requireWorkspaceByRouteId(getDatabase(), event.params.workspaceId);
  return await _loadSessionPage(event, workspace.id);
};

export const actions: Actions = sharedActions;
