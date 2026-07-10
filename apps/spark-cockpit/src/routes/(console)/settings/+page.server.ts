import { workspacePath } from "$lib/workspace-routes";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent }) => {
  const layout = await parent();
  const workspace = layout.activeWorkspace ?? layout.workspaces[0] ?? null;
  return {
    workspaceSettingsPath: workspace ? workspacePath(workspace, "/settings") : null,
  };
};
