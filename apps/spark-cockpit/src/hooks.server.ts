import { createId } from "@zendev-lab/spark-protocol";
import type { Handle, RequestEvent } from "@sveltejs/kit";
import { getCurrentUserId, sessionCookieName } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { localeCookieName, resolveRequestLocale } from "$lib/i18n";
import {
  bearerRemoteAccessToken,
  isRemoteAccessAllowed,
  isRemoteAccessConfigured,
  remoteAccessDecision,
} from "$lib/server/remote-access";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.requestId = createId("msg");
  event.locals.sessionToken = event.cookies.get(sessionCookieName) ?? null;

  const clientAddress = getClientAddress(event);
  const decision = remoteAccessDecision({ url: event.url, clientAddress });
  if (decision.required && !isRemoteRequestAuthenticated(event, clientAddress)) {
    return remoteAccessRequiredResponse(event);
  }

  const locale = resolveRequestLocale({
    requestedLocale: event.url.searchParams.get("lang"),
    cookieLocale: event.cookies.get(localeCookieName),
    acceptLanguage: event.request.headers.get("accept-language"),
  });

  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace("%spark.locale%", locale),
  });
};

function isRemoteRequestAuthenticated(event: RequestEvent, clientAddress: string | null): boolean {
  return isRemoteAccessAllowed({
    url: event.url,
    clientAddress,
    sessionUserId: getCurrentUserId(getDatabase(), event.locals.sessionToken),
    bearerToken: bearerRemoteAccessToken(event.request),
  });
}

function getClientAddress(event: RequestEvent): string | null {
  try {
    return event.getClientAddress();
  } catch {
    return null;
  }
}

function remoteAccessRequiredResponse(event: RequestEvent): Response {
  const configured = isRemoteAccessConfigured();
  const acceptsHtml = event.request.headers.get("accept")?.includes("text/html") ?? false;
  if ((event.request.method === "GET" || event.request.method === "HEAD") && acceptsHtml) {
    const next = `${event.url.pathname}${event.url.search}`;
    return new Response(null, {
      status: 303,
      headers: { location: `/login?next=${encodeURIComponent(next)}` },
    });
  }

  return new Response(
    JSON.stringify({
      error: configured ? "remote_access_auth_required" : "remote_access_token_not_configured",
      message: configured
        ? "Spark Cockpit remote access requires a valid session cookie or bearer token."
        : "Set SPARK_COCKPIT_REMOTE_TOKEN before exposing Spark Cockpit on a non-localhost address.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="Spark Cockpit"',
      },
    },
  );
}
