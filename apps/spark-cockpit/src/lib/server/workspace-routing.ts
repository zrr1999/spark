import type { DatabaseSync } from "node:sqlite";
import { error, redirect } from "@sveltejs/kit";
import {
  loadLatestWorkspace,
  loadWorkspaceByRouteId,
  workspacePath,
  type RouteWorkspace,
} from "@zendev-lab/spark-coordination/routing";

export type { RouteWorkspace };
export { loadLatestWorkspace, loadWorkspaceByRouteId };

export function requireWorkspaceByRouteId(db: DatabaseSync, workspaceId: string) {
  const workspace = loadWorkspaceByRouteId(db, workspaceId);
  if (!workspace) {
    throw error(404, "Workspace not found.");
  }
  return workspace;
}

export function redirectToLatestWorkspace(db: DatabaseSync, suffix = ""): never {
  const workspace = loadLatestWorkspace(db);
  redirect(303, workspace ? workspacePath(workspace, suffix) : "/");
}
