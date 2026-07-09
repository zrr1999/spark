import type { DatabaseSync } from "node:sqlite";
import { createId } from "@zendev-lab/spark-protocol";
import { ensureArtifactPreviewCache, readArtifactPreviewContent } from "./artifact-cache.ts";
import { loadAgentsProductProjection } from "./agents-product.ts";
import { loadProjectCockpit } from "./project-cockpit.ts";
import { loadWorkspaceServerControl } from "./projection-services.ts";
import { listRuntimeEnrollmentTokens } from "./runtime-registration.ts";
import { loadWorkspaceByRouteId } from "./routing.ts";
import { hashSecret } from "./security.ts";

export type RuntimeConnectionStatus = "online" | "offline" | "draining" | "disabled";
export type RuntimeWorkspaceStatus =
  | "available"
  | "indexing"
  | "degraded"
  | "unavailable"
  | "archived";

export interface WorkbenchWorkspaceSummary {
  id: string;
  slug: string;
  name: string;
}

export interface WorkspaceFullRow extends WorkbenchWorkspaceSummary {
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeWorkspaceBindingView {
  id: string;
  runtimeId: string;
  localWorkspaceKey: string;
  displayName: string;
  status: RuntimeWorkspaceStatus;
  lastSnapshotAt: string | null;
  updatedAt: string;
  runtimeName: string;
  runtimeStatus: string;
}

export interface RuntimeConnectionView {
  id: string;
  installationId: string | null;
  name: string;
  status: RuntimeConnectionStatus;
  protocolVersion: string | null;
  lastHeartbeatAt: string | null;
  updatedAt: string;
}

export interface OwnerBindingView {
  id: string;
  workspaceId: string;
  runtimeWorkspaceBindingId: string;
  startedAt: string;
  workspaceName: string;
  bindingName: string;
  runtimeName: string;
  runtimeStatus: string;
}

export interface PendingWorkspaceBindingSetup {
  name: string;
  slug: string;
  enrollmentTokenId?: string;
}

export function loadWorkbenchLayout(db: DatabaseSync, pathname: string) {
  const workspaces = db
    .prepare(
      `SELECT id, slug, name
       FROM workspaces
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 8`,
    )
    .all() as unknown as WorkbenchWorkspaceSummary[];

  const workspaceId = workspaceIdFromPath(pathname);
  const activeWorkspace = workspaceId ? (loadWorkspaceByRouteId(db, workspaceId) ?? null) : null;
  return { activeWorkspace, workspaces };
}

export function loadWorkbenchHome(
  db: DatabaseSync,
  input: {
    forceWorkspaceCreate: boolean;
    pendingWorkspaceSetup: PendingWorkspaceBindingSetup | null;
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
       LEFT JOIN artifacts a ON a.workspace_id = w.id
       LEFT JOIN workspace_owner_bindings wob
         ON wob.workspace_id = w.id
        AND wob.ended_at IS NULL
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN workspace_profile_sources wps ON wps.workspace_id = w.id
       WHERE w.status = 'active'
       GROUP BY w.id
       ORDER BY w.updated_at DESC, w.created_at DESC`,
    )
    .all() as Array<{
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
    ownerBindings: listOwnerBindings(db),
    targetRunnerBinding: input.pendingWorkspaceSetup
      ? resolvePendingWorkspaceBinding(db, input.pendingWorkspaceSetup)
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
    runnerConnections: listRuntimeConnections(db),
    runnerBindings: listOwnerRuntimeWorkspaceBindings(db, workspace.id),
    ownerBindings: listOwnerBindings(db, workspace.id),
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
       LEFT JOIN artifacts a ON a.project_id = p.id
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

export function loadArtifactsPage(db: DatabaseSync, workspaceRouteId: string) {
  const workspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
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
      if (artifact.scope === "workspace") acc.workspace += 1;
      if (artifact.scope === "project") acc.project += 1;
      if (artifact.cacheState === "ready") acc.cached += 1;
      return acc;
    },
    { total: 0, workspace: 0, project: 0, cached: 0 },
  );
  return { workspace, artifacts, counts, ...loadAgentsProductProjection(db, workspace.id) };
}

export interface ArtifactDetailRow {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  projectId: string | null;
  projectName: string | null;
  scope: string;
  kind: string;
  title: string;
  format: string;
  source: string;
  hash: string | null;
  sizeBytes: number | null;
  contentRefJson: string;
  provenanceJson: string;
  createdAt: string;
  updatedAt: string;
  runtimeWorkspaceBindingId: string | null;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
  invocationId: string | null;
  runtimeInvocationId: string | null;
  invocationStatus: string | null;
  agentName: string | null;
  humanRequestId: string | null;
  humanRequestTitle: string | null;
}

export function loadArtifactDetail(db: DatabaseSync, artifactId: string) {
  return db
    .prepare(
      `SELECT a.id,
              a.workspace_id AS workspaceId,
              w.slug AS workspaceSlug,
              w.name AS workspaceName,
              a.project_id AS projectId,
              p.name AS projectName,
              a.scope,
              a.kind,
              a.title,
              a.format,
              a.source,
              a.hash,
              a.size_bytes AS sizeBytes,
              a.content_ref_json AS contentRefJson,
              a.provenance_json AS provenanceJson,
              a.created_at AS createdAt,
              a.updated_at AS updatedAt,
              a.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              rb.display_name AS runtimeWorkspaceName,
              rc.name AS runtimeName,
              a.invocation_id AS invocationId,
              mi.runtime_invocation_id AS runtimeInvocationId,
              mi.status AS invocationStatus,
              mi.agent_name AS agentName,
              a.human_request_id AS humanRequestId,
              hr.title AS humanRequestTitle
       FROM artifacts a
       JOIN workspaces w ON w.id = a.workspace_id
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = a.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN mirrored_invocations mi ON mi.id = a.invocation_id
       LEFT JOIN human_requests hr ON hr.id = a.human_request_id
       WHERE a.id = ?
       LIMIT 1`,
    )
    .get(artifactId) as ArtifactDetailRow | undefined;
}

export function loadArtifactDetailPage(
  db: DatabaseSync,
  workspaceRouteId: string,
  artifactId: string,
) {
  const workspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
  const artifact = loadArtifactDetail(db, artifactId);
  if (!artifact || artifact.workspaceId !== workspace.id) return null;
  const links = db
    .prepare(
      `SELECT id, target_kind AS targetKind, target_id AS targetId, relation, created_at AS createdAt
       FROM artifact_links
       WHERE artifact_id = ?
       ORDER BY created_at ASC`,
    )
    .all(artifact.id) as Array<{
    id: string;
    targetKind: string;
    targetId: string;
    relation: string;
    createdAt: string;
  }>;
  const cacheBlobs = db
    .prepare(
      `SELECT id,
              state,
              is_preview AS isPreview,
              cache_path AS cachePath,
              size_bytes AS sizeBytes,
              mime,
              fetched_at AS fetchedAt,
              last_accessed_at AS lastAccessedAt,
              expires_at AS expiresAt,
              error_json AS errorJson,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM artifact_cache_blobs
       WHERE artifact_id = ?
       ORDER BY is_preview DESC, created_at DESC`,
    )
    .all(artifact.id) as Array<{
    id: string;
    state: string;
    isPreview: number;
    cachePath: string;
    sizeBytes: number | null;
    mime: string | null;
    fetchedAt: string | null;
    lastAccessedAt: string | null;
    expiresAt: string | null;
    errorJson: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  const previewResult = readArtifactPreviewContent(db, artifact.id);
  return { workspace, artifact, links, cacheBlobs, previewResult };
}

export function prepareArtifactPreviewForWorkspace(
  db: DatabaseSync,
  workspaceRouteId: string,
  artifactId: string,
) {
  const workspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
  const artifact = loadArtifactDetail(db, artifactId);
  if (!artifact || artifact.workspaceId !== workspace.id) return null;
  return ensureArtifactPreviewCache(db, artifactId);
}

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
  options?: Array<{ id: string; label: string; description?: string }>;
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
              rc.name AS runtimeName
       FROM inbox_items ii
       JOIN workspaces w ON w.id = ii.workspace_id
       JOIN human_requests hr ON hr.id = ii.human_request_id
       LEFT JOIN projects p ON p.id = ii.project_id
       JOIN runtime_workspace_bindings rb ON rb.id = hr.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
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
      `SELECT id,
              slug,
              name,
              description,
              status,
              settings_json AS settingsJson,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM workspaces
       WHERE id = ?
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
      }
    | undefined;
}

export function updateWorkspaceSettings(
  db: DatabaseSync,
  input: { workspaceId: string; name: string; slug: string; description: string | null },
): "ok" | "duplicate_slug" {
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
  db.prepare(
    `UPDATE workspaces
     SET name = ?,
         slug = ?,
         description = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(input.name, input.slug, input.description, new Date().toISOString(), input.workspaceId);
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
      `SELECT id,
              slug,
              name,
              description,
              status,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM workspaces
       WHERE id = ?
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

function loadWorkspaceFullByRouteId(db: DatabaseSync, workspaceRouteId: string) {
  return db
    .prepare(
      `SELECT id, slug, name, description, status, created_at AS createdAt, updated_at AS updatedAt
       FROM workspaces
       WHERE status = 'active' AND (slug = ? OR id = ?)
       LIMIT 1`,
    )
    .get(workspaceRouteId, workspaceRouteId) as WorkspaceFullRow | undefined;
}

function listRuntimeConnections(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT id, installation_id AS installationId, name, status, protocol_version AS protocolVersion,
              last_heartbeat_at AS lastHeartbeatAt, updated_at AS updatedAt
       FROM runtime_connections
       ORDER BY updated_at DESC`,
    )
    .all() as unknown as RuntimeConnectionView[];
}

function listAllRuntimeWorkspaceBindings(db: DatabaseSync) {
  return db
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
       ORDER BY rb.updated_at DESC`,
    )
    .all() as unknown as RuntimeWorkspaceBindingView[];
}

function listOwnerRuntimeWorkspaceBindings(db: DatabaseSync, workspaceId: string) {
  return db
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
    .all(workspaceId) as unknown as RuntimeWorkspaceBindingView[];
}

function listOwnerRuntimeConnections(db: DatabaseSync, workspaceId: string) {
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
       JOIN workspace_owner_bindings wob
         ON wob.runtime_workspace_binding_id = rb.id
        AND wob.ended_at IS NULL
       WHERE wob.workspace_id = ?
       ORDER BY rc.updated_at DESC`,
    )
    .all(workspaceId) as unknown as RuntimeConnectionView[];
}

function listOwnerBindings(db: DatabaseSync, workspaceId?: string) {
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
       FROM workspace_owner_bindings wob
       JOIN workspaces w ON w.id = wob.workspace_id
       JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE wob.ended_at IS NULL
         ${where}
       ORDER BY wob.started_at DESC`,
    )
    .all(...args) as unknown as OwnerBindingView[];
}

function listRecentWorkspaceEvents(db: DatabaseSync, workspaceId: string) {
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

function countConnectedRuntimeSessions(db: DatabaseSync) {
  const connectedSessions = db
    .prepare("SELECT COUNT(*) AS count FROM runtime_sessions WHERE status = 'connected'")
    .get() as { count: number };
  return connectedSessions.count;
}

function readEnrollmentRuntimeId(db: DatabaseSync, enrollmentTokenId: string): string | null {
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

function findMatchingWorkspaceBinding(
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

function findOnlyAvailableWorkspaceBindingForRuntime(
  db: DatabaseSync,
  runtimeId: string,
): RuntimeWorkspaceBindingView | null {
  const rows = db
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
       WHERE rb.status = 'available'
         AND rc.status = 'online'
         AND rb.runtime_id = ?
       ORDER BY rb.updated_at DESC
       LIMIT 2`,
    )
    .all(runtimeId) as unknown as RuntimeWorkspaceBindingView[];
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

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

function workspaceIdFromPath(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment || reservedTopLevelSegments.has(segment)) return null;
  return decodeURIComponent(segment);
}
