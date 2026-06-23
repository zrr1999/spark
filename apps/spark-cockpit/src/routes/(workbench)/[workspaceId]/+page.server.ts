import { error } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { loadWorkspaceServerControl } from "$lib/server/projection-services";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const db = getDatabase();
  const workspace = db
    .prepare(
      `SELECT id, slug, name, description, status, created_at AS createdAt, updated_at AS updatedAt
       FROM workspaces
       WHERE status = 'active' AND (slug = ? OR id = ?)
       LIMIT 1`,
    )
    .get(params.workspaceId, params.workspaceId) as
    | {
        id: string;
        slug: string;
        name: string;
        description: string | null;
        status: string;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;

  if (!workspace) {
    throw error(404, "Workspace not found.");
  }

  const workspaces = [workspace] satisfies Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;

  const runnerConnections = db
    .prepare(
      `SELECT id, installation_id AS installationId, name, status, protocol_version AS protocolVersion,
              last_heartbeat_at AS lastHeartbeatAt, updated_at AS updatedAt
       FROM runtime_connections
       ORDER BY updated_at DESC`,
    )
    .all() as Array<{
    id: string;
    installationId: string | null;
    name: string;
    status: "online" | "offline" | "draining" | "disabled";
    protocolVersion: string | null;
    lastHeartbeatAt: string | null;
    updatedAt: string;
  }>;

  const runnerBindings = db
    .prepare(
      `SELECT rb.id,
              rb.runtime_id AS runtimeId,
              rb.local_workspace_key AS localWorkspaceKey,
              rb.display_name AS displayName,
              rb.status,
              rb.last_snapshot_at AS lastSnapshotAt,
              rb.updated_at AS updatedAt,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM runtime_workspace_bindings rb
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN workspace_owner_bindings wob
         ON wob.runtime_workspace_binding_id = rb.id
        AND wob.ended_at IS NULL
       WHERE wob.workspace_id = ?
       ORDER BY rb.updated_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    runtimeId: string;
    localWorkspaceKey: string;
    displayName: string;
    status: "available" | "indexing" | "degraded" | "unavailable" | "archived";
    lastSnapshotAt: string | null;
    updatedAt: string;
    runtimeName: string;
    runtimeStatus: string;
  }>;

  const ownerBindings = db
    .prepare(
      `SELECT wob.id,
              wob.workspace_id AS workspaceId,
              wob.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              wob.started_at AS startedAt,
              w.name AS workspaceName,
              rb.display_name AS bindingName,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM workspace_owner_bindings wob
       JOIN workspaces w ON w.id = wob.workspace_id
       JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE wob.ended_at IS NULL
         AND wob.workspace_id = ?
       ORDER BY wob.started_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    workspaceId: string;
    runtimeWorkspaceBindingId: string;
    startedAt: string;
    workspaceName: string;
    bindingName: string;
    runtimeName: string;
    runtimeStatus: string;
  }>;

  const recentEvents = db
    .prepare(
      `SELECT id, kind, subject_kind AS subjectKind, subject_id AS subjectId,
              actor_kind AS actorKind, actor_id AS actorId, created_at AS createdAt
       FROM events
       WHERE workspace_id = ?
       ORDER BY created_at DESC
       LIMIT 8`,
    )
    .all(workspace.id) as Array<{
    id: string;
    kind: string;
    subjectKind: string | null;
    subjectId: string | null;
    actorKind: string;
    actorId: string | null;
    createdAt: string;
  }>;

  const connectedSessions = db
    .prepare("SELECT COUNT(*) AS count FROM runtime_sessions WHERE status = 'connected'")
    .get() as { count: number };

  return {
    workspaces,
    workspaceControl: loadWorkspaceServerControl(db, workspace.id),
    runnerConnections,
    runnerBindings,
    ownerBindings,
    recentEvents,
    connectedSessionCount: connectedSessions.count,
  };
};
