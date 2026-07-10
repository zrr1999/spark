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
 * only an explicit daemon scope can enter the global conversation group.
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
  if (scope.kind === "daemon") return true;
  return scope.kind === "workspace" && scope.workspaceId === activeWorkspaceId;
}

export function workspaceIdForWorkbenchSession(session: WorkbenchSessionScopeLike) {
  const scope = workbenchSessionScope(session);
  return scope.kind === "workspace" ? scope.workspaceId : null;
}

export function daemonIdentityForWorkbenchSession(session: WorkbenchSessionScopeLike) {
  const scope = workbenchSessionScope(session);
  if (scope.kind !== "daemon") return null;
  return {
    id: scope.daemonId,
    label: scope.daemonLabel ?? scope.daemonId,
  };
}
