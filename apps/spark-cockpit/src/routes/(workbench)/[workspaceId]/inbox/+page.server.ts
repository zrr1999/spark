import { getDatabase } from "$lib/server/db";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const db = getDatabase();
  const workspace = requireWorkspaceByRouteId(db, params.workspaceId);

  const inboxItems = db
    .prepare(
      `SELECT ii.id,
              ii.kind,
              ii.title,
              ii.summary,
              ii.urgency,
              ii.status,
              ii.resolved_as AS resolvedAs,
              ii.created_at AS createdAt,
              ii.updated_at AS updatedAt,
              hr.id AS humanRequestId,
              hr.runtime_request_id AS runtimeRequestId,
              hr.kind AS requestKind,
              hr.status AS requestStatus,
              p.id AS projectId,
              p.name AS projectName,
              rb.display_name AS runtimeWorkspaceName,
              rc.name AS runtimeName,
              latest_response.id AS latestResponseId,
              latest_response.status AS latestResponseStatus,
              latest_response.acked_at AS latestResponseAckedAt
       FROM inbox_items ii
       LEFT JOIN human_requests hr ON hr.id = ii.human_request_id
       LEFT JOIN projects p ON p.id = ii.project_id
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = hr.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN (
         SELECT human_request_id, id, status, acked_at, MAX(created_at) AS created_at
         FROM human_responses
         GROUP BY human_request_id
       ) latest_response ON latest_response.human_request_id = hr.id
       WHERE ii.workspace_id = ?
       ORDER BY CASE ii.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
                CASE ii.urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                ii.created_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    kind: string;
    title: string;
    summary: string | null;
    urgency: string;
    status: string;
    resolvedAs: string | null;
    createdAt: string;
    updatedAt: string;
    humanRequestId: string | null;
    runtimeRequestId: string | null;
    requestKind: string | null;
    requestStatus: string | null;
    projectId: string | null;
    projectName: string | null;
    runtimeWorkspaceName: string | null;
    runtimeName: string | null;
    latestResponseId: string | null;
    latestResponseStatus: string | null;
    latestResponseAckedAt: string | null;
  }>;

  const counts = inboxItems.reduce(
    (acc, item) => {
      if (item.status === "pending") {
        acc.pending += 1;
      } else if (item.status === "resolved") {
        acc.resolved += 1;
      } else if (item.status === "archived") {
        acc.archived += 1;
      }
      return acc;
    },
    { pending: 0, resolved: 0, archived: 0 },
  );

  return { workspace, inboxItems, counts };
};
