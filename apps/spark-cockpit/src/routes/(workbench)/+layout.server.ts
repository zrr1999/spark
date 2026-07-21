import {
  getProjectedManagedSessionForCockpit,
  listManagedSessionsForCockpit,
  listProjectedManagedSessionsForCockpit,
} from "$lib/server/managed-sessions";
import { loadConversationSummaries } from "$lib/server/conversation-summaries";
import { getDatabase } from "$lib/server/db";
import { loadPendingWorkbenchAsk } from "$lib/server/pending-ask";
import { loadShellWorkspaceLayout } from "$lib/server/shell-layout";
import {
  workspaceIdForWorkbenchSession,
  workspaceSessionsForWorkbench,
} from "$lib/workbench-session-scope";
import {
  workbenchSessionIdFromPath,
  workbenchSessionsPathFromPathname,
} from "$lib/workspace-routes";
import type { LayoutServerLoad } from "./$types";

/**
 * Bound live `session.list`. The session rail lives in this layout, so the list
 * must be returned here (child layouts cannot feed parent `data.sessions`).
 *
 * Avoid reading `url.pathname` / `params.sessionId` on workspace-scoped and
 * legacy `/sessions/[sessionId]` routes so switching sessions does not re-run
 * this load.
 */
const WORKBENCH_SESSION_LIST_TIMEOUT_MS = 800;

export const load: LayoutServerLoad = async ({ cookies, locals, url, params, route }) => {
  const workspaceIdParam = params.workspaceId ?? null;
  // /:workspaceId/... — key only on workspaceId so session switches stay cheap.
  if (workspaceIdParam) {
    return loadWorkspaceRailShell({
      cookies,
      workspaceIdParam,
      protocol: url.protocol,
      authorizedWorkspaceId: locals?.workspaceId ?? null,
    });
  }

  // Legacy /sessions and /sessions/[sessionId] share one rail. Key on route.id
  // (stable across session switches) instead of url.pathname.
  const legacySessionsRoute =
    route.id === "/(workbench)/sessions" || route.id === "/(workbench)/sessions/[sessionId]";
  if (legacySessionsRoute) {
    return loadLegacySessionsShell({
      cookies,
      protocol: url.protocol,
      preferredWorkspaceSlug: url.searchParams.get("workspace") ?? null,
      authorizedWorkspaceId: locals?.workspaceId ?? null,
    });
  }

  const isWorkspaceDirectory = url.pathname === "/";
  const selectedSessionId = workbenchSessionIdFromPath(url.pathname);
  const sessionsPath = workbenchSessionsPathFromPathname(url.pathname);
  const projectedSelectedSession = selectedSessionId
    ? getProjectedManagedSessionForCockpit(selectedSessionId)
    : null;
  const layout = loadShellWorkspaceLayout({
    cookies,
    pathname: url.pathname,
    protocol: url.protocol,
    preferredWorkspaceId:
      sessionsPath === "/sessions" && projectedSelectedSession
        ? workspaceIdForWorkbenchSession(projectedSelectedSession)
        : null,
    preferredWorkspaceSlug: url.searchParams.get("workspace") ?? null,
    authorizedWorkspaceId: locals?.workspaceId ?? null,
  });
  const activeWorkspaceId = layout.activeWorkspace?.id ?? null;
  const managedSessions =
    !isWorkspaceDirectory && activeWorkspaceId
      ? await loadWorkbenchManagedSessions(activeWorkspaceId)
      : { available: true, controlAvailable: false, sessions: [] as never[] };
  const selectedSession = selectedSessionId
    ? (managedSessions.sessions.find((session) => session.sessionId === selectedSessionId) ??
      (managedSessions.controlAvailable ? null : projectedSelectedSession))
    : null;
  const db = getDatabase();
  const projectedSessions = workspaceSessionsForWorkbench(
    managedSessions.sessions,
    layout.activeWorkspace?.id,
  );
  if (
    selectedSession &&
    workspaceIdForWorkbenchSession(selectedSession) === activeWorkspaceId &&
    !projectedSessions.some((session) => session.sessionId === selectedSession.sessionId)
  ) {
    projectedSessions.unshift(selectedSession);
  }
  const sessions = loadConversationSummaries(db, projectedSessions);
  const pendingAsk = layout.activeWorkspace
    ? loadPendingWorkbenchAsk(db, layout.activeWorkspace.id)
    : null;
  return {
    ...layout,
    pendingAsk,
    sessions,
    sessionsAvailable: managedSessions.available,
    sessionControlAvailable: managedSessions.controlAvailable,
  };
};

async function loadWorkspaceRailShell(input: {
  cookies: Parameters<LayoutServerLoad>[0]["cookies"];
  workspaceIdParam: string;
  protocol: string;
  authorizedWorkspaceId: string | null;
}) {
  const layout = loadShellWorkspaceLayout({
    cookies: input.cookies,
    pathname: `/${encodeURIComponent(input.workspaceIdParam)}`,
    protocol: input.protocol,
    preferredWorkspaceId: null,
    preferredWorkspaceSlug: input.workspaceIdParam,
    authorizedWorkspaceId: input.authorizedWorkspaceId,
  });
  const activeWorkspaceId = layout.activeWorkspace?.id ?? null;
  const managedSessions = activeWorkspaceId
    ? await loadWorkbenchManagedSessions(activeWorkspaceId)
    : { available: true, controlAvailable: false, sessions: [] as never[] };
  const db = getDatabase();
  const sessions = loadConversationSummaries(
    db,
    workspaceSessionsForWorkbench(managedSessions.sessions, activeWorkspaceId),
  );
  const pendingAsk = layout.activeWorkspace
    ? loadPendingWorkbenchAsk(db, layout.activeWorkspace.id)
    : null;
  return {
    ...layout,
    pendingAsk,
    sessions,
    sessionsAvailable: managedSessions.available,
    sessionControlAvailable: managedSessions.controlAvailable,
  };
}

async function loadLegacySessionsShell(input: {
  cookies: Parameters<LayoutServerLoad>[0]["cookies"];
  protocol: string;
  preferredWorkspaceSlug: string | null;
  authorizedWorkspaceId: string | null;
}) {
  // Pathname is intentionally the stable `/sessions` prefix so shell resolution
  // does not depend on the selected session id.
  const layout = loadShellWorkspaceLayout({
    cookies: input.cookies,
    pathname: "/sessions",
    protocol: input.protocol,
    preferredWorkspaceId: null,
    preferredWorkspaceSlug: input.preferredWorkspaceSlug,
    authorizedWorkspaceId: input.authorizedWorkspaceId,
  });
  const activeWorkspaceId = layout.activeWorkspace?.id ?? null;
  const managedSessions = activeWorkspaceId
    ? await loadWorkbenchManagedSessions(activeWorkspaceId)
    : { available: true, controlAvailable: false, sessions: [] as never[] };
  const db = getDatabase();
  const sessions = loadConversationSummaries(
    db,
    workspaceSessionsForWorkbench(managedSessions.sessions, activeWorkspaceId),
  );
  const pendingAsk = layout.activeWorkspace
    ? loadPendingWorkbenchAsk(db, layout.activeWorkspace.id)
    : null;
  return {
    ...layout,
    pendingAsk,
    sessions,
    sessionsAvailable: managedSessions.available,
    sessionControlAvailable: managedSessions.controlAvailable,
  };
}

async function loadWorkbenchManagedSessions(workspaceId: string) {
  const projected = listProjectedManagedSessionsForCockpit({ workspaceId });
  // Prefer the local rail for every workbench navigation/invalidation. Waiting
  // on live `session.list` (up to WORKBENCH_SESSION_LIST_TIMEOUT_MS) made each
  // session switch feel like a full reload whenever layout re-ran.
  if (projected.sessions.length > 0) return projected;
  const live = await listManagedSessionsForCockpit({
    scope: { kind: "workspace", workspaceId },
    workspaceId,
    timeoutMs: WORKBENCH_SESSION_LIST_TIMEOUT_MS,
  });
  if (live.available || live.sessions.length > 0) return live;
  return projected;
}
