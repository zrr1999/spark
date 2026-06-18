import { error, redirect } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { workspacePath } from "$lib/workspace-routes";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const item = getDatabase()
    .prepare(
      `SELECT ii.id, w.slug AS workspaceSlug
       FROM inbox_items ii
       JOIN workspaces w ON w.id = ii.workspace_id
       WHERE ii.id = ?
       LIMIT 1`,
    )
    .get(params.inboxItemId) as { id: string; workspaceSlug: string } | undefined;

  if (!item) {
    throw error(404, "Inbox item not found.");
  }

  redirect(303, workspacePath({ slug: item.workspaceSlug }, `/inbox/${item.id}`));
};
