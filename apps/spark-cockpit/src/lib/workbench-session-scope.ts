export type WorkbenchSessionScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "daemon"; daemonId: string; daemonLabel?: string }
  | { kind: "unknown" };

export interface WorkbenchSessionScopeLike {
  workspaceId?: string;
  scope?:
    | { kind: "workspace"; workspaceId: string }
    | { kind: "daemon"; daemonId?: string; daemonLabel?: string }
    | null;
}

/**
 * Read the canonical scope when present and fall back to the legacy
 * workspaceId field. A legacy record is never guessed to be daemon-global:
 * only an explicit daemon scope is classified as daemon-owned so Cockpit can
 * reject it at the workspace boundary.
 */
export function workbenchSessionScope(session: WorkbenchSessionScopeLike): WorkbenchSessionScope {
  if (session.scope?.kind === "workspace" && session.scope.workspaceId.trim()) {
    return { kind: "workspace", workspaceId: session.scope.workspaceId.trim() };
  }
  if (session.scope?.kind === "daemon") {
    const daemonId = session.scope.daemonId?.trim() || "local";
    const daemonLabel = session.scope.daemonLabel?.trim();
    return {
      kind: "daemon",
      daemonId,
      ...(daemonLabel ? { daemonLabel } : {}),
    };
  }

  const workspaceId = session.workspaceId?.trim();
  return workspaceId ? { kind: "workspace", workspaceId } : { kind: "unknown" };
}

export function isSessionVisibleInWorkbenchRail(
  session: WorkbenchSessionScopeLike,
  activeWorkspaceId: string | null | undefined,
) {
  const scope = workbenchSessionScope(session);
  // Cockpit is workspace-scoped. Daemon-scoped ("global") conversations are
  // managed through the session tool / TUI and are not surfaced in the
  // workbench rail.
  return scope.kind === "workspace" && scope.workspaceId === activeWorkspaceId;
}

export function workspaceIdForWorkbenchSession(session: WorkbenchSessionScopeLike) {
  const scope = workbenchSessionScope(session);
  return scope.kind === "workspace" ? scope.workspaceId : null;
}

/**
 * Project daemon registry records onto the Cockpit workbench boundary.
 *
 * The daemon registry also contains daemon-global sessions used by the TUI and
 * session tools. Keeping the projection here prevents those records from
 * leaking back into a Web surface when a caller forwards an unscoped
 * `session.list` response.
 */
export function workspaceSessionsForWorkbench<T extends WorkbenchSessionScopeLike>(
  sessions: readonly T[],
  activeWorkspaceId: string | null | undefined,
): T[] {
  return sessions.filter((session) => {
    const scope = workbenchSessionScope(session);
    return scope.kind === "workspace" && scope.workspaceId === activeWorkspaceId;
  });
}
