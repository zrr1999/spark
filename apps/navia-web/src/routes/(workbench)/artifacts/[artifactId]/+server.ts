import { error, redirect } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { workspacePath } from "$lib/workspace-routes";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const artifact = getDatabase()
    .prepare(
      `SELECT a.id, w.slug AS workspaceSlug
       FROM artifacts a
       JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.id = ?
       LIMIT 1`,
    )
    .get(params.artifactId) as { id: string; workspaceSlug: string } | undefined;

  if (!artifact) {
    throw error(404, "Artifact not found.");
  }

  redirect(303, workspacePath({ slug: artifact.workspaceSlug }, `/artifacts/${artifact.id}`));
};
