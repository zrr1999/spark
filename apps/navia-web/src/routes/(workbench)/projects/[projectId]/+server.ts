import { error, redirect } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { workspacePath } from "$lib/workspace-routes";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const project = getDatabase()
    .prepare(
      `SELECT p.id, w.slug AS workspaceSlug
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id = ?
       LIMIT 1`,
    )
    .get(params.projectId) as { id: string; workspaceSlug: string } | undefined;

  if (!project) {
    throw error(404, "Project not found.");
  }

  redirect(303, workspacePath({ slug: project.workspaceSlug }, `/projects/${project.id}`));
};
