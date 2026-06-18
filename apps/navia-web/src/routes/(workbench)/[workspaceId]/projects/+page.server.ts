import { fail, redirect } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { createProject } from "$lib/server/projection-services";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const db = getDatabase();
  const workspace = requireWorkspaceByRouteId(db, params.workspaceId);

  const projects = db
    .prepare(
      `SELECT p.id,
              p.slug,
              p.name,
              p.description,
              p.status,
              p.created_at AS createdAt,
              p.updated_at AS updatedAt,
              COUNT(DISTINCT ii.id) FILTER (WHERE ii.status = 'pending') AS pendingInboxCount,
              COUNT(DISTINCT mi.id) FILTER (WHERE mi.status = 'running') AS runningInvocationCount,
              COUNT(DISTINCT a.id) AS artifactCount
       FROM projects p
       LEFT JOIN inbox_items ii ON ii.project_id = p.id
       LEFT JOIN mirrored_invocations mi ON mi.project_id = p.id
       LEFT JOIN artifacts a ON a.project_id = p.id
       WHERE p.workspace_id = ?
       GROUP BY p.id
       ORDER BY p.updated_at DESC, p.created_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
    pendingInboxCount: number;
    runningInvocationCount: number;
    artifactCount: number;
  }>;

  return { workspace, projects };
};

export const actions: Actions = {
  createProject: async ({ cookies, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).projects.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);

    const formData = await request.formData();
    const name = formText(formData, "name").trim();
    const slug = slugify(formText(formData, "slug", name));
    const description = formText(formData, "description").trim() || null;

    if (!name || !slug) {
      return fail(400, { message: t.nameSlugRequired });
    }

    let projectId: string;
    try {
      projectId = createProject(db, {
        workspaceId: workspace.id,
        name,
        slug,
        description,
      }).id;
    } catch (caught) {
      return fail(400, {
        message: caught instanceof Error ? caught.message : t.createFailed,
      });
    }

    redirect(303, workspacePath(workspace, `/projects/${projectId}`));
  },
};

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
