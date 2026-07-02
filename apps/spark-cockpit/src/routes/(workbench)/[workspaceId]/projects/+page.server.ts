import { fail, redirect, error as kitError } from "@sveltejs/kit";
import { asciiSlug } from "@zendev-lab/spark-system";
import { loadProjectsPage } from "@zendev-lab/spark-server/cockpit-queries";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { createProject } from "$lib/server/projection-services";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const page = loadProjectsPage(getDatabase(), params.workspaceId);
  if (!page) throw kitError(404, "Workspace not found.");
  return page;
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
  return asciiSlug(value, { maxLength: 48 });
}
