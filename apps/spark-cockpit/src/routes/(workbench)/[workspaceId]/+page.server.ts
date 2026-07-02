import { error } from "@sveltejs/kit";
import { loadWorkspaceDashboard } from "@zendev-lab/spark-server/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const page = loadWorkspaceDashboard(getDatabase(), params.workspaceId);
  if (!page) {
    throw error(404, "Workspace not found.");
  }
  return page;
};
