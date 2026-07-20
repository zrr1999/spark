export interface WorkspaceRouteTarget {
  slug: string;
}

export function workspacePath(workspace: WorkspaceRouteTarget, suffix = "") {
  return `/${encodeURIComponent(workspace.slug)}${normalizeSuffix(suffix)}`;
}

export function workspaceSessionsPath(workspace: WorkspaceRouteTarget) {
  return workspacePath(workspace, "/sessions");
}

export function workspaceSessionPath(workspace: WorkspaceRouteTarget, sessionId: string) {
  return workspacePath(workspace, `/sessions/${encodeURIComponent(sessionId)}`);
}

export function workbenchSessionsPathFromPathname(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "sessions") return "/sessions";
  if (segments[1] === "sessions")
    return `/${encodeURIComponent(decodeSegment(segments[0]!))}/sessions`;
  return null;
}

export function workbenchSessionIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const encodedSessionId =
    segments[0] === "sessions" ? segments[1] : segments[1] === "sessions" ? segments[2] : undefined;
  return encodedSessionId ? decodeSegment(encodedSessionId).trim() || null : null;
}

function normalizeSuffix(suffix: string) {
  if (!suffix) {
    return "";
  }
  return suffix.startsWith("/") ? suffix : `/${suffix}`;
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
