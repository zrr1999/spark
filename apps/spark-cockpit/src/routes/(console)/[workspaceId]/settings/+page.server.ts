import { fail, redirect, error as kitError } from "@sveltejs/kit";
import {
  isReservedWorkbenchPathSegment,
  loadWorkspaceSettings,
  updateWorkspaceSettings,
} from "@zendev-lab/spark-coordination/cockpit-queries";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { ensureCurrentOwnerSession } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { slugifyWorkspaceIdentifier } from "$lib/slugify";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
  if (!workspace) throw kitError(404, "Workspace not found.");

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
    if (!workspace) throw kitError(404, "Workspace not found.");
    ensureCurrentOwnerSession(
      db,
      cookies,
      locals.sessionToken,
      workspace.id,
      locals.workspaceSessionToken,
    );

    const formData = await request.formData();
    const name = formText(formData, "name").trim();
    const slug = slugifyWorkspaceIdentifier(formText(formData, "slug", name));
    const descriptionValue = formText(formData, "description").trim();
    const description = descriptionValue || null;

    if (!name || !slug) {
      return fail(400, {
        intent: "workspaceSettings",
        message: t.workspaceRequired,
      });
    }

    if (isReservedWorkbenchPathSegment(slug)) {
      return fail(400, {
        intent: "workspaceSettings",
        message: t.slugReserved,
      });
    }

    const result = updateWorkspaceSettings(db, {
      workspaceId: workspace.id,
      name,
      slug,
      description,
    });
    if (result === "duplicate_slug") {
      return fail(400, {
        intent: "workspaceSettings",
        message: t.slugUsed,
      });
    }
    if (result === "reserved_slug") {
      return fail(400, {
        intent: "workspaceSettings",
        message: t.slugReserved,
      });
    }

    if (slug !== workspace.slug) {
      redirect(303, workspacePath({ slug }, "/settings"));
    }

    return {
      intent: "workspaceSettings",
      message: t.saved,
    };
  },
};
