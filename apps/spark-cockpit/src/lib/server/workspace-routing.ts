import type { DatabaseSync } from "node:sqlite";
import { error, redirect } from "@sveltejs/kit";
import { workspacePath } from "$lib/workspace-routes";

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

export function requireWorkspaceByRouteId(db: DatabaseSync, workspaceId: string) {
  const workspace = loadWorkspaceByRouteId(db, workspaceId);
  if (!workspace) {
    throw error(404, "Workspace not found.");
  }
  return workspace;
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

export function redirectToLatestWorkspace(db: DatabaseSync, suffix = ""): never {
  const workspace = loadLatestWorkspace(db);
  redirect(303, workspace ? workspacePath(workspace, suffix) : "/");
}
