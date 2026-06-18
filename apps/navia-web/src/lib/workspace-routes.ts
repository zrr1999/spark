export interface WorkspaceRouteTarget {
  slug: string;
}

export function workspacePath(workspace: WorkspaceRouteTarget, suffix = "") {
  return `/${encodeURIComponent(workspace.slug)}${normalizeSuffix(suffix)}`;
}

function normalizeSuffix(suffix: string) {
  if (!suffix) {
    return "";
  }
  return suffix.startsWith("/") ? suffix : `/${suffix}`;
}
