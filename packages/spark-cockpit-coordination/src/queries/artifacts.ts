import type { DatabaseSync } from "node:sqlite";
import { ensureArtifactPreviewCache, readArtifactPreviewContent } from "../artifact-cache.ts";
import { loadWorkspaceByRouteId } from "../routing.ts";

export function loadArtifactsPage(db: DatabaseSync, workspaceRouteId: string) {
  return loadArtifactKindPage(db, workspaceRouteId, ["issue", "pr", "preview"]);
}

/** Internal evidence projection (document/record/knowledge); not a user-facing Cockpit page. */
export function loadEvidencePage(db: DatabaseSync, workspaceRouteId: string) {
  return loadArtifactKindPage(db, workspaceRouteId, ["document", "record", "knowledge"]);
}

function loadArtifactKindPage(
  db: DatabaseSync,
  workspaceRouteId: string,
  kinds: readonly string[],
) {
  const workspace = loadWorkspaceByRouteId(db, workspaceRouteId);
  if (!workspace) return null;
  const placeholders = kinds.map(() => "?").join(", ");
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
         AND a.kind IN (${placeholders})
       GROUP BY a.id
       ORDER BY a.created_at DESC`,
    )
    .all(workspace.id, ...kinds) as Array<{
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
  return { workspace, artifacts, counts };
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
  sessionId: string | null;
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
              CASE
                WHEN json_valid(c.payload_json)
                THEN CAST(json_extract(c.payload_json, '$.payload.target.sessionId') AS TEXT)
                ELSE NULL
              END AS sessionId,
              a.human_request_id AS humanRequestId,
              hr.title AS humanRequestTitle
       FROM artifacts a
       JOIN workspaces w ON w.id = a.workspace_id
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = a.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
       LEFT JOIN mirrored_invocations mi ON mi.id = a.invocation_id
       LEFT JOIN commands c ON c.id = mi.command_id
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
