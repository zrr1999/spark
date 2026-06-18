import { getDatabase } from "$lib/server/db";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const db = getDatabase();
  const workspace = requireWorkspaceByRouteId(db, params.workspaceId);

  const artifacts = db
    .prepare(
      `SELECT a.id,
              a.scope,
              a.kind,
              a.title,
              a.format,
              a.source,
              a.hash,
              a.size_bytes AS sizeBytes,
              a.created_at AS createdAt,
              a.updated_at AS updatedAt,
              p.id AS projectId,
              p.name AS projectName,
              mi.id AS invocationId,
              mi.runtime_invocation_id AS runtimeInvocationId,
              mi.agent_name AS agentName,
              hr.id AS humanRequestId,
              hr.title AS humanRequestTitle,
              rb.display_name AS runtimeWorkspaceName,
              cache.state AS cacheState,
              cache.cache_path AS cachePath,
              COUNT(al.id) AS linkCount
       FROM artifacts a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN mirrored_invocations mi ON mi.id = a.invocation_id
       LEFT JOIN human_requests hr ON hr.id = a.human_request_id
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = a.runtime_workspace_binding_id
       LEFT JOIN artifact_links al ON al.artifact_id = a.id
       LEFT JOIN (
         SELECT artifact_id, state, cache_path, MAX(created_at) AS created_at
         FROM artifact_cache_blobs
         WHERE is_preview = 1 AND state != 'evicted'
         GROUP BY artifact_id
       ) cache ON cache.artifact_id = a.id
       WHERE a.workspace_id = ?
       GROUP BY a.id
       ORDER BY a.created_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    scope: string;
    kind: string;
    title: string;
    format: string;
    source: string;
    hash: string | null;
    sizeBytes: number | null;
    createdAt: string;
    updatedAt: string;
    projectId: string | null;
    projectName: string | null;
    invocationId: string | null;
    runtimeInvocationId: string | null;
    agentName: string | null;
    humanRequestId: string | null;
    humanRequestTitle: string | null;
    runtimeWorkspaceName: string | null;
    cacheState: string | null;
    cachePath: string | null;
    linkCount: number;
  }>;

  const counts = artifacts.reduce(
    (acc, artifact) => {
      acc.total += 1;
      if (artifact.scope === "workspace") {
        acc.workspace += 1;
      }
      if (artifact.scope === "project") {
        acc.project += 1;
      }
      if (artifact.cacheState === "ready") {
        acc.cached += 1;
      }
      return acc;
    },
    { total: 0, workspace: 0, project: 0, cached: 0 },
  );

  return { workspace, artifacts, counts };
};
