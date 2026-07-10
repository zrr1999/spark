import { error, redirect } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { workspacePath } from "$lib/workspace-routes";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const targetWorkspace = getDatabase()
    .prepare(
      `SELECT w.slug AS workspaceSlug
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = ?
       LIMIT 1`,
    )
    .get(params.projectId) as { workspaceSlug: string } | undefined;

  if (!targetWorkspace) {
    throw error(404, "Workspace context not found.");
  }

  redirect(303, workspacePath({ slug: targetWorkspace.workspaceSlug }));
};
