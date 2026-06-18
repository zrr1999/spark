import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createId, type RuntimeWorkspaceBindingSummary } from "@zendev-lab/navia-protocol";
import { asciiSlug } from "@zendev-lab/navia-system";

export interface WorkspaceProfileRegistration {
  sourceKind: "builtin" | "git";
  ref: string;
  commit?: string;
  importedAt: string;
}

export interface RunnerWorkspace {
  id: string;
  serverUrl: string;
  localWorkspaceKey: string;
  displayName: string;
  localPath: string;
  status: RuntimeWorkspaceBindingSummary["status"];
  capabilities: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  profile?: WorkspaceProfileRegistration;
  sessionCount?: number;
  lastSessionAt?: string;
  recentSessions?: RunnerWorkspaceRecentSession[];
  updatedAt: string;
}

export interface RunnerWorkspaceRecentSession {
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
  localPath: string;
  serverBindingId?: string;
  serverWorkspaceId?: string;
  serverStatus?: RuntimeWorkspaceBindingSummary["status"];
  localWorkspaceKey?: string;
  displayName?: string;
  profile?: WorkspaceProfileRegistration;
  consumedRegistrationToken?: string;
  serverCredential?: RunnerServerCredentialRegistration;
  now?: string;
}

export interface PlannedWorkspaceRegistration {
  serverUrl: string;
  localPath: string;
  localWorkspaceKey: string;
  displayName: string;
}

export interface RunnerServerCredentialRegistration {
  runtimeId: string;
  runtimeToken: string;
  runtimeTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export interface RunnerServerStatusSummary {
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

export function addWorkspace(db: DatabaseSync, options: AddWorkspaceOptions): RunnerWorkspace {
  const now = options.now ?? new Date().toISOString();
  const serverUrl = options.serverUrl ?? "";
  const localPath = normalizeLocalPath(options.localPath);
  assertWorkspaceSlotAvailable(db, serverUrl, localPath, options.localWorkspaceKey);
  const existing = getWorkspaceByKey(db, serverUrl, options.localWorkspaceKey);

  const workspace: RunnerWorkspace = {
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
): RunnerWorkspace {
  const planned = planWorkspaceRegistration(db, options);
  const now = options.now ?? new Date().toISOString();

  return withRunnerTransaction(db, () => {
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
    recordRunnerWorkspaceRegistration(db, workspace, options, now);
    return workspace;
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
  };
}

function recordRunnerWorkspaceRegistration(
  db: DatabaseSync,
  workspace: RunnerWorkspace,
  options: RegisterWorkspaceOptions,
  now: string,
): void {
  const serverId = ensureRunnerServer(db, workspace.serverUrl, now);
  if (options.serverCredential) {
    upsertRunnerServerCredential(db, serverId, options.serverCredential, now);
  }

  db.prepare(
    `INSERT INTO runner_workspaces
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
      `INSERT INTO runner_workspace_grants
        (id, runner_workspace_id, grant_token_hash, server_grant_id, created_at, consumed_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
    ).run(
      createRunnerLocalId("rngrant"),
      workspace.id,
      hashSecret(options.consumedRegistrationToken),
      now,
      now,
    );
  }
}

function ensureRunnerServer(db: DatabaseSync, serverUrl: string, now: string): string {
  const existing = db
    .prepare("SELECT id FROM runner_servers WHERE server_url = ? LIMIT 1")
    .get(serverUrl) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }

  const id = createRunnerLocalId("rnsrv");
  db.prepare(
    `INSERT INTO runner_servers
      (id, server_url, first_registered_at)
     VALUES (?, ?, ?)`,
  ).run(id, serverUrl, now);
  return id;
}

function upsertRunnerServerCredential(
  db: DatabaseSync,
  serverId: string,
  credential: RunnerServerCredentialRegistration,
  now: string,
): void {
  const existing = db
    .prepare(
      "SELECT id, created_at AS createdAt FROM runner_server_credentials WHERE server_id = ?",
    )
    .get(serverId) as { id: string; createdAt: string } | undefined;
  db.prepare(
    `INSERT INTO runner_server_credentials
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
    existing?.id ?? createRunnerLocalId("rncred"),
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

function updateRunnerWorkspaceStatus(
  db: DatabaseSync,
  workspaceId: string,
  status: RuntimeWorkspaceBindingSummary["status"],
  diagnostics: Record<string, unknown>,
  now: string,
): void {
  db.prepare(
    `UPDATE runner_workspaces
     SET last_known_status = ?,
         last_known_offline_reason = ?,
         last_status_changed_at = ?
     WHERE id = ?`,
  ).run(status, offlineReasonForStatus(status, diagnostics), now, workspaceId);
}

export function markRunnerServerConnected(
  db: DatabaseSync,
  serverUrl: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE runner_servers
     SET last_connected_at = ?,
         last_disconnect_reason = NULL
     WHERE server_url = ?`,
  ).run(now, serverUrl);
}

export function markServerWorkspacesDisconnected(
  db: DatabaseSync,
  serverUrl: string,
  reason = "server.unreachable",
  now = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE runner_servers
     SET last_disconnect_reason = ?
     WHERE server_url = ?`,
  ).run(reason, serverUrl);

  for (const workspace of listWorkspaces(db)) {
    if (workspace.serverUrl !== serverUrl || isUserDetachedWorkspace(workspace)) {
      continue;
    }

    const diagnostics = {
      ...workspace.diagnostics,
      serverDisconnected: true,
      reason,
      checkedAt: now,
    };
    db.prepare(
      `UPDATE workspaces
       SET status = 'unavailable',
           diagnostics_json = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(diagnostics), now, workspace.id);
    updateRunnerWorkspaceStatus(db, workspace.id, "unavailable", diagnostics, now);
  }
}

export function runnerServerStatusSummaries(db: DatabaseSync): RunnerServerStatusSummary[] {
  const rows = db
    .prepare(
      `SELECT rs.server_url AS url,
              rs.last_connected_at AS lastHeartbeatAt,
              rs.last_disconnect_reason AS lastDisconnectReason,
              COUNT(rw.id) AS workspaceCount
       FROM runner_servers rs
       LEFT JOIN runner_workspaces rw ON rw.server_id = rs.id
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

function createRunnerLocalId(prefix: "rnsrv" | "rncred" | "rngrant"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function withRunnerTransaction<T>(db: DatabaseSync, operation: () => T): T {
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

export function listWorkspaces(db: DatabaseSync): RunnerWorkspace[] {
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

export function getWorkspaceById(db: DatabaseSync, id: string): RunnerWorkspace | null {
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

export function getWorkspaceByKey(
  db: DatabaseSync,
  serverUrl: string,
  localWorkspaceKey: string,
): RunnerWorkspace | null {
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

export function getWorkspaceByPath(db: DatabaseSync, localPath: string): RunnerWorkspace | null {
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
): RunnerWorkspace | null {
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
): { kind: "same-path" | "nested"; workspace: RunnerWorkspace } | null {
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

export function stopWorkspace(db: DatabaseSync, options: StopWorkspaceOptions): RunnerWorkspace {
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
  updateRunnerWorkspaceStatus(db, workspace.id, "unavailable", diagnostics, now);

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
): RunnerWorkspace {
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
  updateRunnerWorkspaceStatus(db, workspace.id, "available", {}, now);

  return {
    ...workspace,
    status: "available",
    diagnostics: {},
    updatedAt: now,
  };
}

export function isUserDetachedWorkspace(workspace: RunnerWorkspace): boolean {
  return workspace.diagnostics.userDetached === true;
}

export function reconcileWorkspaces(
  db: DatabaseSync,
  now = new Date().toISOString(),
): RunnerWorkspace[] {
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
    updateRunnerWorkspaceStatus(db, workspace.id, status, diagnostics, now);
    return { ...workspace, status, diagnostics, updatedAt: now };
  });
}

export function workspaceSummaries(db: DatabaseSync): RuntimeWorkspaceBindingSummary[] {
  return listWorkspaces(db).map((workspace) => ({
    bindingId: workspace.id,
    localWorkspaceKey: workspace.localWorkspaceKey,
    displayName: workspace.displayName,
    status: workspace.status,
    capabilities: workspace.capabilities,
    diagnostics: workspace.diagnostics,
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

function mapWorkspaceRow(row: WorkspaceRow, db?: DatabaseSync): RunnerWorkspace {
  const projection = db ? workspaceInvocationProjection(db, row.id) : {};
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
    updatedAt: row.updatedAt,
  };
}

function workspaceInvocationProjection(
  db: DatabaseSync,
  workspaceId: string,
): Pick<RunnerWorkspace, "sessionCount" | "lastSessionAt" | "recentSessions"> {
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
