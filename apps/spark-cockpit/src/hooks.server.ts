import { createId } from "@zendev-lab/spark-protocol";
import type { Handle, HandleServerError, RequestEvent } from "@sveltejs/kit";
import {
  getCurrentWorkspaceSession,
  refreshWorkspaceSession,
  sessionCookieName,
  sessionRefreshCookieName,
  setWorkspaceSessionCookies,
  workspaceSessionAllowsRequest,
} from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { presentCockpitServerError } from "$lib/server/error-presentation";
import { INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE } from "$lib/error-codes";
import { localeCookieName, resolveRequestLocale } from "$lib/i18n";
import { remoteAccessDecision } from "$lib/server/remote-access";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.requestId = createId("msg");
  event.locals.sessionToken = event.cookies.get(sessionCookieName) ?? null;
  let workspaceSession = getCurrentWorkspaceSession(getDatabase(), event.locals.sessionToken);
  if (!workspaceSession) {
    const refreshed = refreshWorkspaceSession(
      getDatabase(),
      event.cookies.get(sessionRefreshCookieName) ?? null,
    );
    if (refreshed) {
      setWorkspaceSessionCookies(event.cookies, refreshed, {
        secure: event.url.protocol === "https:",
      });
      event.locals.sessionToken = refreshed.sessionToken;
      workspaceSession = refreshed;
    }
  }
  event.locals.workspaceId = workspaceSession?.workspaceId ?? null;

  const clientAddress = getClientAddress(event);
  const decision = remoteAccessDecision({ url: event.url, clientAddress });
  if (decision.required && !workspaceSession) {
    return remoteAccessRequiredResponse(event);
  }
  if (
    decision.required &&
    workspaceSession &&
    !workspaceSessionAllowsRequest(getDatabase(), workspaceSession.workspaceId, event.url.pathname)
  ) {
    return workspaceAccessForbiddenResponse(workspaceSession.workspaceSlug);
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

export const handleError: HandleServerError = ({ error, event, status, message }) => {
  const presented = presentCockpitServerError({
    error,
    status,
    fallbackMessage: message,
    requestId: event.locals.requestId,
  });
  if (presented.code === INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE) {
    console.warn(
      `[spark-cockpit] ${presented.requestId} invocation belongs to another Spark service (${event.url.pathname})`,
    );
  } else {
    console.error(
      `[spark-cockpit] ${presented.requestId} ${status} ${event.request.method} ${event.url.pathname}`,
      error,
    );
  }
  return presented;
};

function getClientAddress(event: RequestEvent): string | null {
  try {
    return event.getClientAddress();
  } catch {
    return null;
  }
}

function remoteAccessRequiredResponse(event: RequestEvent): Response {
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
      error: "workspace_access_auth_required",
      message: "Spark Cockpit requires a workspace-scoped access session.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

function workspaceAccessForbiddenResponse(workspaceSlug: string): Response {
  return new Response(
    JSON.stringify({
      error: "workspace_access_forbidden",
      message: `This browser session grants only workspace ${workspaceSlug}.`,
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}
