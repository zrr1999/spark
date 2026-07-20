import { fail, redirect } from "@sveltejs/kit";
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

export const load: PageServerLoad = ({ locals, url }) => {
  const next = safeNextPath(url.searchParams.get("next"));
  const current = getCurrentWorkspaceSession(getDatabase(), locals.sessionToken);
  if (current) {
    redirect(303, workspaceSessionsPath({ slug: current.workspaceSlug }));
  }
  return {
    next,
    workspaceAccessAvailable: hasActiveWorkspaceAccessTokens(getDatabase()),
  };
};

export const actions: Actions = {
  default: async ({ cookies, request, url }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).login;
    const next = safeNextPath(url.searchParams.get("next"));
    const token = formText(await request.formData(), "token").trim();
    let session;
    try {
      session = exchangeWorkspaceAccessToken(getDatabase(), token);
    } catch (caught) {
      if (!(caught instanceof WorkspaceAccessTokenError)) throw caught;
      return fail(401, {
        next,
        workspaceAccessAvailable: hasActiveWorkspaceAccessTokens(getDatabase()),
        message: t.invalid,
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

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
