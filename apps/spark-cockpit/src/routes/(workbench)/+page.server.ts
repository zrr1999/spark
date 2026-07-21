import { fail, redirect } from "@sveltejs/kit";
import { loadWorkbenchHome } from "@zendev-lab/spark-coordination/cockpit-queries";
import { archiveWorkspace } from "@zendev-lab/spark-coordination/projection-services";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { activeWorkspaceCookieName } from "$lib/server/active-workspace";
import { ensureCurrentOwnerSession } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  if (url.searchParams.get("create") === "workspace") {
    redirect(303, "/workspaces/new");
  }

  return loadWorkbenchHome(getDatabase(), {
    forceWorkspaceCreate: false,
    pendingWorkspaceSetup: null,
    authorizedWorkspaceId: locals?.workspaceId ?? null,
  });
};

export const actions: Actions = {
  removeWorkspace: async ({ cookies, locals, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).home.workspaceHome;
    const db = getDatabase();
    const formData = await request.formData();
    const workspaceId = formText(formData, "workspaceId").trim();
    if (!workspaceId) {
      return fail(400, { intent: "removeWorkspace", message: t.removeMissing });
    }

    const userId = ensureCurrentOwnerSession(db, cookies, locals.sessionToken);
    const result = archiveWorkspace(db, {
      workspaceId,
      actorId: userId,
    });

    if (result.outcome === "missing" || result.outcome === "already_archived") {
      return fail(404, { intent: "removeWorkspace", message: t.removeMissing });
    }

    if (cookies.get(activeWorkspaceCookieName) === result.previousSlug) {
      cookies.delete(activeWorkspaceCookieName, { path: "/" });
    }

    return {
      intent: "removeWorkspace",
      message: t.removeDone.replace("{name}", result.previousSlug),
      workspaceId: result.workspaceId,
    };
  },
};
