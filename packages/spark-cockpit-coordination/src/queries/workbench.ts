import type { DatabaseSync } from "node:sqlite";
import { loadProjectCockpit } from "../project-cockpit.ts";
import { loadWorkspaceServerControl } from "../projection-services.ts";
import { loadWorkspaceByRouteId } from "../routing.ts";
import { hashSecret } from "../security.ts";

import {
  resolvePendingWorkspaceBinding,
  resolvePendingWorkspaceRuntimeState,
} from "./inbox-and-workspace.ts";
import type { PendingWorkspaceBindingSetup, WorkbenchWorkspaceSummary } from "./types.ts";
import {
  countConnectedRuntimeSessions,
  listAllRuntimeWorkspaceBindings,
  listOwnerRuntimeConnections,
  listOwnerRuntimeWorkspaceBindings,
  listRecentWorkspaceEvents,
  listWorkspaceLeases,
  loadWorkspaceFullByRouteId,
  workspaceIdFromPath,
} from "./helpers.ts";

export function loadWorkbenchLayout(
  db: DatabaseSync,
  pathname: string,
  options: { preferredWorkspaceSlug?: string | null; authorizedWorkspaceId?: string | null } = {},
) {
  const workspaces = db
    .prepare(
      `SELECT w.id,
              w.slug,
              w.name,
              rwb.local_path AS localPath
       FROM workspaces w
       LEFT JOIN workspace_leases wob
         ON wob.workspace_id = w.id AND wob.ended_at IS NULL
       LEFT JOIN runtime_workspace_bindings rwb
         ON rwb.id = wob.runtime_workspace_binding_id
       WHERE w.status = 'active'
         AND (? IS NULL OR w.id = ?)
       ORDER BY w.updated_at DESC, w.created_at DESC`,
    )
    .all(
      options.authorizedWorkspaceId ?? null,
      options.authorizedWorkspaceId ?? null,
    ) as unknown as WorkbenchWorkspaceSummary[];

  const workspaceId = workspaceIdFromPath(pathname);
  const loadedPathWorkspace = workspaceId
    ? (loadWorkspaceByRouteId(db, workspaceId) ?? null)
    : null;
  const pathWorkspace =
    loadedPathWorkspace &&
    (!options.authorizedWorkspaceId || loadedPathWorkspace.id === options.authorizedWorkspaceId)
      ? loadedPathWorkspace
      : null;
  const preferredSlug = options.preferredWorkspaceSlug?.trim() || null;
  const preferredWorkspace = preferredSlug
    ? (workspaces.find((workspace) => workspace.slug === preferredSlug) ??
      (options.authorizedWorkspaceId ? null : loadWorkspaceByRouteId(db, preferredSlug)) ??
      null)
    : null;
  const activeWorkspace =
    workbenchWorkspaceSummary(pathWorkspace, workspaces) ??
    workbenchWorkspaceSummary(preferredWorkspace, workspaces) ??
    workspaces[0] ??
    null;
  return { activeWorkspace, workspaces };
}

function workbenchWorkspaceSummary(
  workspace: { id: string; slug: string; name: string; localPath?: string | null } | null,
  workspaces: WorkbenchWorkspaceSummary[],
): WorkbenchWorkspaceSummary | null {
  if (!workspace) return null;
  const fromList = workspaces.find((item) => item.id === workspace.id);
  if (fromList) return fromList;
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    localPath: workspace.localPath ?? null,
  };
}

export function loadWorkbenchHome(
  db: DatabaseSync,
  input: {
    forceWorkspaceCreate: boolean;
    pendingWorkspaceSetup: PendingWorkspaceBindingSetup | null;
    authorizedWorkspaceId?: string | null;
  },
) {
  const workspaces = db
    .prepare(
      `SELECT w.id,
              w.slug,
              w.name,
              w.description,
              w.status,
              w.created_at AS createdAt,
              w.updated_at AS updatedAt,
              COUNT(DISTINCT p.id) AS projectCount,
              COUNT(DISTINCT CASE WHEN ii.status = 'pending' THEN ii.id END) AS pendingInboxCount,
              COUNT(DISTINCT a.id) AS artifactCount,
              rb.display_name AS bindingName,
              rb.status AS bindingStatus,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus,
              wps.profile_name AS profileName,
              wps.source_kind AS profileSourceKind
       FROM workspaces w
       LEFT JOIN projects p ON p.workspace_id = w.id
       LEFT JOIN inbox_items ii ON ii.workspace_id = w.id
       LEFT JOIN artifacts a
         ON a.workspace_id = w.id
        AND a.kind IN ('issue', 'pr', 'preview')
       LEFT JOIN workspace_leases wob
         ON wob.workspace_id = w.id
        AND wob.ended_at IS NULL
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN workspace_profile_sources wps ON wps.workspace_id = w.id
       WHERE w.status = 'active'
         AND (? IS NULL OR w.id = ?)
       GROUP BY w.id
       ORDER BY w.updated_at DESC, w.created_at DESC`,
    )
    .all(input.authorizedWorkspaceId ?? null, input.authorizedWorkspaceId ?? null) as Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
    projectCount: number;
    pendingInboxCount: number;
    artifactCount: number;
    bindingName: string | null;
    bindingStatus: string | null;
    runtimeName: string | null;
    runtimeStatus: string | null;
    profileName: string | null;
    profileSourceKind: string | null;
  }>;

  return {
    workspaces: input.forceWorkspaceCreate ? [] : workspaces,
    redirectWorkspace: workspaces.length > 0 && !input.forceWorkspaceCreate ? workspaces[0] : null,
    runnerBindings: listAllRuntimeWorkspaceBindings(db),
    ownerBindings: listWorkspaceLeases(db),
    targetRunnerBinding: input.pendingWorkspaceSetup
      ? resolvePendingWorkspaceBinding(db, input.pendingWorkspaceSetup)
      : null,
    pendingRuntimeConnection: input.pendingWorkspaceSetup
      ? resolvePendingWorkspaceRuntimeState(db, input.pendingWorkspaceSetup)
      : null,
  };
}

export function loadWorkspaceDashboard(db: DatabaseSync, workspaceRouteId: string) {
  const workspace = loadWorkspaceFullByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
  const pendingInboxCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM inbox_items
         WHERE workspace_id = ? AND status = 'pending'`,
      )
      .get(workspace.id) as { count: number }
  ).count;
  return {
    workspaces: [workspace],
    pendingInboxCount,
    workspaceControl: loadWorkspaceServerControl(db, workspace.id),
    // A workspace page describes its active origin lease, not every daemon that has
    // ever connected to this Cockpit. Global runtime inventory belongs on the
    // registration/binding surface; mixing it into workspace health makes an
    // unrelated online daemon look capable of controlling this workspace.
    runnerConnections: listOwnerRuntimeConnections(db, workspace.id),
    runnerBindings: listOwnerRuntimeWorkspaceBindings(db, workspace.id),
    ownerBindings: listWorkspaceLeases(db, workspace.id),
    recentEvents: listRecentWorkspaceEvents(db, workspace.id),
    connectedSessionCount: countConnectedRuntimeSessions(db),
  };
}

export function loadProjectsPage(db: DatabaseSync, workspaceRouteId: string) {
  const workspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
  const projects = db
    .prepare(
      `SELECT p.id,
              p.slug,
              p.name,
              p.description,
              p.status,
              p.created_at AS createdAt,
              p.updated_at AS updatedAt,
              COUNT(DISTINCT ii.id) FILTER (WHERE ii.status = 'pending') AS pendingInboxCount,
              COUNT(DISTINCT mi.id) FILTER (WHERE mi.status = 'running') AS runningInvocationCount,
              COUNT(DISTINCT a.id) AS artifactCount
       FROM projects p
       LEFT JOIN inbox_items ii ON ii.project_id = p.id
       LEFT JOIN mirrored_invocations mi ON mi.project_id = p.id
       LEFT JOIN artifacts a
         ON a.project_id = p.id
        AND a.kind IN ('issue', 'pr', 'preview')
       WHERE p.workspace_id = ?
       GROUP BY p.id
       ORDER BY p.updated_at DESC, p.created_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
    pendingInboxCount: number;
    runningInvocationCount: number;
    artifactCount: number;
  }>;
  return { workspace, projects };
}

export function loadProjectPage(db: DatabaseSync, workspaceRouteId: string, projectId: string) {
  const workspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
  const cockpit = loadProjectCockpit(db, projectId);
  if (!cockpit || cockpit.project.workspaceId !== workspace.id) return null;
  return cockpit;
}

export function requireProjectForWorkspace(
  db: DatabaseSync,
  projectId: string,
  workspaceId: string,
) {
  const project = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId
       FROM projects
       WHERE id = ?
       LIMIT 1`,
    )
    .get(projectId) as { id: string; workspaceId: string } | undefined;
  return project && project.workspaceId === workspaceId ? project : null;
}

export function getCurrentUserIdBySessionToken(db: DatabaseSync, sessionToken: string | null) {
  if (!sessionToken) return null;
  const session = db
    .prepare(
      `SELECT user_id AS userId
       FROM sessions
       WHERE token_hash = ? AND revoked_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(hashSecret(sessionToken)) as { userId: string } | undefined;
  return session?.userId ?? null;
}
