import { randomBytes } from "node:crypto";
import {
  createId,
  runtimeProtocolVersion,
  type RuntimeRegistrationRequest,
  type RuntimeWorkspaceRegistrationRequest,
} from "@zendev-lab/spark-protocol";
import { asciiSlug } from "@zendev-lab/navia-system";
import { hashSecret } from "./auth";
import type { DatabaseSync } from "node:sqlite";

export interface RegisteredRuntime {
  runtimeId: string;
  runtimeToken: string;
  runtimeTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  registeredAt: string;
  workspaceBinding?: RegisteredWorkspaceBinding;
}

export type RefreshedRuntimeToken = Omit<RegisteredRuntime, "registeredAt"> & {
  refreshedAt: string;
};

export interface RegisteredWorkspaceBinding {
  workspaceId: string;
  bindingId: string;
  localWorkspaceKey: string;
  displayName: string;
  status: "available";
}

export interface RegisteredRuntimeWorkspace {
  runtimeId: string;
  registeredAt: string;
  workspaceBinding: RegisteredWorkspaceBinding;
}

export interface RuntimeEnrollmentToken {
  id: string;
  refreshToken: string;
  createdAt: string;
  expiresAt: string;
  workspaceName: string | null;
  workspaceSlug: string | null;
}

export interface RuntimeEnrollmentTokenSummary {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  createdRuntimeId: string | null;
  runtimeName: string | null;
  workspaceName: string | null;
  workspaceSlug: string | null;
  workspaceId: string | null;
}

export class RuntimeEnrollmentError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
  }
}

export class RuntimeTokenRefreshError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
  }
}

export class RuntimeAccessTokenError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
  }
}

const runtimeAccessTokenTtlMs = 60 * 60 * 1000;
const runtimeRefreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;

export function createRuntimeToken(): string {
  return `spark_rt_${randomBytes(32).toString("base64url")}`;
}

export function createRuntimeRefreshToken(): string {
  return `spark_rt_refresh_${randomBytes(32).toString("base64url")}`;
}

export function createRuntimeEnrollmentToken(
  db: DatabaseSync,
  input: {
    label?: string | null;
    createdByUserId?: string | null;
    workspaceName?: string | null;
    workspaceSlug?: string | null;
    workspaceId?: string | null;
    ttlMs?: number;
    createdAt?: string;
  } = {},
): RuntimeEnrollmentToken {
  const createdAtDate = input.createdAt ? new Date(input.createdAt) : new Date();
  const createdAt = createdAtDate.toISOString();
  const expiresAt = new Date(createdAtDate.getTime() + (input.ttlMs ?? 86_400_000)).toISOString();
  const refreshToken = `spark_wsreg_${randomBytes(32).toString("base64url")}`;
  const id = createId("rtetok");

  db.prepare(
    `INSERT INTO runtime_enrollment_tokens
      (id, token_hash, label, scopes_json, created_by_user_id, workspace_name, workspace_slug, workspace_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    hashSecret(refreshToken),
    input.label ?? "Spark workspace registration token",
    JSON.stringify(["workspace:register", "runtime:refresh"]),
    input.createdByUserId ?? null,
    input.workspaceName ?? null,
    input.workspaceSlug ?? null,
    input.workspaceId ?? null,
    createdAt,
    expiresAt,
  );

  return {
    id,
    refreshToken,
    createdAt,
    expiresAt,
    workspaceName: input.workspaceName ?? null,
    workspaceSlug: input.workspaceSlug ?? null,
  };
}

export function listRuntimeEnrollmentTokens(
  db: DatabaseSync,
  input: {
    limit?: number;
    includeRevoked?: boolean;
    workspaceId?: string;
    workspaceSlug?: string;
  } = {},
): RuntimeEnrollmentTokenSummary[] {
  return db
    .prepare(
      `SELECT et.id,
              et.label,
              et.created_at AS createdAt,
              et.expires_at AS expiresAt,
              et.used_at AS usedAt,
              et.revoked_at AS revokedAt,
              et.created_runtime_id AS createdRuntimeId,
              et.workspace_name AS workspaceName,
              et.workspace_slug AS workspaceSlug,
              et.workspace_id AS workspaceId,
              rc.name AS runtimeName
       FROM runtime_enrollment_tokens et
       LEFT JOIN runtime_connections rc ON rc.id = et.created_runtime_id
       WHERE (? = 1 OR et.revoked_at IS NULL)
         AND (
           ? IS NULL
           OR et.workspace_id = ?
           OR (et.workspace_id IS NULL AND et.workspace_slug = ?)
         )
       ORDER BY et.created_at DESC
       LIMIT ?`,
    )
    .all(
      input.includeRevoked ? 1 : 0,
      input.workspaceId ?? null,
      input.workspaceId ?? null,
      input.workspaceSlug ?? null,
      input.limit ?? 50,
    ) as unknown as RuntimeEnrollmentTokenSummary[];
}

export function revokeRuntimeEnrollmentToken(
  db: DatabaseSync,
  input: { id: string; revokedAt?: string },
): boolean {
  const result = db
    .prepare(
      `UPDATE runtime_enrollment_tokens
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .run(input.revokedAt ?? new Date().toISOString(), input.id);

  return result.changes === 1;
}

export function bindRuntimeRefreshTokenToWorkspace(
  db: DatabaseSync,
  input: { tokenId: string; workspaceId: string },
): void {
  db.prepare(
    `UPDATE runtime_enrollment_tokens
     SET workspace_id = COALESCE(workspace_id, ?)
     WHERE id = ?`,
  ).run(input.workspaceId, input.tokenId);
}

export function registerRuntime(
  db: DatabaseSync,
  request: RuntimeRegistrationRequest,
  enrollmentToken: string | null,
): RegisteredRuntime {
  const now = new Date().toISOString();
  const enrollment = consumeRuntimeEnrollmentToken(db, enrollmentToken, now);
  const credentials = createRuntimeCredentials(now);

  db.exec("BEGIN");
  try {
    const existing = db
      .prepare("SELECT id FROM runtime_connections WHERE installation_id = ? LIMIT 1")
      .get(request.installationId) as { id: string } | undefined;

    const runtimeId = existing?.id ?? createId("rt");

    if (existing) {
      db.prepare(
        `UPDATE runtime_connections
         SET name = ?, protocol_version = ?, capabilities_json = ?, labels_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        request.displayName,
        runtimeProtocolVersion,
        JSON.stringify({ supportedFeatures: request.supportedFeatures }),
        JSON.stringify(request.labels),
        now,
        runtimeId,
      );
    } else {
      db.prepare(
        `INSERT INTO runtime_connections
          (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
         VALUES (?, ?, ?, 'offline', ?, ?, ?, ?, ?)`,
      ).run(
        runtimeId,
        request.installationId,
        request.displayName,
        runtimeProtocolVersion,
        JSON.stringify({ supportedFeatures: request.supportedFeatures }),
        JSON.stringify(request.labels),
        now,
        now,
      );
    }

    revokeActiveRuntimeTokens(db, runtimeId, now);
    insertRuntimeToken(db, {
      runtimeId,
      token: credentials.runtimeToken,
      label: "runtime access token",
      scopes: ["runtime:connect"],
      createdAt: now,
      expiresAt: credentials.runtimeTokenExpiresAt,
    });
    insertRuntimeToken(db, {
      runtimeId,
      token: credentials.refreshToken,
      label: "runtime refresh token",
      scopes: ["runtime:refresh"],
      createdAt: now,
      expiresAt: credentials.refreshTokenExpiresAt,
    });

    const consumed = db
      .prepare(
        `UPDATE runtime_enrollment_tokens
       SET used_at = ?, created_runtime_id = ?
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .run(now, runtimeId, enrollment.id);
    if (consumed.changes !== 1) {
      throw new RuntimeEnrollmentError(
        "Workspace registration token was already consumed.",
        "WORKSPACE_REGISTRATION_TOKEN_USED",
      );
    }

    const workspaceBinding = maybeCreateWorkspaceRegistrationBinding(
      db,
      runtimeId,
      enrollment,
      request.workspaceRegistration,
      now,
    );

    db.exec("COMMIT");
    return {
      runtimeId,
      ...credentials,
      registeredAt: now,
      ...(workspaceBinding ? { workspaceBinding } : {}),
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function registerRuntimeWorkspace(
  db: DatabaseSync,
  runtimeId: string,
  request: RuntimeWorkspaceRegistrationRequest,
  runtimeToken: string | null,
): RegisteredRuntimeWorkspace {
  const now = new Date().toISOString();
  authenticateRuntimeAccessToken(db, runtimeId, runtimeToken, now);
  const enrollment = consumeRuntimeEnrollmentToken(db, request.registrationToken, now);

  db.exec("BEGIN");
  try {
    const consumed = db
      .prepare(
        `UPDATE runtime_enrollment_tokens
         SET used_at = ?, created_runtime_id = ?
         WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .run(now, runtimeId, enrollment.id);
    if (consumed.changes !== 1) {
      throw new RuntimeEnrollmentError(
        "Workspace registration token was already consumed.",
        "WORKSPACE_REGISTRATION_TOKEN_USED",
      );
    }

    const workspaceBinding = maybeCreateWorkspaceRegistrationBinding(
      db,
      runtimeId,
      enrollment,
      request.workspaceRegistration,
      now,
    );
    if (!workspaceBinding) {
      throw new RuntimeEnrollmentError(
        "Workspace registration payload is required for this token.",
        "WORKSPACE_REGISTRATION_PAYLOAD_REQUIRED",
      );
    }

    db.exec("COMMIT");
    return { runtimeId, registeredAt: now, workspaceBinding };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function refreshRuntimeToken(
  db: DatabaseSync,
  input: {
    runtimeId: string;
    refreshToken: string | null;
    refreshedAt?: string;
  },
): RefreshedRuntimeToken {
  const refreshedAt = input.refreshedAt ?? new Date().toISOString();

  if (!input.refreshToken) {
    throw new RuntimeTokenRefreshError(
      "Runtime refresh token is required.",
      "REFRESH_TOKEN_REQUIRED",
    );
  }

  const credentials = createRuntimeCredentials(refreshedAt);

  db.exec("BEGIN");
  try {
    const refreshToken = db
      .prepare(
        `SELECT id,
                scopes_json AS scopesJson,
                expires_at AS expiresAt,
                revoked_at AS revokedAt
         FROM runtime_tokens
         WHERE runtime_id = ? AND token_hash = ?
         LIMIT 1`,
      )
      .get(input.runtimeId, hashSecret(input.refreshToken)) as
      | {
          id: string;
          scopesJson: string;
          expiresAt: string | null;
          revokedAt: string | null;
        }
      | undefined;

    validateRuntimeRefreshToken(refreshToken, refreshedAt);

    const consumed = db
      .prepare(
        `UPDATE runtime_tokens
         SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(refreshedAt, refreshToken.id);
    if (consumed.changes !== 1) {
      throw new RuntimeTokenRefreshError(
        "Runtime refresh token has already been used.",
        "REFRESH_TOKEN_USED",
      );
    }

    revokeActiveRuntimeAccessTokens(db, input.runtimeId, refreshedAt);
    insertRuntimeToken(db, {
      runtimeId: input.runtimeId,
      token: credentials.runtimeToken,
      label: "runtime access token",
      scopes: ["runtime:connect"],
      createdAt: refreshedAt,
      expiresAt: credentials.runtimeTokenExpiresAt,
    });
    insertRuntimeToken(db, {
      runtimeId: input.runtimeId,
      token: credentials.refreshToken,
      label: "runtime refresh token",
      scopes: ["runtime:refresh"],
      createdAt: refreshedAt,
      expiresAt: credentials.refreshTokenExpiresAt,
    });

    db.exec("COMMIT");
    return { runtimeId: input.runtimeId, ...credentials, refreshedAt };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function consumeRuntimeEnrollmentToken(
  db: DatabaseSync,
  enrollmentToken: string | null,
  now: string,
) {
  if (!enrollmentToken) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token is required.",
      "WORKSPACE_REGISTRATION_TOKEN_REQUIRED",
    );
  }

  const enrollment = db
    .prepare(
      `SELECT id,
              workspace_id AS workspaceId,
              workspace_name AS workspaceName,
              workspace_slug AS workspaceSlug,
              expires_at AS expiresAt,
              used_at AS usedAt,
              revoked_at AS revokedAt
       FROM runtime_enrollment_tokens
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .get(hashSecret(enrollmentToken)) as
    | {
        id: string;
        workspaceId: string | null;
        workspaceName: string | null;
        workspaceSlug: string | null;
        expiresAt: string | null;
        usedAt: string | null;
        revokedAt: string | null;
      }
    | undefined;

  if (!enrollment) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token is invalid.",
      "WORKSPACE_REGISTRATION_TOKEN_INVALID",
    );
  }

  if (enrollment.revokedAt) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token has been revoked.",
      "WORKSPACE_REGISTRATION_TOKEN_REVOKED",
    );
  }

  if (enrollment.usedAt) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token has already been used.",
      "WORKSPACE_REGISTRATION_TOKEN_USED",
    );
  }

  if (enrollment.expiresAt && enrollment.expiresAt <= now) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token has expired.",
      "WORKSPACE_REGISTRATION_TOKEN_EXPIRED",
    );
  }

  return enrollment;
}

function createRuntimeCredentials(nowIso: string) {
  const now = new Date(nowIso);
  return {
    runtimeToken: createRuntimeToken(),
    runtimeTokenExpiresAt: new Date(now.getTime() + runtimeAccessTokenTtlMs).toISOString(),
    refreshToken: createRuntimeRefreshToken(),
    refreshTokenExpiresAt: new Date(now.getTime() + runtimeRefreshTokenTtlMs).toISOString(),
  };
}

type RuntimeEnrollmentRow = ReturnType<typeof consumeRuntimeEnrollmentToken>;

function maybeCreateWorkspaceRegistrationBinding(
  db: DatabaseSync,
  runtimeId: string,
  enrollment: RuntimeEnrollmentRow,
  workspaceRegistration: RuntimeRegistrationRequest["workspaceRegistration"],
  now: string,
): RegisteredWorkspaceBinding | undefined {
  if (!workspaceRegistration && !enrollment.workspaceId && !enrollment.workspaceSlug) {
    return undefined;
  }

  if (!workspaceRegistration) {
    throw new RuntimeEnrollmentError(
      "Workspace registration payload is required for this token.",
      "WORKSPACE_REGISTRATION_PAYLOAD_REQUIRED",
    );
  }

  const workspace = resolveRegisteredWorkspace(db, enrollment, workspaceRegistration, now);
  const binding = upsertRegisteredWorkspaceBinding(db, runtimeId, workspaceRegistration, now);
  replaceActiveOwnerBinding(db, workspace.id, binding.bindingId, now);
  db.prepare(
    `UPDATE runtime_enrollment_tokens
     SET workspace_id = COALESCE(workspace_id, ?),
         workspace_name = COALESCE(workspace_name, ?),
         workspace_slug = COALESCE(workspace_slug, ?)
     WHERE id = ?`,
  ).run(workspace.id, workspace.name, workspace.slug, enrollment.id);

  return {
    workspaceId: workspace.id,
    bindingId: binding.bindingId,
    localWorkspaceKey: workspaceRegistration.localWorkspaceKey,
    displayName: workspaceRegistration.displayName,
    status: "available",
  };
}

function resolveRegisteredWorkspace(
  db: DatabaseSync,
  enrollment: RuntimeEnrollmentRow,
  workspaceRegistration: NonNullable<RuntimeRegistrationRequest["workspaceRegistration"]>,
  now: string,
): { id: string; slug: string; name: string } {
  if (enrollment.workspaceId) {
    const workspace = db
      .prepare("SELECT id, slug, name FROM workspaces WHERE id = ? AND status = 'active'")
      .get(enrollment.workspaceId) as { id: string; slug: string; name: string } | undefined;
    if (!workspace) {
      throw new RuntimeEnrollmentError(
        "Workspace registration token references an unavailable workspace.",
        "WORKSPACE_REGISTRATION_WORKSPACE_UNAVAILABLE",
      );
    }
    return workspace;
  }

  const slug =
    enrollment.workspaceSlug ??
    workspaceRegistration.workspaceSlug ??
    slugify(workspaceRegistration.displayName);
  const name =
    enrollment.workspaceName ??
    workspaceRegistration.workspaceName ??
    workspaceRegistration.displayName;
  const existing = db
    .prepare("SELECT id, slug, name FROM workspaces WHERE slug = ? AND status = 'active'")
    .get(slug) as { id: string; slug: string; name: string } | undefined;
  if (existing) {
    return existing;
  }

  const workspace = { id: createId("ws"), slug, name };
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, description, status, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'active', '{}', ?, ?)`,
  ).run(workspace.id, workspace.slug, workspace.name, now, now);
  return workspace;
}

function upsertRegisteredWorkspaceBinding(
  db: DatabaseSync,
  runtimeId: string,
  workspaceRegistration: NonNullable<RuntimeRegistrationRequest["workspaceRegistration"]>,
  now: string,
): { bindingId: string } {
  const existing = db
    .prepare(
      `SELECT id
       FROM runtime_workspace_bindings
       WHERE runtime_id = ? AND local_workspace_key = ?
       LIMIT 1`,
    )
    .get(runtimeId, workspaceRegistration.localWorkspaceKey) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE runtime_workspace_bindings
       SET display_name = ?,
           status = 'available',
           updated_at = ?
       WHERE id = ?`,
    ).run(workspaceRegistration.displayName, now, existing.id);
    return { bindingId: existing.id };
  }

  const bindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'available', '{}', '{}', ?, ?)`,
  ).run(
    bindingId,
    runtimeId,
    workspaceRegistration.localWorkspaceKey,
    workspaceRegistration.displayName,
    now,
    now,
  );
  return { bindingId };
}

function replaceActiveOwnerBinding(
  db: DatabaseSync,
  workspaceId: string,
  runtimeWorkspaceBindingId: string,
  now: string,
): void {
  const active = db
    .prepare(
      `SELECT runtime_workspace_binding_id AS runtimeWorkspaceBindingId
       FROM workspace_owner_bindings
       WHERE workspace_id = ? AND ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { runtimeWorkspaceBindingId: string } | undefined;
  if (active?.runtimeWorkspaceBindingId === runtimeWorkspaceBindingId) {
    return;
  }

  db.prepare(
    `UPDATE workspace_owner_bindings
     SET ended_at = ?
     WHERE workspace_id = ? AND ended_at IS NULL`,
  ).run(now, workspaceId);
  db.prepare(
    `INSERT INTO workspace_owner_bindings
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
     VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
  ).run(createId("wob"), workspaceId, runtimeWorkspaceBindingId, now, now);
}

function slugify(value: string): string {
  return asciiSlug(value, { fallback: "workspace" });
}

function insertRuntimeToken(
  db: DatabaseSync,
  input: {
    runtimeId: string;
    token: string;
    label: string;
    scopes: string[];
    createdAt: string;
    expiresAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO runtime_tokens
      (id, runtime_id, token_hash, label, scopes_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    createId("rttok"),
    input.runtimeId,
    hashSecret(input.token),
    input.label,
    JSON.stringify(input.scopes),
    input.createdAt,
    input.expiresAt,
  );
}

function revokeActiveRuntimeTokens(db: DatabaseSync, runtimeId: string, revokedAt: string): void {
  db.prepare(
    `UPDATE runtime_tokens
     SET revoked_at = ?
     WHERE runtime_id = ? AND revoked_at IS NULL`,
  ).run(revokedAt, runtimeId);
}

function revokeActiveRuntimeAccessTokens(
  db: DatabaseSync,
  runtimeId: string,
  revokedAt: string,
): void {
  db.prepare(
    `UPDATE runtime_tokens
     SET revoked_at = ?
     WHERE runtime_id = ?
       AND revoked_at IS NULL
      AND scopes_json LIKE '%runtime:connect%'`,
  ).run(revokedAt, runtimeId);
}

function authenticateRuntimeAccessToken(
  db: DatabaseSync,
  runtimeId: string,
  runtimeToken: string | null,
  now: string,
): void {
  if (!runtimeToken) {
    throw new RuntimeAccessTokenError(
      "Runtime access token is required.",
      "RUNTIME_TOKEN_REQUIRED",
    );
  }

  const token = db
    .prepare(
      `SELECT scopes_json AS scopesJson,
              expires_at AS expiresAt,
              revoked_at AS revokedAt
       FROM runtime_tokens
       WHERE runtime_id = ? AND token_hash = ?
       LIMIT 1`,
    )
    .get(runtimeId, hashSecret(runtimeToken)) as
    | { scopesJson: string; expiresAt: string | null; revokedAt: string | null }
    | undefined;

  if (!token) {
    throw new RuntimeAccessTokenError("Runtime access token is invalid.", "RUNTIME_TOKEN_INVALID");
  }
  if (token.revokedAt) {
    throw new RuntimeAccessTokenError(
      "Runtime access token has been revoked.",
      "RUNTIME_TOKEN_REVOKED",
    );
  }
  if (token.expiresAt && token.expiresAt <= now) {
    throw new RuntimeAccessTokenError("Runtime access token has expired.", "RUNTIME_TOKEN_EXPIRED");
  }
  if (!parseScopes(token.scopesJson).includes("runtime:connect")) {
    throw new RuntimeAccessTokenError(
      "Runtime token is not allowed to register workspaces.",
      "RUNTIME_TOKEN_SCOPE_INVALID",
    );
  }
}

function validateRuntimeRefreshToken(
  token:
    | {
        scopesJson: string;
        expiresAt: string | null;
        revokedAt: string | null;
      }
    | undefined,
  now: string,
): asserts token is {
  id: string;
  scopesJson: string;
  expiresAt: string | null;
  revokedAt: string | null;
} {
  if (!token) {
    throw new RuntimeTokenRefreshError(
      "Runtime refresh token is invalid.",
      "REFRESH_TOKEN_INVALID",
    );
  }

  if (token.revokedAt) {
    throw new RuntimeTokenRefreshError(
      "Runtime refresh token has already been used or revoked.",
      "REFRESH_TOKEN_USED",
    );
  }

  if (token.expiresAt && token.expiresAt <= now) {
    throw new RuntimeTokenRefreshError(
      "Runtime refresh token has expired.",
      "REFRESH_TOKEN_EXPIRED",
    );
  }

  if (!parseScopes(token.scopesJson).includes("runtime:refresh")) {
    throw new RuntimeTokenRefreshError(
      "Runtime token is not allowed to refresh credentials.",
      "REFRESH_TOKEN_SCOPE_INVALID",
    );
  }
}

function parseScopes(scopesJson: string): string[] {
  try {
    const scopes = JSON.parse(scopesJson) as unknown;
    return Array.isArray(scopes)
      ? scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
  } catch {
    return [];
  }
}
