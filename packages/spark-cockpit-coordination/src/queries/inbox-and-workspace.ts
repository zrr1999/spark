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
  PendingWorkspaceBindingSetup,
  PendingWorkspaceRuntimeState,
  RuntimeWorkspaceBindingView,
} from "./types.ts";
import {
  countConnectedRuntimeSessions,
  findLatestWorkspaceBindingForRuntime,
  findMatchingWorkspaceBinding,
  findOnlyAvailableWorkspaceBindingForRuntime,
  listOwnerRuntimeConnections,
  listOwnerRuntimeWorkspaceBindings,
  readActiveOwnerLocalPath,
  readEnrollmentRuntimeId,
} from "./helpers.ts";

export function loadInboxPage(db: DatabaseSync, workspaceRouteId: string) {
  const workspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
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
              latest_response.acked_at AS latestResponseAckedAt,
              COALESCE(
                CASE
                  WHEN json_valid(hr.context_json)
                  THEN CAST(json_extract(hr.context_json, '$.sessionId') AS TEXT)
                  ELSE NULL
                END,
                CASE
                  WHEN json_valid(c.payload_json)
                  THEN CAST(json_extract(c.payload_json, '$.payload.target.sessionId') AS TEXT)
                  ELSE NULL
                END
              ) AS sessionId
       FROM inbox_items ii
       LEFT JOIN human_requests hr ON hr.id = ii.human_request_id
       LEFT JOIN commands c
         ON c.id = CASE
           WHEN json_valid(hr.context_json)
           THEN CAST(json_extract(hr.context_json, '$.commandId') AS TEXT)
           ELSE NULL
         END
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
    sessionId: string | null;
  }>;
  const counts = inboxItems.reduce(
    (acc, item) => {
      if (item.status === "pending") acc.pending += 1;
      else if (item.status === "resolved") acc.resolved += 1;
      else if (item.status === "archived") acc.archived += 1;
      return acc;
    },
    { pending: 0, resolved: 0, archived: 0 },
  );
  return { workspace, inboxItems, counts };
}

export type HumanQuestion = {
  id: string;
  type: "single" | "multi" | "freeform" | "preview";
  prompt: string;
  required?: boolean;
  /** Option identity matches `spark-protocol` ask option `value`. */
  options?: Array<{ value: string; label: string; description?: string; preview?: string }>;
};

export type InboxDetailRow = {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  kind: string;
  title: string;
  summary: string | null;
  urgency: string;
  status: string;
  resolvedAs: string | null;
  createdAt: string;
  updatedAt: string;
  humanRequestId: string;
  runtimeRequestId: string;
  requestKind: string;
  requestTitle: string;
  prompt: string;
  questionsJson: string;
  contextJson: string;
  requestStatus: string;
  projectId: string | null;
  projectName: string | null;
  runtimeWorkspaceBindingId: string;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
  sessionId: string | null;
};

export function loadInboxDetail(db: DatabaseSync, inboxItemId: string) {
  return db
    .prepare(
      `SELECT ii.id,
              ii.workspace_id AS workspaceId,
              w.slug AS workspaceSlug,
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
              hr.title AS requestTitle,
              hr.prompt,
              hr.questions_json AS questionsJson,
              hr.context_json AS contextJson,
              hr.status AS requestStatus,
              p.id AS projectId,
              p.name AS projectName,
              rb.id AS runtimeWorkspaceBindingId,
              rb.display_name AS runtimeWorkspaceName,
              rc.name AS runtimeName,
              COALESCE(
                CASE
                  WHEN json_valid(hr.context_json)
                  THEN CAST(json_extract(hr.context_json, '$.sessionId') AS TEXT)
                  ELSE NULL
                END,
                CASE
                  WHEN json_valid(c.payload_json)
                  THEN CAST(json_extract(c.payload_json, '$.payload.target.sessionId') AS TEXT)
                  ELSE NULL
                END
              ) AS sessionId
       FROM inbox_items ii
       JOIN workspaces w ON w.id = ii.workspace_id
       JOIN human_requests hr ON hr.id = ii.human_request_id
       LEFT JOIN projects p ON p.id = ii.project_id
       JOIN runtime_workspace_bindings rb ON rb.id = hr.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN commands c
         ON c.id = CASE
           WHEN json_valid(hr.context_json)
           THEN CAST(json_extract(hr.context_json, '$.commandId') AS TEXT)
           ELSE NULL
         END
       WHERE ii.id = ?
       LIMIT 1`,
    )
    .get(inboxItemId) as InboxDetailRow | undefined;
}

export function loadInboxDetailPage(
  db: DatabaseSync,
  workspaceRouteId: string,
  inboxItemId: string,
) {
  const workspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
  const detail = loadInboxDetail(db, inboxItemId);
  if (!detail || detail.workspaceId !== workspace.id) return null;
  const latestResponses = db
    .prepare(
      `SELECT id,
              answer_json AS answerJson,
              status,
              delivery_attempt_count AS deliveryAttemptCount,
              last_delivery_at AS lastDeliveryAt,
              acked_at AS ackedAt,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM human_responses
       WHERE human_request_id = ?
       ORDER BY created_at DESC`,
    )
    .all(detail.humanRequestId) as Array<{
    id: string;
    answerJson: string;
    status: string;
    deliveryAttemptCount: number;
    lastDeliveryAt: string | null;
    ackedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  return { workspace, detail, latestResponses };
}

export function loadReposPage(db: DatabaseSync, workspaceRouteId: string) {
  const workspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
  const resources = db
    .prepare(
      `SELECT r.id,
              r.kind,
              r.name,
              r.uri,
              r.status,
              r.config_json AS configJson,
              r.created_at AS createdAt,
              r.updated_at AS updatedAt,
              COUNT(pr.project_id) AS projectCount
       FROM resources r
       LEFT JOIN project_resources pr ON pr.resource_id = r.id
       WHERE r.workspace_id = ?
       GROUP BY r.id
       ORDER BY CASE r.status WHEN 'available' THEN 0 WHEN 'degraded' THEN 1 WHEN 'unavailable' THEN 2 ELSE 3 END,
                r.updated_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    kind: string;
    name: string;
    uri: string | null;
    status: string;
    configJson: string;
    createdAt: string;
    updatedAt: string;
    projectCount: number;
  }>;
  const counts = resources.reduce(
    (acc, resource) => {
      acc.total += 1;
      if (resource.kind === "repo") acc.repo += 1;
      if (resource.status === "available") acc.available += 1;
      if (resource.status === "archived") acc.archived += 1;
      return acc;
    },
    { total: 0, repo: 0, available: 0, archived: 0 },
  );
  return { workspace, resources, counts };
}

export function createWorkspaceResource(
  db: DatabaseSync,
  input: { workspaceId: string; kind: string; name: string; uri: string | null; notes: string },
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO resources
      (id, workspace_id, kind, name, uri, status, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
  ).run(
    createId("res"),
    input.workspaceId,
    input.kind,
    input.name,
    input.uri,
    JSON.stringify({ notes: input.notes || undefined }),
    now,
    now,
  );
}

export function updateWorkspaceResourceStatus(
  db: DatabaseSync,
  input: { workspaceId: string; resourceId: string; status: "archived" | "available" },
) {
  db.prepare(
    "UPDATE resources SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
  ).run(input.status, new Date().toISOString(), input.resourceId, input.workspaceId);
}

export function loadWorkspaceSettings(db: DatabaseSync, workspaceRouteId: string) {
  const routeWorkspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!routeWorkspace) return null;
  return db
    .prepare(
      `SELECT w.id,
              w.slug,
              w.name,
              w.description,
              w.status,
              w.settings_json AS settingsJson,
              w.created_at AS createdAt,
              w.updated_at AS updatedAt,
              rwb.local_path AS localPath
       FROM workspaces w
       LEFT JOIN workspace_leases wob
         ON wob.workspace_id = w.id AND wob.ended_at IS NULL
       LEFT JOIN runtime_workspace_bindings rwb
         ON rwb.id = wob.runtime_workspace_binding_id
       WHERE w.id = ?
       LIMIT 1`,
    )
    .get(routeWorkspace.id) as
    | {
        id: string;
        slug: string;
        name: string;
        description: string | null;
        status: "active" | "archived";
        settingsJson: string;
        createdAt: string;
        updatedAt: string;
        localPath: string | null;
      }
    | undefined;
}

export function updateWorkspaceSettings(
  db: DatabaseSync,
  input: { workspaceId: string; name: string; slug: string; description: string | null },
): "ok" | "duplicate_slug" | "reserved_slug" {
  if (isReservedWorkbenchPathSegment(input.slug)) return "reserved_slug";
  const duplicate = db
    .prepare(
      `SELECT id
       FROM workspaces
       WHERE slug = ?
         AND id != ?
         AND status = 'active'
       LIMIT 1`,
    )
    .get(input.slug, input.workspaceId) as { id: string } | undefined;
  if (duplicate) return "duplicate_slug";
  const now = new Date().toISOString();
  const displayName = resolveWorkspaceDirectoryDisplayName({
    localPath: readActiveOwnerLocalPath(db, input.workspaceId),
    displayName: input.name,
  });
  db.prepare(
    `UPDATE workspaces
     SET name = ?,
         slug = ?,
         description = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(displayName, input.slug, input.description, now, input.workspaceId);
  db.prepare(
    `UPDATE runtime_workspace_bindings
     SET display_name = ?,
         updated_at = ?
     WHERE id = (
       SELECT runtime_workspace_binding_id
       FROM workspace_leases
       WHERE workspace_id = ? AND ended_at IS NULL
       LIMIT 1
     )`,
  ).run(displayName, now, input.workspaceId);
  return "ok";
}

export function loadWorkspaceRegistrationPage(db: DatabaseSync, workspaceRouteId: string) {
  const workspace = loadWorkspaceRegistration(db, workspaceRouteId);
  if (!workspace) return null;
  return {
    workspace,
    runnerConnections: listOwnerRuntimeConnections(db, workspace.id),
    runnerBindings: listOwnerRuntimeWorkspaceBindings(db, workspace.id),
    enrollmentTokens: listRuntimeEnrollmentTokens(db, {
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
    }),
    connectedSessionCount: countConnectedRuntimeSessions(db),
  };
}

export function loadWorkspaceRegistration(db: DatabaseSync, workspaceRouteId: string) {
  const routeWorkspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!routeWorkspace) return null;
  return db
    .prepare(
      `SELECT w.id,
              w.slug,
              w.name,
              w.description,
              w.status,
              w.created_at AS createdAt,
              w.updated_at AS updatedAt,
              rwb.local_path AS localPath
       FROM workspaces w
       LEFT JOIN workspace_leases wob
         ON wob.workspace_id = w.id AND wob.ended_at IS NULL
       LEFT JOIN runtime_workspace_bindings rwb
         ON rwb.id = wob.runtime_workspace_binding_id
       WHERE w.id = ?
       LIMIT 1`,
    )
    .get(routeWorkspace.id) as
    | {
        id: string;
        slug: string;
        name: string;
        description: string | null;
        status: "active" | "archived";
        createdAt: string;
        updatedAt: string;
        localPath: string | null;
      }
    | undefined;
}

export function resolvePendingWorkspaceBinding(
  db: DatabaseSync,
  setup: PendingWorkspaceBindingSetup,
): RuntimeWorkspaceBindingView | null {
  if (setup.enrollmentTokenId) {
    const runtimeId = readEnrollmentRuntimeId(db, setup.enrollmentTokenId);
    if (!runtimeId) return null;
    return (
      findMatchingWorkspaceBinding(db, setup, runtimeId) ??
      findOnlyAvailableWorkspaceBindingForRuntime(db, runtimeId)
    );
  }
  return findMatchingWorkspaceBinding(db, setup, null);
}

/**
 * Report a token-enrolled registration whose runtime finished HTTP registration
 * but is not yet online/available, so {@link resolvePendingWorkspaceBinding}
 * returns `null` and the setup flow would otherwise poll silently forever.
 * Returns `null` when there is nothing registered yet, or when the binding is
 * already online+available (the ready path handled by the target binding).
 */
export function resolvePendingWorkspaceRuntimeState(
  db: DatabaseSync,
  setup: PendingWorkspaceBindingSetup,
): PendingWorkspaceRuntimeState | null {
  if (!setup.enrollmentTokenId) return null;
  const runtimeId = readEnrollmentRuntimeId(db, setup.enrollmentTokenId);
  if (!runtimeId) return null;
  const binding = findLatestWorkspaceBindingForRuntime(db, runtimeId);
  if (!binding) return null;
  if (binding.runtimeStatus === "online" && binding.status === "available") return null;
  return {
    runtimeName: binding.runtimeName,
    runtimeStatus: binding.runtimeStatus,
    bindingStatus: binding.status,
    bindingDisplayName: binding.displayName,
  };
}
