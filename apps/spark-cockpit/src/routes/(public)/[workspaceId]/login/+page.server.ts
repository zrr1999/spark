import { error, fail, redirect } from "@sveltejs/kit";
import {
  hasActiveWorkspaceAccessTokens,
  WorkspaceAccessTokenError,
} from "@zendev-lab/spark-coordination/workspace-access";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import {
  exchangeWorkspaceAccessToken,
  getCurrentWorkspaceSession,
  setWorkspaceSessionCookies,
} from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { workspaceSessionsPath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, params, url }) => {
  const db = getDatabase();
  const workspace = db
    .prepare(
      `SELECT id, slug, name FROM workspaces
       WHERE (id = ? OR slug = ?) AND status = 'active' LIMIT 1`,
    )
    .get(params.workspaceId, params.workspaceId) as
    | { id: string; slug: string; name: string }
    | undefined;
  if (!workspace) throw error(404, "Workspace not found.");

  const next = safeNextPath(url.searchParams.get("next"), workspace.slug);
  const current = getCurrentWorkspaceSession(db, locals.workspaceSessionToken);
  if (current?.workspaceId === workspace.id) {
    redirect(303, next);
  }

  return {
    next,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
    workspaceAccessAvailable: hasActiveWorkspaceAccessTokens(db),
  };
};

export const actions: Actions = {
  default: async ({ cookies, params, request, url }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).workspaceLogin;
    const db = getDatabase();
    const workspace = db
      .prepare(
        `SELECT id, slug, name FROM workspaces
         WHERE (id = ? OR slug = ?) AND status = 'active' LIMIT 1`,
      )
      .get(params.workspaceId, params.workspaceId) as
      | { id: string; slug: string; name: string }
      | undefined;
    if (!workspace) throw error(404, "Workspace not found.");

    const next = safeNextPath(url.searchParams.get("next"), workspace.slug);
    const token = formText(await request.formData(), "token").trim();
    let session;
    try {
      session = exchangeWorkspaceAccessToken(db, token);
    } catch (caught) {
      if (!(caught instanceof WorkspaceAccessTokenError)) throw caught;
      return fail(401, {
        next,
        workspaceAccessAvailable: hasActiveWorkspaceAccessTokens(db),
        message: t.invalid,
      });
    }

    if (session.workspaceId !== workspace.id) {
      return fail(401, {
        next,
        workspaceAccessAvailable: hasActiveWorkspaceAccessTokens(db),
        message: t.wrongWorkspace,
      });
    }

    setWorkspaceSessionCookies(cookies, session, { secure: url.protocol === "https:" });
    const workspacePath = workspaceSessionsPath({ slug: session.workspaceSlug });
    redirect(
      303,
      next.startsWith(`/${encodeURIComponent(session.workspaceSlug)}/`) ? next : workspacePath,
    );
  },
};

function safeNextPath(value: string | null, workspaceSlug: string): string {
  const fallback = workspaceSessionsPath({ slug: workspaceSlug });
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  const prefix = `/${encodeURIComponent(workspaceSlug)}/`;
  if (!value.startsWith(prefix) && value !== `/${encodeURIComponent(workspaceSlug)}`) {
    return fallback;
  }
  return value;
}
