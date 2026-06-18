import { getDatabase } from "$lib/server/db";
import { loadWorkspaceByRouteId } from "$lib/server/workspace-routing";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ url }) => {
  const db = getDatabase();
  const workspaces = db
    .prepare(
      `SELECT id, slug, name
       FROM workspaces
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 8`,
    )
    .all() as Array<{
    id: string;
    slug: string;
    name: string;
  }>;

  const workspaceId = getWorkspaceId(url.pathname);
  const activeWorkspace = workspaceId ? (loadWorkspaceByRouteId(db, workspaceId) ?? null) : null;

  return {
    activeWorkspace,
    workspaces,
  };
};

const reservedTopLevelSegments = new Set([
  "api",
  "setup",
  "logout",
  "workspaces",
  "settings",
  "agents",
  "projects",
  "inbox",
  "repos",
  "artifacts",
]);

function getWorkspaceId(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment || reservedTopLevelSegments.has(segment)) {
    return null;
  }
  return decodeURIComponent(segment);
}
