import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  type ExecutorClientProjection,
  type RuntimeWorkspaceBindingSummary,
  type WorkspaceBorrowedState,
  type WorkspaceClientKind,
  type WorkspaceClientProjection,
} from "@zendev-lab/spark-protocol";
import { asciiSlug } from "@zendev-lab/spark-system";

export interface WorkspaceProfileRegistration {
  sourceKind: "builtin" | "git";
  ref: string;
  commit?: string;
  importedAt: string;
}

export interface SparkDaemonWorkspace {
  id: string;
  serverUrl: string;
  localWorkspaceKey: string;
  displayName: string;
  localPath: string;
  status: RuntimeWorkspaceBindingSummary["status"];
  capabilities: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  profile?: WorkspaceProfileRegistration;
  borrowed?: WorkspaceBorrowedState;
  workspaceClients?: WorkspaceClientProjection[];
  executor?: ExecutorClientProjection;
  sessionCount?: number;
  lastSessionAt?: string;
  recentSessions?: SparkDaemonWorkspaceRecentSession[];
  updatedAt: string;
}

export interface SparkDaemonWorkspaceClient {
  id: string;
  workspaceId: string;
  kind: WorkspaceClientKind;
  displayName?: string;
  status: "connected" | "disconnected";
  attachedAt: string;
  lastSeenAt: string;
  leaseExpiresAt?: string;
  releasedAt?: string;
  metadata: Record<string, unknown>;
}

export interface AttachWorkspaceClientOptions {
  workspaceId: string;
  clientId?: string;
  kind: WorkspaceClientKind;
  displayName?: string;
  metadata?: Record<string, unknown>;
  leaseTtlMs?: number;
  now?: string;
}

export interface HeartbeatWorkspaceClientOptions {
  clientId: string;
  leaseTtlMs?: number;
  now?: string;
}

export interface ReleaseWorkspaceClientOptions {
  clientId: string;
  now?: string;
}

export interface EnsureWorkspaceExecutorClientOptions {
  workspaceId: string;
  clientId?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
  leaseTtlMs?: number;
  now?: string;
}

export interface SparkDaemonWorkspaceRecentSession {
  id: string;
  project: string;
  model: string;
  lastActivityAt: string;
  state: string;
}

export interface AddWorkspaceOptions {
  id?: string;
  serverUrl?: string;
  localWorkspaceKey: string;
  displayName?: string;
  localPath: string;
  status?: RuntimeWorkspaceBindingSummary["status"];
  profile?: WorkspaceProfileRegistration;
  now?: string;
}

export interface RegisterWorkspaceOptions {
  serverUrl?: string;
  allowInsecureHttp?: boolean;
  localPath: string;
  serverBindingId?: string;
  serverWorkspaceId?: string;
  serverStatus?: RuntimeWorkspaceBindingSummary["status"];
  localWorkspaceKey?: string;
  displayName?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  profile?: WorkspaceProfileRegistration;
  consumedRegistrationToken?: string;
  serverCredential?: SparkDaemonServerCredentialRegistration;
  now?: string;
}

export interface EnsureLocalWorkspaceOptions {
  localPath: string;
  displayName?: string;
  localWorkspaceKey?: string;
  now?: string;
}

export interface PlannedWorkspaceRegistration {
  serverUrl: string;
  localPath: string;
  localWorkspaceKey: string;
  displayName: string;
  workspaceName: string;
  workspaceSlug: string;
}

export interface SparkDaemonServerCredentialRegistration {
  runtimeId: string;
  runtimeToken: string;
  runtimeTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export interface SparkDaemonServerStatusSummary {
  url: string;
  workspaceCount: number;
  wsConnected: boolean;
  lastHeartbeatAt?: string;
  lastDisconnectReason?: string;
}

export interface StopWorkspaceOptions {
  id: string;
  now?: string;
}

export interface AttachWorkspaceOptions {
  id: string;
  now?: string;
}

export class WorkspacePathConflictError extends Error {
  constructor(
    message: string,
    readonly kind: "same-path" | "same-key" | "nested",
  ) {
    super(message);
  }
}

export function addWorkspace(db: DatabaseSync, options: AddWorkspaceOptions): SparkDaemonWorkspace {
  const now = options.now ?? new Date().toISOString();
  const serverUrl = options.serverUrl ?? "";
  const localPath = normalizeLocalPath(options.localPath);
  assertWorkspaceSlotAvailable(db, serverUrl, localPath, options.localWorkspaceKey);
  const existing = getWorkspaceByKey(db, serverUrl, options.localWorkspaceKey);

  const workspace: SparkDaemonWorkspace = {
    id: existing?.id ?? options.id ?? createId("rtwb"),
    serverUrl,
    localWorkspaceKey: options.localWorkspaceKey,
    displayName: options.displayName ?? existing?.displayName ?? options.localWorkspaceKey,
    localPath,
    status: options.status ?? "available",
    capabilities: existing?.capabilities ?? {},
    diagnostics: {},
    ...(options.profile ? { profile: options.profile } : {}),
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO workspaces
      (id, server_url, local_workspace_key, display_name, local_path, status, capabilities_json, diagnostics_json, profile_source_kind, profile_ref, profile_commit, profile_imported_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_url, local_workspace_key) DO UPDATE SET
      display_name = excluded.display_name,
      local_path = excluded.local_path,
      status = excluded.status,
      capabilities_json = excluded.capabilities_json,
      diagnostics_json = excluded.diagnostics_json,
      profile_source_kind = excluded.profile_source_kind,
      profile_ref = excluded.profile_ref,
      profile_commit = excluded.profile_commit,
      profile_imported_at = excluded.profile_imported_at,
      updated_at = excluded.updated_at`,
  ).run(
    workspace.id,
    workspace.serverUrl,
    workspace.localWorkspaceKey,
    workspace.displayName,
    workspace.localPath,
    workspace.status,
    JSON.stringify(workspace.capabilities),
    JSON.stringify(workspace.diagnostics),
    workspace.profile?.sourceKind ?? null,
    workspace.profile?.ref ?? null,
    workspace.profile?.commit ?? null,
    workspace.profile?.importedAt ?? null,
    now,
    now,
  );

  return workspace;
}

export function registerWorkspace(
  db: DatabaseSync,
  options: RegisterWorkspaceOptions,
): SparkDaemonWorkspace {
  const planned = planWorkspaceRegistration(db, options);
  const now = options.now ?? new Date().toISOString();

  return withSparkDaemonTransaction(db, () => {
    const addOptions: AddWorkspaceOptions = {
      serverUrl: planned.serverUrl,
      localWorkspaceKey: planned.localWorkspaceKey,
      localPath: planned.localPath,
      displayName: planned.displayName,
      now,
      ...(options.serverBindingId ? { id: options.serverBindingId } : {}),
      ...(options.serverStatus ? { status: options.serverStatus } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
    };
    const workspace = addWorkspace(db, addOptions);
    recordSparkDaemonWorkspaceRegistration(db, workspace, options, now);
    return workspace;
  });
}

export function ensureLocalWorkspace(
  db: DatabaseSync,
  options: EnsureLocalWorkspaceOptions,
): SparkDaemonWorkspace {
  const localPath = normalizeLocalPath(options.localPath);
  const existing = findWorkspaceByPathOnServer(db, "", localPath);
  if (existing) {
    return isUserDetachedWorkspace(existing) ? attachWorkspace(db, { id: existing.id }) : existing;
  }

  return registerWorkspace(db, {
    serverUrl: "",
    localPath,
    ...(options.displayName ? { displayName: options.displayName } : {}),
    ...(options.localWorkspaceKey ? { localWorkspaceKey: options.localWorkspaceKey } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

export function planWorkspaceRegistration(
  db: DatabaseSync,
  options: RegisterWorkspaceOptions,
): PlannedWorkspaceRegistration {
  const serverUrl = options.serverUrl ?? "";
  const localPath = normalizeLocalPath(options.localPath);
  const displayName = options.displayName ?? workspaceNameForPath(localPath);
  const localWorkspaceKey = options.localWorkspaceKey ?? workspaceKeyForName(displayName);
  const workspaceName = options.workspaceName ?? displayName;
  const workspaceSlug = options.workspaceSlug ?? localWorkspaceKey;
  const existingPath = findWorkspaceByPathOnServer(db, serverUrl, localPath);
  if (existingPath) {
    throw new WorkspacePathConflictError(
      `Workspace path ${localPath} is already registered as ${existingPath.localWorkspaceKey} on ${formatServerUrl(serverUrl)}.`,
      "same-path",
    );
  }
  assertWorkspaceSlotAvailable(db, serverUrl, localPath, localWorkspaceKey);
  return {
    serverUrl,
    localPath,
    localWorkspaceKey,
    displayName,
    workspaceName,
    workspaceSlug,
  };
}

function recordSparkDaemonWorkspaceRegistration(
  db: DatabaseSync,
  workspace: SparkDaemonWorkspace,
  options: RegisterWorkspaceOptions,
  now: string,
): void {
  const serverId = ensureSparkDaemonServer(db, workspace.serverUrl, now);
  if (options.serverCredential) {
    upsertSparkDaemonServerCredential(db, serverId, options.serverCredential, now);
  }

  db.prepare(
    `INSERT INTO daemon_workspaces
      (id, server_id, server_workspace_id, server_binding_id, name, slug, local_path, profile_source_kind, profile_ref, profile_commit, registered_at, last_known_status, last_known_offline_reason, last_status_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workspace.id,
    serverId,
    options.serverWorkspaceId ?? null,
    options.serverBindingId ?? workspace.id,
    workspace.displayName,
    workspace.localWorkspaceKey,
    workspace.localPath,
    workspace.profile?.sourceKind ?? null,
    workspace.profile?.ref ?? null,
    workspace.profile?.commit ?? null,
    now,
    workspace.status,
    offlineReasonForStatus(workspace.status, workspace.diagnostics),
    now,
  );

  if (options.consumedRegistrationToken) {
    db.prepare(
      `INSERT INTO daemon_workspace_grants
        (id, daemon_workspace_id, grant_token_hash, server_grant_id, created_at, consumed_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
    ).run(
      createSparkDaemonLocalId("rngrant"),
      workspace.id,
      hashSecret(options.consumedRegistrationToken),
      now,
      now,
    );
  }
}

function ensureSparkDaemonServer(db: DatabaseSync, serverUrl: string, now: string): string {
  const existing = db
    .prepare("SELECT id FROM daemon_servers WHERE server_url = ? LIMIT 1")
    .get(serverUrl) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }

  const id = createSparkDaemonLocalId("rnsrv");
  db.prepare(
    `INSERT INTO daemon_servers
      (id, server_url, first_registered_at)
     VALUES (?, ?, ?)`,
  ).run(id, serverUrl, now);
  return id;
}

function upsertSparkDaemonServerCredential(
  db: DatabaseSync,
  serverId: string,
  credential: SparkDaemonServerCredentialRegistration,
  now: string,
): void {
  const existing = db
    .prepare(
      "SELECT id, created_at AS createdAt FROM daemon_server_credentials WHERE server_id = ?",
    )
    .get(serverId) as { id: string; createdAt: string } | undefined;
  db.prepare(
    `INSERT INTO daemon_server_credentials
      (id, server_id, runtime_id, runtime_token_hash, refresh_token_hash, runtime_token_expires_at, refresh_token_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
      runtime_id = excluded.runtime_id,
      runtime_token_hash = excluded.runtime_token_hash,
      refresh_token_hash = excluded.refresh_token_hash,
      runtime_token_expires_at = excluded.runtime_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      updated_at = excluded.updated_at`,
  ).run(
    existing?.id ?? createSparkDaemonLocalId("rncred"),
    serverId,
    credential.runtimeId,
    hashSecret(credential.runtimeToken),
    credential.refreshToken ? hashSecret(credential.refreshToken) : null,
    credential.runtimeTokenExpiresAt ?? null,
    credential.refreshTokenExpiresAt ?? null,
    existing?.createdAt ?? now,
    now,
  );
}

function updateSparkDaemonWorkspaceStatus(
  db: DatabaseSync,
  workspaceId: string,
  status: RuntimeWorkspaceBindingSummary["status"],
  diagnostics: Record<string, unknown>,
  now: string,
): void {
  db.prepare(
    `UPDATE daemon_workspaces
     SET last_known_status = ?,
         last_known_offline_reason = ?,
         last_status_changed_at = ?
     WHERE id = ?`,
  ).run(status, offlineReasonForStatus(status, diagnostics), now, workspaceId);
}

export function markSparkDaemonServerConnected(
  db: DatabaseSync,
  serverUrl: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE daemon_servers
     SET last_connected_at = ?,
         last_disconnect_reason = NULL
     WHERE server_url = ?`,
  ).run(now, serverUrl);
}

/**
 * Record loss of the optional Cockpit projection connection.
 *
 * Workspace availability is daemon-local execution state (path, detach, and
 * capability health). A disconnected projection server must not make an
 * otherwise executable local workspace unavailable.
 */
export function markSparkDaemonServerDisconnected(
  db: DatabaseSync,
  serverUrl: string,
  reason = "server.unreachable",
): void {
  db.prepare(
    `UPDATE daemon_servers
     SET last_disconnect_reason = ?
     WHERE server_url = ?`,
  ).run(reason, serverUrl);
}

export function sparkDaemonServerStatusSummaries(
  db: DatabaseSync,
): SparkDaemonServerStatusSummary[] {
  const rows = db
    .prepare(
      `SELECT rs.server_url AS url,
              rs.last_connected_at AS lastHeartbeatAt,
              rs.last_disconnect_reason AS lastDisconnectReason,
              COUNT(rw.id) AS workspaceCount
       FROM daemon_servers rs
       LEFT JOIN daemon_workspaces rw ON rw.server_id = rs.id
       GROUP BY rs.id
       ORDER BY rs.server_url ASC`,
    )
    .all() as Array<{
    url: string;
    lastHeartbeatAt: string | null;
    lastDisconnectReason: string | null;
    workspaceCount: number;
  }>;

  return rows.map((row) => ({
    url: row.url,
    workspaceCount: row.workspaceCount,
    wsConnected: Boolean(row.lastHeartbeatAt && !row.lastDisconnectReason),
    ...(row.lastHeartbeatAt ? { lastHeartbeatAt: row.lastHeartbeatAt } : {}),
    ...(row.lastDisconnectReason ? { lastDisconnectReason: row.lastDisconnectReason } : {}),
  }));
}

function offlineReasonForStatus(
  status: RuntimeWorkspaceBindingSummary["status"],
  diagnostics: Record<string, unknown>,
): string | null {
  if (status === "available") {
    return null;
  }
  if (diagnostics.userDetached === true) {
    return "user-detached";
  }
  if (diagnostics.serverDisconnected === true) {
    return "server-disconnected";
  }
  if (diagnostics.pathMissing === true) {
    return "path-missing";
  }
  return "unknown";
}

function hashSecret(secret: string): string {
  return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

function createSparkDaemonLocalId(prefix: "rnsrv" | "rncred" | "rngrant"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function withSparkDaemonTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original registration failure.
    }
    throw error;
  }
}

export function workspaceKeyForName(name: string): string {
  return slugify(name) || "workspace";
}

export function workspaceKeyForPath(localPath: string): string {
  return workspaceKeyForName(basename(normalizeLocalPath(localPath)));
}

export function listWorkspaces(db: DatabaseSync): SparkDaemonWorkspace[] {
  const rows = db
    .prepare(
      `SELECT id,
              server_url AS serverUrl,
              local_workspace_key AS localWorkspaceKey,
              display_name AS displayName,
              local_path AS localPath,
              status,
              capabilities_json AS capabilitiesJson,
              diagnostics_json AS diagnosticsJson,
              profile_source_kind AS profileSourceKind,
              profile_ref AS profileRef,
              profile_commit AS profileCommit,
              profile_imported_at AS profileImportedAt,
              updated_at AS updatedAt
       FROM workspaces
       ORDER BY display_name ASC`,
    )
    .all() as unknown as WorkspaceRow[];
  return rows.map((row) => mapWorkspaceRow(row, db));
}

export function getWorkspaceById(db: DatabaseSync, id: string): SparkDaemonWorkspace | null {
  const row = db
    .prepare(
      `SELECT id,
              server_url AS serverUrl,
              local_workspace_key AS localWorkspaceKey,
              display_name AS displayName,
              local_path AS localPath,
              status,
              capabilities_json AS capabilitiesJson,
              diagnostics_json AS diagnosticsJson,
              profile_source_kind AS profileSourceKind,
              profile_ref AS profileRef,
              profile_commit AS profileCommit,
              profile_imported_at AS profileImportedAt,
              updated_at AS updatedAt
       FROM workspaces
       WHERE id = ?
       LIMIT 1`,
    )
    .get(id) as WorkspaceRow | undefined;
  return row ? mapWorkspaceRow(row, db) : null;
}

/** Resolve session ownership ids to the daemon-local execution directory. */
export function resolveWorkspaceLocalPath(
  db: DatabaseSync,
  workspaceId: string,
): string | undefined {
  const direct = getWorkspaceById(db, workspaceId);
  if (direct) return direct.localPath;

  const serverMatches = db
    .prepare(
      `SELECT w.local_path AS localPath
       FROM workspaces w
       JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE dw.server_workspace_id = ?
       LIMIT 2`,
    )
    .all(workspaceId) as Array<{ localPath: string }>;
  if (serverMatches.length === 1) return serverMatches[0]!.localPath;

  // v1 session records used daemon-local slugs (for example "spark").
  const legacyMatches = listWorkspaces(db).filter(
    (workspace) => workspace.localWorkspaceKey === workspaceId,
  );
  return legacyMatches.length === 1 ? legacyMatches[0]!.localPath : undefined;
}

export function getWorkspaceByKey(
  db: DatabaseSync,
  serverUrl: string,
  localWorkspaceKey: string,
): SparkDaemonWorkspace | null {
  const row = db
    .prepare(
      `SELECT id,
              server_url AS serverUrl,
              local_workspace_key AS localWorkspaceKey,
              display_name AS displayName,
              local_path AS localPath,
              status,
              capabilities_json AS capabilitiesJson,
              diagnostics_json AS diagnosticsJson,
              profile_source_kind AS profileSourceKind,
              profile_ref AS profileRef,
              profile_commit AS profileCommit,
              profile_imported_at AS profileImportedAt,
              updated_at AS updatedAt
       FROM workspaces
       WHERE server_url = ? AND local_workspace_key = ?
       LIMIT 1`,
    )
    .get(serverUrl, localWorkspaceKey) as WorkspaceRow | undefined;
  return row ? mapWorkspaceRow(row, db) : null;
}

export function getWorkspaceByPath(
  db: DatabaseSync,
  localPath: string,
): SparkDaemonWorkspace | null {
  const row = db
    .prepare(
      `SELECT id,
              server_url AS serverUrl,
              local_workspace_key AS localWorkspaceKey,
              display_name AS displayName,
              local_path AS localPath,
              status,
              capabilities_json AS capabilitiesJson,
              diagnostics_json AS diagnosticsJson,
              profile_source_kind AS profileSourceKind,
              profile_ref AS profileRef,
              profile_commit AS profileCommit,
              profile_imported_at AS profileImportedAt,
              updated_at AS updatedAt
       FROM workspaces
       WHERE local_path = ?
       LIMIT 1`,
    )
    .get(normalizeLocalPath(localPath)) as WorkspaceRow | undefined;
  return row ? mapWorkspaceRow(row, db) : null;
}

function findWorkspaceByPathOnServer(
  db: DatabaseSync,
  serverUrl: string,
  localPath: string,
): SparkDaemonWorkspace | null {
  const normalizedPath = normalizeLocalPath(localPath);
  return (
    listWorkspaces(db).find(
      (workspace) => workspace.serverUrl === serverUrl && workspace.localPath === normalizedPath,
    ) ?? null
  );
}

function assertWorkspaceSlotAvailable(
  db: DatabaseSync,
  serverUrl: string,
  localPath: string,
  localWorkspaceKey: string,
): void {
  const existing = getWorkspaceByKey(db, serverUrl, localWorkspaceKey);
  if (existing && existing.localPath !== localPath) {
    throw new WorkspacePathConflictError(
      `Workspace key ${localWorkspaceKey} is already registered on ${formatServerUrl(serverUrl)} at ${existing.localPath}.`,
      "same-key",
    );
  }

  const collision = findPathCollision(db, localPath, serverUrl, localWorkspaceKey);
  if (collision?.kind === "same-path") {
    throw new WorkspacePathConflictError(
      `Workspace path ${localPath} is already bound as ${collision.workspace.localWorkspaceKey} on ${formatServerUrl(collision.workspace.serverUrl)}.`,
      "same-path",
    );
  }
  if (collision?.kind === "nested") {
    throw new WorkspacePathConflictError(
      `Workspace path ${localPath} cannot be nested with registered workspace ${collision.workspace.localWorkspaceKey} at ${collision.workspace.localPath}.`,
      "nested",
    );
  }
}

function findPathCollision(
  db: DatabaseSync,
  localPath: string,
  serverUrl: string,
  localWorkspaceKey: string,
): { kind: "same-path" | "nested"; workspace: SparkDaemonWorkspace } | null {
  const normalizedPath = normalizeLocalPath(localPath);
  for (const workspace of listWorkspaces(db)) {
    const sameServer = workspace.serverUrl === serverUrl;
    if (sameServer && workspace.localWorkspaceKey === localWorkspaceKey) {
      continue;
    }

    if (workspace.localPath === normalizedPath) {
      if (sameServer) {
        return { kind: "same-path", workspace };
      }
      continue;
    }

    if (
      pathContains(workspace.localPath, normalizedPath) ||
      pathContains(normalizedPath, workspace.localPath)
    ) {
      return { kind: "nested", workspace };
    }
  }

  return null;
}

export function stopWorkspace(
  db: DatabaseSync,
  options: StopWorkspaceOptions,
): SparkDaemonWorkspace {
  const workspace = getWorkspaceById(db, options.id);
  if (!workspace) {
    throw new Error(`Unknown workspace connection: ${options.id}`);
  }

  const now = options.now ?? new Date().toISOString();
  const diagnostics = {
    ...workspace.diagnostics,
    userDetached: true,
    detachedAt: now,
    reason: "user_stop",
  };

  db.prepare(
    `UPDATE workspaces
     SET status = 'unavailable', diagnostics_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(diagnostics), now, workspace.id);
  updateSparkDaemonWorkspaceStatus(db, workspace.id, "unavailable", diagnostics, now);

  return {
    ...workspace,
    status: "unavailable",
    diagnostics,
    updatedAt: now,
  };
}

export function attachWorkspace(
  db: DatabaseSync,
  options: AttachWorkspaceOptions,
): SparkDaemonWorkspace {
  const workspace = getWorkspaceById(db, options.id);
  if (!workspace) {
    throw new Error(`Unknown workspace connection: ${options.id}`);
  }

  const now = options.now ?? new Date().toISOString();
  db.prepare(
    `UPDATE workspaces
     SET status = 'available', diagnostics_json = '{}', updated_at = ?
     WHERE id = ?`,
  ).run(now, workspace.id);
  updateSparkDaemonWorkspaceStatus(db, workspace.id, "available", {}, now);

  return (
    getWorkspaceById(db, workspace.id) ?? {
      ...workspace,
      status: "available",
      diagnostics: {},
      updatedAt: now,
    }
  );
}

export function attachWorkspaceClient(
  db: DatabaseSync,
  options: AttachWorkspaceClientOptions,
): SparkDaemonWorkspaceClient {
  const workspace = getWorkspaceById(db, options.workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace connection: ${options.workspaceId}`);
  }

  const now = options.now ?? new Date().toISOString();
  const clientId = options.clientId ?? createSparkDaemonWorkspaceClientId();
  const leaseExpiresAt = leaseExpiresAtFor(now, options.leaseTtlMs);
  const existing = db
    .prepare(
      "SELECT workspace_id AS workspaceId, attached_at AS attachedAt FROM daemon_workspace_clients WHERE id = ? LIMIT 1",
    )
    .get(clientId) as { workspaceId: string; attachedAt: string } | undefined;
  if (existing && existing.workspaceId !== workspace.id) {
    throw new Error(
      `Workspace client ${clientId} is already bound to workspace ${existing.workspaceId}.`,
    );
  }

  db.prepare(
    `INSERT INTO daemon_workspace_clients
      (id, workspace_id, kind, display_name, status, attached_at, last_seen_at, lease_expires_at, released_at, metadata_json)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      kind = excluded.kind,
      display_name = excluded.display_name,
      status = 'connected',
      last_seen_at = excluded.last_seen_at,
      lease_expires_at = excluded.lease_expires_at,
      released_at = NULL,
      metadata_json = excluded.metadata_json`,
  ).run(
    clientId,
    workspace.id,
    options.kind,
    options.displayName ?? null,
    existing?.attachedAt ?? now,
    now,
    leaseExpiresAt ?? null,
    JSON.stringify(options.metadata ?? {}),
  );

  return requireWorkspaceClient(db, clientId);
}

export function heartbeatWorkspaceClient(
  db: DatabaseSync,
  options: HeartbeatWorkspaceClientOptions,
): SparkDaemonWorkspaceClient {
  const client = getWorkspaceClientById(db, options.clientId);
  if (!client) {
    throw new Error(`Unknown workspace client: ${options.clientId}`);
  }
  const now = options.now ?? new Date().toISOString();
  db.prepare(
    `UPDATE daemon_workspace_clients
     SET status = 'connected',
         last_seen_at = ?,
         lease_expires_at = ?,
         released_at = NULL
     WHERE id = ?`,
  ).run(
    now,
    leaseExpiresAtFor(now, options.leaseTtlMs) ?? client.leaseExpiresAt ?? null,
    client.id,
  );
  return requireWorkspaceClient(db, client.id);
}

export function releaseWorkspaceClient(
  db: DatabaseSync,
  options: ReleaseWorkspaceClientOptions,
): SparkDaemonWorkspaceClient {
  const client = getWorkspaceClientById(db, options.clientId);
  if (!client) {
    throw new Error(`Unknown workspace client: ${options.clientId}`);
  }
  const now = options.now ?? new Date().toISOString();
  db.prepare(
    `UPDATE daemon_workspace_clients
     SET status = 'disconnected',
         last_seen_at = ?,
         lease_expires_at = NULL,
         released_at = ?
     WHERE id = ?`,
  ).run(now, now, client.id);
  return requireWorkspaceClient(db, client.id);
}

export function ensureWorkspaceExecutorClient(
  db: DatabaseSync,
  options: EnsureWorkspaceExecutorClientOptions,
): SparkDaemonWorkspaceClient {
  const now = options.now ?? new Date().toISOString();
  const existing = listWorkspaceClients(db, options.workspaceId, now).find(
    (client) => client.kind === "executor" && client.status === "connected",
  );
  if (existing) {
    return heartbeatWorkspaceClient(db, {
      clientId: existing.id,
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
      now,
    });
  }

  return attachWorkspaceClient(db, {
    workspaceId: options.workspaceId,
    ...(options.clientId ? { clientId: options.clientId } : {}),
    kind: "executor",
    displayName: options.displayName ?? "Background executor",
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
    now,
  });
}

export function expireWorkspaceClientLeases(
  db: DatabaseSync,
  now = new Date().toISOString(),
): number {
  const result = db
    .prepare(
      `UPDATE daemon_workspace_clients
     SET status = 'disconnected', released_at = COALESCE(released_at, lease_expires_at), last_seen_at = ?
     WHERE status = 'connected'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ?`,
    )
    .run(now, now);
  return Number(result.changes ?? 0);
}

export function listWorkspaceClients(
  db: DatabaseSync,
  workspaceId?: string,
  now = new Date().toISOString(),
): SparkDaemonWorkspaceClient[] {
  expireWorkspaceClientLeases(db, now);
  const sql = `SELECT id,
                      workspace_id AS workspaceId,
                      kind,
                      display_name AS displayName,
                      status,
                      attached_at AS attachedAt,
                      last_seen_at AS lastSeenAt,
                      lease_expires_at AS leaseExpiresAt,
                      released_at AS releasedAt,
                      metadata_json AS metadataJson
               FROM daemon_workspace_clients
               ${workspaceId ? "WHERE workspace_id = ?" : ""}
               ORDER BY last_seen_at DESC, attached_at DESC`;
  const rows = workspaceId ? db.prepare(sql).all(workspaceId) : db.prepare(sql).all();
  return (rows as unknown as WorkspaceClientRow[]).map(mapWorkspaceClientRow);
}

export function isBorrowedWorkspace(
  db: DatabaseSync,
  workspaceId: string,
  now = new Date().toISOString(),
): boolean {
  return workspaceBorrowedState(db, workspaceId, now).borrowed;
}

export function isUserDetachedWorkspace(workspace: SparkDaemonWorkspace): boolean {
  return workspace.diagnostics.userDetached === true;
}

export function reconcileWorkspaces(
  db: DatabaseSync,
  now = new Date().toISOString(),
): SparkDaemonWorkspace[] {
  const workspaces = listWorkspaces(db);
  const update = db.prepare(
    `UPDATE workspaces
     SET status = ?, diagnostics_json = ?, updated_at = ?
     WHERE id = ?`,
  );

  return workspaces.map((workspace) => {
    if (isUserDetachedWorkspace(workspace)) {
      update.run(workspace.status, JSON.stringify(workspace.diagnostics), now, workspace.id);
      return { ...workspace, updatedAt: now };
    }

    const pathExists = existsSync(workspace.localPath);
    const status: RuntimeWorkspaceBindingSummary["status"] = pathExists
      ? "available"
      : "unavailable";
    const diagnostics = pathExists
      ? {}
      : { pathMissing: true, localPath: workspace.localPath, checkedAt: now };
    update.run(status, JSON.stringify(diagnostics), now, workspace.id);
    updateSparkDaemonWorkspaceStatus(db, workspace.id, status, diagnostics, now);
    return { ...workspace, status, diagnostics, updatedAt: now };
  });
}

export function workspaceSummaries(db: DatabaseSync): RuntimeWorkspaceBindingSummary[] {
  return listWorkspaces(db).map((workspace) => ({
    bindingId: workspace.id,
    localWorkspaceKey: workspace.localWorkspaceKey,
    localPath: workspace.localPath,
    displayName: workspace.displayName,
    status: workspace.status,
    capabilities: workspace.capabilities,
    diagnostics: workspace.diagnostics,
    ...(workspace.borrowed ? { borrowed: workspace.borrowed } : {}),
    ...(workspace.workspaceClients ? { workspaceClients: workspace.workspaceClients } : {}),
    ...(workspace.executor ? { executor: workspace.executor } : {}),
  }));
}

interface WorkspaceRow {
  id: string;
  serverUrl: string;
  localWorkspaceKey: string;
  displayName: string;
  localPath: string;
  status: RuntimeWorkspaceBindingSummary["status"];
  capabilitiesJson: string;
  diagnosticsJson: string;
  profileSourceKind: string | null;
  profileRef: string | null;
  profileCommit: string | null;
  profileImportedAt: string | null;
  updatedAt: string;
}

function mapWorkspaceRow(row: WorkspaceRow, db?: DatabaseSync): SparkDaemonWorkspace {
  const projection = db ? workspaceInvocationProjection(db, row.id) : {};
  const clientProjection = db ? workspaceClientStateProjection(db, row.id) : {};
  return {
    id: row.id,
    serverUrl: row.serverUrl,
    localWorkspaceKey: row.localWorkspaceKey,
    displayName: row.displayName,
    localPath: row.localPath,
    status: row.status,
    capabilities: parseObject(row.capabilitiesJson),
    diagnostics: parseObject(row.diagnosticsJson),
    ...profileFromRow(row),
    ...projection,
    ...clientProjection,
    updatedAt: row.updatedAt,
  };
}

function workspaceInvocationProjection(
  db: DatabaseSync,
  workspaceId: string,
): Pick<SparkDaemonWorkspace, "sessionCount" | "lastSessionAt" | "recentSessions"> {
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM invocations WHERE workspace_binding_id = ?")
    .get(workspaceId) as { count: number };
  const rows = db
    .prepare(
      `SELECT id,
              status,
              updated_at AS updatedAt
       FROM invocations
       WHERE workspace_binding_id = ?
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 5`,
    )
    .all(workspaceId) as Array<{
    id: string;
    status: string;
    updatedAt: string;
  }>;

  if (count.count === 0) {
    return {};
  }

  const latestUpdatedAt = rows[0]?.updatedAt;

  return {
    sessionCount: count.count,
    ...(latestUpdatedAt ? { lastSessionAt: latestUpdatedAt } : {}),
    recentSessions: rows.map((row) => ({
      id: row.id,
      project: "workspace",
      model: "pi",
      lastActivityAt: row.updatedAt,
      state: row.status,
    })),
  };
}

function workspaceClientStateProjection(
  db: DatabaseSync,
  workspaceId: string,
): Pick<SparkDaemonWorkspace, "borrowed" | "workspaceClients" | "executor"> {
  const allClients = listWorkspaceClients(db, workspaceId);
  const clients = allClients.filter((client) => client.status === "connected");
  const activeInvocations = activeInvocationCount(db, workspaceId);
  if (allClients.length === 0 && activeInvocations === 0) {
    return {};
  }

  const borrowed = borrowedStateFromClients(clients);
  const executorClient = clients.find((client) => client.kind === "executor");
  return {
    borrowed,
    workspaceClients: clients.map(workspaceClientProjection),
    executor: executorClient
      ? executorProjectionForClient(executorClient, activeInvocations)
      : {
          state: activeInvocations > 0 ? "starting" : "none",
          activeInvocationCount: activeInvocations,
          activeAgentCount: 0,
        },
  };
}

function workspaceBorrowedState(
  db: DatabaseSync,
  workspaceId: string,
  now = new Date().toISOString(),
): WorkspaceBorrowedState {
  return borrowedStateFromClients(
    listWorkspaceClients(db, workspaceId, now).filter((client) => client.status === "connected"),
  );
}

function borrowedStateFromClients(clients: SparkDaemonWorkspaceClient[]): WorkspaceBorrowedState {
  const interactiveClients = clients.filter((client) => client.kind === "interactive");
  const since = interactiveClients
    .map((client) => client.attachedAt)
    .sort((a, b) => a.localeCompare(b))[0];
  return {
    borrowed: interactiveClients.length > 0,
    interactiveClientCount: interactiveClients.length,
    borrowedByClientIds: interactiveClients.map((client) => client.id),
    ...(since ? { since } : {}),
  };
}

function workspaceClientProjection(client: SparkDaemonWorkspaceClient): WorkspaceClientProjection {
  return {
    clientId: client.id,
    kind: client.kind,
    status: client.status,
    ...(client.displayName ? { displayName: client.displayName } : {}),
    attachedAt: client.attachedAt,
    lastSeenAt: client.lastSeenAt,
  };
}

function executorProjectionForClient(
  client: SparkDaemonWorkspaceClient,
  activeInvocations: number,
): ExecutorClientProjection {
  const metadataState = client.metadata.state;
  const state =
    metadataState === "starting" || metadataState === "online" || metadataState === "unhealthy"
      ? metadataState
      : "online";
  const metadataActiveAgentCount = client.metadata.activeAgentCount;
  return {
    state,
    clientId: client.id,
    activeInvocationCount: activeInvocations,
    activeAgentCount:
      typeof metadataActiveAgentCount === "number" && metadataActiveAgentCount >= 0
        ? Math.floor(metadataActiveAgentCount)
        : activeInvocations,
    lastSeenAt: client.lastSeenAt,
    ...(typeof client.metadata.unhealthyReason === "string"
      ? { unhealthyReason: client.metadata.unhealthyReason }
      : {}),
  };
}

function activeInvocationCount(db: DatabaseSync, workspaceId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM invocations WHERE workspace_binding_id = ? AND status IN ('queued', 'running')",
    )
    .get(workspaceId) as { count: number };
  return row.count;
}

function getWorkspaceClientById(
  db: DatabaseSync,
  clientId: string,
): SparkDaemonWorkspaceClient | null {
  const row = db
    .prepare(
      `SELECT id,
              workspace_id AS workspaceId,
              kind,
              display_name AS displayName,
              status,
              attached_at AS attachedAt,
              last_seen_at AS lastSeenAt,
              lease_expires_at AS leaseExpiresAt,
              released_at AS releasedAt,
              metadata_json AS metadataJson
       FROM daemon_workspace_clients
       WHERE id = ?
       LIMIT 1`,
    )
    .get(clientId) as WorkspaceClientRow | undefined;
  return row ? mapWorkspaceClientRow(row) : null;
}

function requireWorkspaceClient(db: DatabaseSync, clientId: string): SparkDaemonWorkspaceClient {
  const client = getWorkspaceClientById(db, clientId);
  if (!client) {
    throw new Error(`Unknown workspace client: ${clientId}`);
  }
  return client;
}

interface WorkspaceClientRow {
  id: string;
  workspaceId: string;
  kind: WorkspaceClientKind;
  displayName: string | null;
  status: "connected" | "disconnected";
  attachedAt: string;
  lastSeenAt: string;
  leaseExpiresAt: string | null;
  releasedAt: string | null;
  metadataJson: string;
}

function mapWorkspaceClientRow(row: WorkspaceClientRow): SparkDaemonWorkspaceClient {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    status: row.status,
    attachedAt: row.attachedAt,
    lastSeenAt: row.lastSeenAt,
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.releasedAt ? { releasedAt: row.releasedAt } : {}),
    metadata: parseObject(row.metadataJson),
  };
}

function leaseExpiresAtFor(now: string, leaseTtlMs: number | undefined): string | undefined {
  if (!leaseTtlMs || leaseTtlMs <= 0) {
    return undefined;
  }
  return new Date(new Date(now).getTime() + leaseTtlMs).toISOString();
}

function createSparkDaemonWorkspaceClientId(): string {
  return `wcl_${randomUUID().replaceAll("-", "")}`;
}

function profileFromRow(row: WorkspaceRow): { profile?: WorkspaceProfileRegistration } {
  if (
    (row.profileSourceKind !== "builtin" && row.profileSourceKind !== "git") ||
    !row.profileRef ||
    !row.profileImportedAt
  ) {
    return {};
  }

  return {
    profile: {
      sourceKind: row.profileSourceKind,
      ref: row.profileRef,
      ...(row.profileCommit ? { commit: row.profileCommit } : {}),
      importedAt: row.profileImportedAt,
    },
  };
}

function formatServerUrl(serverUrl: string): string {
  return serverUrl || "the local server";
}

function pathContains(parentPath: string, childPath: string): boolean {
  const fromParent = relative(normalizeLocalPath(parentPath), normalizeLocalPath(childPath));
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

function normalizeLocalPath(localPath: string): string {
  const absolutePath = resolve(localPath);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function workspaceNameForPath(localPath: string): string {
  return basename(normalizeLocalPath(localPath)) || "Workspace";
}

function slugify(value: string): string {
  return asciiSlug(value, { maxLength: 48 });
}
