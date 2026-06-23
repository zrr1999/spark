import { fail, redirect } from "@sveltejs/kit";
import { asciiSlug } from "@zendev-lab/spark-system";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { ensureCurrentOwnerSession } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const db = getDatabase();
  const workspace = loadWorkspaceSettings(db, params.workspaceId);

  return {
    workspace,
    registrationPath: workspacePath(workspace, "/settings/registration"),
  };
};

export const actions: Actions = {
  updateWorkspace: async ({ cookies, locals, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).settings.formMessages;
    const db = getDatabase();
    const workspace = loadWorkspaceSettings(db, params.workspaceId);
    ensureCurrentOwnerSession(db, cookies, locals.sessionToken);

    const formData = await request.formData();
    const name = formText(formData, "name").trim();
    const slug = slugify(formText(formData, "slug", name));
    const descriptionValue = formText(formData, "description").trim();
    const description = descriptionValue || null;

    if (!name || !slug) {
      return fail(400, {
        intent: "workspaceSettings",
        message: t.workspaceRequired,
      });
    }

    const duplicate = db
      .prepare(
        `SELECT id
         FROM workspaces
         WHERE slug = ?
           AND id != ?
           AND status = 'active'
         LIMIT 1`,
      )
      .get(slug, workspace.id) as { id: string } | undefined;

    if (duplicate) {
      return fail(400, {
        intent: "workspaceSettings",
        message: t.slugUsed,
      });
    }

    db.prepare(
      `UPDATE workspaces
       SET name = ?,
           slug = ?,
           description = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(name, slug, description, new Date().toISOString(), workspace.id);

    if (slug !== workspace.slug) {
      redirect(303, workspacePath({ slug }, "/settings"));
    }

    return {
      intent: "workspaceSettings",
      message: t.saved,
    };
  },
};

function loadWorkspaceSettings(db: ReturnType<typeof getDatabase>, workspaceId: string) {
  const routeWorkspace = requireWorkspaceByRouteId(db, workspaceId);
  return db
    .prepare(
      `SELECT id,
              slug,
              name,
              description,
              status,
              settings_json AS settingsJson,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM workspaces
       WHERE id = ?
       LIMIT 1`,
    )
    .get(routeWorkspace.id) as {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: "active" | "archived";
    settingsJson: string;
    createdAt: string;
    updatedAt: string;
  };
}

function slugify(value: string) {
  return asciiSlug(value, { maxLength: 48 });
}
