import type { DatabaseSync } from "node:sqlite";

export interface WorkspaceRouteTarget {
  slug: string;
}

export interface RouteWorkspace {
  id: string;
  slug: string;
  name: string;
}

export function loadWorkspaceByRouteId(db: DatabaseSync, workspaceId: string) {
  return db
    .prepare(
      `SELECT id, slug, name
       FROM workspaces
       WHERE status = 'active'
         AND (slug = ? OR id = ?)
       LIMIT 1`,
    )
    .get(workspaceId, workspaceId) as RouteWorkspace | undefined;
}

export function loadLatestWorkspace(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT id, slug, name
       FROM workspaces
       WHERE status = 'active'
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
    )
    .get() as RouteWorkspace | undefined;
}

export function workspacePath(workspace: WorkspaceRouteTarget, suffix = "") {
  return `/${encodeURIComponent(workspace.slug)}${normalizeSuffix(suffix)}`;
}

function normalizeSuffix(suffix: string) {
  if (!suffix) {
    return "";
  }
  return suffix.startsWith("/") ? suffix : `/`;
}
