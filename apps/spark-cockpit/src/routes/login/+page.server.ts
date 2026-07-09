import { fail, redirect } from "@sveltejs/kit";
import { createRemoteOwnerSession, getCurrentUserId, setSessionCookie } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { isRemoteAccessConfigured, verifyRemoteAccessToken } from "$lib/server/remote-access";
import { formText } from "$lib/server/form-data";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  const next = safeNextPath(url.searchParams.get("next"));
  if (getCurrentUserId(getDatabase(), locals.sessionToken)) {
    redirect(303, next);
  }
  return {
    next,
    remoteAccessConfigured: isRemoteAccessConfigured(),
  };
};

export const actions: Actions = {
  default: async ({ cookies, request, url }) => {
    const next = safeNextPath(url.searchParams.get("next"));
    const token = formText(await request.formData(), "token").trim();
    if (!verifyRemoteAccessToken(token)) {
      return fail(401, {
        next,
        remoteAccessConfigured: isRemoteAccessConfigured(),
        message: isRemoteAccessConfigured()
          ? "Remote access token is invalid."
          : "Remote access is not configured. Set SPARK_COCKPIT_REMOTE_TOKEN before exposing Cockpit.",
      });
    }

    const session = createRemoteOwnerSession(getDatabase());
    setSessionCookie(cookies, session, { secure: url.protocol === "https:" });
    redirect(303, next);
  },
};

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
