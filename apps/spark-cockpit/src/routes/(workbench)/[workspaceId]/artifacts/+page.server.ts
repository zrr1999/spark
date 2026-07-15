import { loadArtifactsPage } from "@zendev-lab/spark-coordination/cockpit-queries";
import { error as kitError } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const page = loadArtifactsPage(getDatabase(), params.workspaceId);
  if (!page) throw kitError(404, "Workspace not found.");
  return page;
};
