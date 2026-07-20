import { createId } from "@zendev-lab/spark-protocol";
import type { Handle, HandleServerError, RequestEvent } from "@sveltejs/kit";
import {
  getCurrentCockpitSession,
  getCurrentWorkspaceSession,
  isRemoteWorkspaceDataPath,
  refreshCockpitSession,
  refreshWorkspaceSession,
  sessionCookieName,
  sessionRefreshCookieName,
  setCockpitSessionCookies,
  setWorkspaceSessionCookies,
  workspaceSessionAllowsRequest,
  workspaceSessionCookieName,
  workspaceSessionRefreshCookieName,
} from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { presentCockpitServerError } from "$lib/server/error-presentation";
import { INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE } from "$lib/error-codes";
import { localeCookieName, resolveRequestLocale } from "$lib/i18n";
import { remoteAccessDecision } from "$lib/server/remote-access";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.requestId = createId("msg");
  const db = getDatabase();

  event.locals.sessionToken = event.cookies.get(sessionCookieName) ?? null;
  let cockpitSession = getCurrentCockpitSession(db, event.locals.sessionToken);
  if (!cockpitSession) {
    const refreshed = refreshCockpitSession(
      db,
      event.cookies.get(sessionRefreshCookieName) ?? null,
    );
    if (refreshed) {
      setCockpitSessionCookies(event.cookies, refreshed, {
        secure: event.url.protocol === "https:",
      });
      event.locals.sessionToken = refreshed.sessionToken;
      cockpitSession = refreshed;
    }
  }

  event.locals.workspaceSessionToken = event.cookies.get(workspaceSessionCookieName) ?? null;
  let workspaceSession = getCurrentWorkspaceSession(db, event.locals.workspaceSessionToken);
  if (!workspaceSession) {
    const refreshed = refreshWorkspaceSession(
      db,
      event.cookies.get(workspaceSessionRefreshCookieName) ?? null,
    );
    if (refreshed) {
      setWorkspaceSessionCookies(event.cookies, refreshed, {
        secure: event.url.protocol === "https:",
      });
      event.locals.workspaceSessionToken = refreshed.sessionToken;
      workspaceSession = refreshed;
    }
  }
  event.locals.workspaceId = workspaceSession?.workspaceId ?? null;

  const clientAddress = getClientAddress(event);
  const decision = remoteAccessDecision({ url: event.url, clientAddress });
  if (decision.required && !cockpitSession && !workspaceSession) {
    return remoteAccessRequiredResponse(event, "cockpit");
  }
  if (
    decision.required &&
    cockpitSession &&
    !workspaceSession &&
    isRemoteWorkspaceDataPath(event.url.pathname)
  ) {
    const slug = workspaceSlugFromPath(event.url.pathname);
    if (slug) {
      return remoteAccessRequiredResponse(event, "workspace", slug);
    }
  }
  if (
    decision.required &&
    workspaceSession &&
    !workspaceSessionAllowsRequest(db, workspaceSession.workspaceId, event.url.pathname)
  ) {
    // Cockpit owner sessions may still use control-plane routes.
    if (!cockpitSession || isRemoteWorkspaceDataPath(event.url.pathname)) {
      return workspaceAccessForbiddenResponse(workspaceSession.workspaceSlug);
    }
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

function workspaceSlugFromPath(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function remoteAccessRequiredResponse(
  event: RequestEvent,
  layer: "cockpit" | "workspace",
  workspaceSlug?: string,
): Response {
  const acceptsHtml = event.request.headers.get("accept")?.includes("text/html") ?? false;
  if ((event.request.method === "GET" || event.request.method === "HEAD") && acceptsHtml) {
    const next = `${event.url.pathname}${event.url.search}`;
    const location =
      layer === "workspace" && workspaceSlug
        ? `/${encodeURIComponent(workspaceSlug)}/login?next=${encodeURIComponent(next)}`
        : `/login?next=${encodeURIComponent(next)}`;
    return new Response(null, {
      status: 303,
      headers: { location },
    });
  }

  return new Response(
    JSON.stringify({
      error:
        layer === "workspace" ? "workspace_access_auth_required" : "cockpit_access_auth_required",
      message:
        layer === "workspace"
          ? "Spark Cockpit requires a workspace-scoped access session for this path."
          : "Spark Cockpit requires a Cockpit access session.",
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
