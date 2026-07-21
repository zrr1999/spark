import { error as kitError } from "@sveltejs/kit";
import { loadInboxPage } from "@zendev-lab/spark-cockpit-coordination/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const page = loadInboxPage(getDatabase(), params.workspaceId);
  if (!page) throw kitError(404, "Workspace not found.");
  return page;
};
