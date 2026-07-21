import type { DatabaseSync } from "node:sqlite";
import { createId } from "@zendev-lab/spark-protocol";
import { ensureArtifactPreviewCache, readArtifactPreviewContent } from "../artifact-cache.ts";
import { loadProjectCockpit } from "../project-cockpit.ts";
import { loadWorkspaceServerControl } from "../projection-services.ts";
import { listRuntimeEnrollmentTokens } from "../runtime-registration.ts";
import { loadWorkspaceByRouteId } from "../routing.ts";
import { hashSecret } from "../security.ts";
import {
  isReservedWorkbenchPathSegment,
  resolveWorkspaceDirectoryDisplayName,
} from "../workspace-identity.ts";

import type {
  WorkspaceFullRow,
  RuntimeWorkspaceBindingView,
  RuntimeConnectionView,
  LeaseBindingView,
  PendingWorkspaceBindingSetup,
} from "./types.ts";

export function findLatestWorkspaceBindingForRuntime(
  db: DatabaseSync,
  runtimeId: string,
): RuntimeWorkspaceBindingView | null {
  const row = db
    .prepare(
      `SELECT rb.id,
              rb.runtime_id AS runtimeId,
              rb.local_workspace_key AS localWorkspaceKey,
              rb.local_path AS localPath,
              rb.display_name AS displayName,
              rb.status,
              rb.last_snapshot_at AS lastSnapshotAt,
              rb.updated_at AS updatedAt,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM runtime_workspace_bindings rb
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE rb.runtime_id = ?
       ORDER BY rb.updated_at DESC
       LIMIT 1`,
    )
    .get(runtimeId) as RuntimeWorkspaceBindingView | undefined;
  return row ?? null;
}

export function loadWorkspaceFullByRouteId(db: DatabaseSync, workspaceRouteId: string) {
  return db
    .prepare(
      `SELECT id, slug, name, description, status, created_at AS createdAt, updated_at AS updatedAt
       FROM workspaces
       WHERE status = 'active' AND (slug = ? OR id = ?)
       LIMIT 1`,
    )
    .get(workspaceRouteId, workspaceRouteId) as WorkspaceFullRow | undefined;
}

export function listAllRuntimeWorkspaceBindings(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT rb.id,
              rb.runtime_id AS runtimeId,
              rb.local_workspace_key AS localWorkspaceKey,
              rb.local_path AS localPath,
              rb.display_name AS displayName,
              rb.status,
              rb.last_snapshot_at AS lastSnapshotAt,
              rb.updated_at AS updatedAt,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM runtime_workspace_bindings rb
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       ORDER BY rb.updated_at DESC`,
    )
    .all() as unknown as RuntimeWorkspaceBindingView[];
}

export function listOwnerRuntimeWorkspaceBindings(db: DatabaseSync, workspaceId: string) {
  return db
    .prepare(
      `SELECT rb.id,
              rb.runtime_id AS runtimeId,
              rb.local_workspace_key AS localWorkspaceKey,
              rb.local_path AS localPath,
              rb.display_name AS displayName,
              rb.status,
              rb.last_snapshot_at AS lastSnapshotAt,
              rb.updated_at AS updatedAt,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM runtime_workspace_bindings rb
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN workspace_leases wob
         ON wob.runtime_workspace_binding_id = rb.id
        AND wob.ended_at IS NULL
       WHERE wob.workspace_id = ?
       ORDER BY rb.updated_at DESC`,
    )
    .all(workspaceId) as unknown as RuntimeWorkspaceBindingView[];
}

export function listOwnerRuntimeConnections(db: DatabaseSync, workspaceId: string) {
  return db
    .prepare(
      `SELECT DISTINCT rc.id,
              rc.installation_id AS installationId,
              rc.name,
              rc.status,
              rc.protocol_version AS protocolVersion,
              rc.last_heartbeat_at AS lastHeartbeatAt,
              rc.updated_at AS updatedAt
       FROM runtime_connections rc
       JOIN runtime_workspace_bindings rb ON rb.runtime_id = rc.id
       JOIN workspace_leases wob
         ON wob.runtime_workspace_binding_id = rb.id
        AND wob.ended_at IS NULL
       WHERE wob.workspace_id = ?
       ORDER BY rc.updated_at DESC`,
    )
    .all(workspaceId) as unknown as RuntimeConnectionView[];
}

export function listWorkspaceLeases(db: DatabaseSync, workspaceId?: string) {
  const where = workspaceId ? "AND wob.workspace_id = ?" : "";
  const args = workspaceId ? [workspaceId] : [];
  return db
    .prepare(
      `SELECT wob.id,
              wob.workspace_id AS workspaceId,
              wob.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              wob.started_at AS startedAt,
              w.name AS workspaceName,
              rb.display_name AS bindingName,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM workspace_leases wob
       JOIN workspaces w ON w.id = wob.workspace_id
       JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE wob.ended_at IS NULL
         ${where}
       ORDER BY wob.started_at DESC`,
    )
    .all(...args) as unknown as LeaseBindingView[];
}

/** @deprecated Prefer {@link listWorkspaceLeases}. */
export const listOwnerBindings = listWorkspaceLeases;

export function listRecentWorkspaceEvents(db: DatabaseSync, workspaceId: string) {
  return db
    .prepare(
      `SELECT id, kind, subject_kind AS subjectKind, subject_id AS subjectId,
              actor_kind AS actorKind, actor_id AS actorId, created_at AS createdAt
       FROM events
       WHERE workspace_id = ?
       ORDER BY created_at DESC
       LIMIT 8`,
    )
    .all(workspaceId) as Array<{
    id: string;
    kind: string;
    subjectKind: string | null;
    subjectId: string | null;
    actorKind: string;
    actorId: string | null;
    createdAt: string;
  }>;
}

export function countConnectedRuntimeSessions(db: DatabaseSync) {
  const connectedSessions = db
    .prepare("SELECT COUNT(*) AS count FROM runtime_sessions WHERE status = 'connected'")
    .get() as { count: number };
  return connectedSessions.count;
}

export function readEnrollmentRuntimeId(
  db: DatabaseSync,
  enrollmentTokenId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT created_runtime_id AS createdRuntimeId
       FROM runtime_enrollment_tokens
       WHERE id = ?
       LIMIT 1`,
    )
    .get(enrollmentTokenId) as { createdRuntimeId: string | null } | undefined;
  return row?.createdRuntimeId ?? null;
}

export function findMatchingWorkspaceBinding(
  db: DatabaseSync,
  setup: PendingWorkspaceBindingSetup,
  runtimeId: string | null,
): RuntimeWorkspaceBindingView | null {
  const runtimeFilter = runtimeId ? "AND rb.runtime_id = ?" : "";
  const args = runtimeId
    ? [setup.name, setup.slug, runtimeId, setup.name, setup.slug]
    : [setup.name, setup.slug, setup.name, setup.slug];
  const row = db
    .prepare(
      `SELECT rb.id,
              rb.runtime_id AS runtimeId,
              rb.local_workspace_key AS localWorkspaceKey,
              rb.local_path AS localPath,
              rb.display_name AS displayName,
              rb.status,
              rb.last_snapshot_at AS lastSnapshotAt,
              rb.updated_at AS updatedAt,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM runtime_workspace_bindings rb
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE rb.status = 'available'
         AND rc.status = 'online'
         AND (rb.display_name = ? OR rb.local_workspace_key = ?)
         ${runtimeFilter}
       ORDER BY CASE
                  WHEN rb.display_name = ? THEN 0
                  WHEN rb.local_workspace_key = ? THEN 1
                  ELSE 2
                END,
                rb.updated_at DESC
       LIMIT 1`,
    )
    .get(...args) as RuntimeWorkspaceBindingView | undefined;
  return row ?? null;
}

export function findOnlyAvailableWorkspaceBindingForRuntime(
  db: DatabaseSync,
  runtimeId: string,
): RuntimeWorkspaceBindingView | null {
  const rows = db
    .prepare(
      `SELECT rb.id,
              rb.runtime_id AS runtimeId,
              rb.local_workspace_key AS localWorkspaceKey,
              rb.local_path AS localPath,
              rb.display_name AS displayName,
              rb.status,
              rb.last_snapshot_at AS lastSnapshotAt,
              rb.updated_at AS updatedAt,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM runtime_workspace_bindings rb
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE rb.status = 'available'
         AND rc.status = 'online'
         AND rb.runtime_id = ?
       ORDER BY rb.updated_at DESC
       LIMIT 2`,
    )
    .all(runtimeId) as unknown as RuntimeWorkspaceBindingView[];
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

export function readActiveOwnerLocalPath(db: DatabaseSync, workspaceId: string): string | null {
  const row = db
    .prepare(
      `SELECT rwb.local_path AS localPath
       FROM workspace_leases wob
       JOIN runtime_workspace_bindings rwb
         ON rwb.id = wob.runtime_workspace_binding_id
       WHERE wob.workspace_id = ? AND wob.ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { localPath: string | null } | undefined;
  return row?.localPath ?? null;
}

export function workspaceIdFromPath(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment || isReservedWorkbenchPathSegment(segment)) return null;
  return decodeURIComponent(segment);
}
