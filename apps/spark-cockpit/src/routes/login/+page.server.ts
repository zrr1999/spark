import { fail, redirect } from "@sveltejs/kit";
import {
  CockpitAccessTokenError,
  hasActiveCockpitAccessTokens,
} from "@zendev-lab/spark-coordination/cockpit-access";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import {
  exchangeCockpitAccessToken,
  getCurrentCockpitSession,
  setCockpitSessionCookies,
} from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  const next = safeNextPath(url.searchParams.get("next"));
  const current = getCurrentCockpitSession(getDatabase(), locals.sessionToken);
  if (current) {
    redirect(303, next === "/" ? "/" : next);
  }
  return {
    next,
    cockpitAccessAvailable: hasActiveCockpitAccessTokens(getDatabase()),
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
      session = exchangeCockpitAccessToken(getDatabase(), token);
    } catch (caught) {
      if (!(caught instanceof CockpitAccessTokenError)) throw caught;
      return fail(401, {
        next,
        cockpitAccessAvailable: hasActiveCockpitAccessTokens(getDatabase()),
        message: t.invalid,
      });
    }

    setCockpitSessionCookies(cookies, session, { secure: url.protocol === "https:" });
    redirect(303, isPreWorkspacePath(next) ? next : "/");
  },
};

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function isPreWorkspacePath(value: string): boolean {
  if (value === "/" || value === "/workspaces/new" || value.startsWith("/workspaces/new/")) {
    return true;
  }
  if (value.startsWith("/settings") || value.startsWith("/daemon/")) return true;
  return false;
}
