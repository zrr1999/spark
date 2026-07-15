import { randomBytes } from "node:crypto";
import {
  createId,
  runtimeDeviceAuthorizationRequestSchema,
  runtimeProtocolVersion,
  type RuntimeDeviceAuthorizationRequest,
  type RuntimeRegistrationRequest,
  type RuntimeWorkspaceRegistrationRequest,
} from "@zendev-lab/spark-protocol";
import { asciiSlug } from "@zendev-lab/spark-system";
import { appendEvent } from "./projection-services.ts";
import { hashSecret } from "./security.ts";
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

export interface CreatedRuntimeDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  createdAt: string;
  expiresAt: string;
  expiresIn: number;
  interval: number;
}

export type RuntimeDeviceAuthorizationStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

export interface RuntimeDeviceAuthorizationApproval {
  id: string;
  userCode: string;
  installationId: string;
  displayName: string;
  registration: RuntimeDeviceAuthorizationRequest;
  status: RuntimeDeviceAuthorizationStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  deniedAt: string | null;
  consumedAt: string | null;
}

export class RuntimeEnrollmentError extends Error {
  readonly reasonCode: string;

  constructor(message: string, reasonCode: string) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export class RuntimeTokenRefreshError extends Error {
  readonly reasonCode: string;

  constructor(message: string, reasonCode: string) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export class RuntimeAccessTokenError extends Error {
  readonly reasonCode: string;

  constructor(message: string, reasonCode: string) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

type RuntimeDeviceAuthorizationReasonCode =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "approval_forbidden"
  | "too_many_pending_authorizations"
  | "authorization_capacity_exceeded";

export class RuntimeDeviceAuthorizationError extends Error {
  readonly reasonCode: RuntimeDeviceAuthorizationReasonCode;

  constructor(message: string, reasonCode: RuntimeDeviceAuthorizationReasonCode) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export interface RuntimeWorkspaceOwnerConflict {
  workspaceId: string;
  currentRuntimeId: string;
  currentBindingId: string;
  attemptedRuntimeId: string;
  attemptedBindingId: string;
  occurredAt: string;
}

export class RuntimeWorkspaceOwnerConflictError extends Error {
  readonly reasonCode = "WORKSPACE_OWNER_CONFLICT";
  readonly conflict: RuntimeWorkspaceOwnerConflict;

  constructor(conflict: RuntimeWorkspaceOwnerConflict) {
    super("Workspace already has an active daemon owner.");
    this.conflict = conflict;
  }
}

const runtimeAccessTokenTtlMs = 60 * 60 * 1000;
const runtimeRefreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;
const runtimeDeviceAuthorizationTtlMs = 10 * 60 * 1000;
const runtimeDeviceAuthorizationIntervalSeconds = 5;
const runtimeDeviceAuthorizationRetentionMs = 60 * 60 * 1000;
const runtimeDeviceAuthorizationMaxPendingPerInstallation = 3;
const runtimeDeviceAuthorizationMaxPendingGlobal = 256;
const runtimeDeviceUserCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createRuntimeToken(): string {
  return `spark_rt_${randomBytes(32).toString("base64url")}`;
}

export function createRuntimeRefreshToken(): string {
  return `spark_rt_refresh_${randomBytes(32).toString("base64url")}`;
}

export function createRuntimeDeviceAuthorization(
  db: DatabaseSync,
  request: RuntimeDeviceAuthorizationRequest,
  input: {
    createdAt?: string;
    ttlMs?: number;
    intervalSeconds?: number;
    retentionMs?: number;
    maxPendingPerInstallation?: number;
    maxPendingGlobal?: number;
  } = {},
): CreatedRuntimeDeviceAuthorization {
  const registration = runtimeDeviceAuthorizationRequestSchema.parse(request);
  const createdAtDate = input.createdAt ? new Date(input.createdAt) : new Date();
  const createdAt = createdAtDate.toISOString();
  const ttlMs = input.ttlMs ?? runtimeDeviceAuthorizationTtlMs;
  const interval = input.intervalSeconds ?? runtimeDeviceAuthorizationIntervalSeconds;
  const retentionMs = input.retentionMs ?? runtimeDeviceAuthorizationRetentionMs;
  const maxPendingPerInstallation =
    input.maxPendingPerInstallation ?? runtimeDeviceAuthorizationMaxPendingPerInstallation;
  const maxPendingGlobal = input.maxPendingGlobal ?? runtimeDeviceAuthorizationMaxPendingGlobal;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Runtime device authorization TTL must be positive.");
  }
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new Error("Runtime device authorization polling interval must be a positive integer.");
  }
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error("Runtime device authorization retention must not be negative.");
  }
  if (!Number.isInteger(maxPendingPerInstallation) || maxPendingPerInstallation <= 0) {
    throw new Error("Runtime device authorization installation limit must be a positive integer.");
  }
  if (!Number.isInteger(maxPendingGlobal) || maxPendingGlobal <= 0) {
    throw new Error("Runtime device authorization global limit must be a positive integer.");
  }

  const expiresAt = new Date(createdAtDate.getTime() + ttlMs).toISOString();
  const cleanupBefore = new Date(createdAtDate.getTime() - retentionMs).toISOString();
  db.prepare(
    `DELETE FROM runtime_device_authorizations
     WHERE expires_at <= ?
        OR (denied_at IS NOT NULL AND denied_at <= ?)
        OR (consumed_at IS NOT NULL AND consumed_at <= ?)`,
  ).run(cleanupBefore, cleanupBefore, cleanupBefore);

  db.exec("BEGIN IMMEDIATE");
  try {
    const installationPending = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runtime_device_authorizations
         WHERE installation_id = ?
           AND approved_at IS NULL
           AND denied_at IS NULL
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .get(registration.installationId, createdAt) as { count: number };
    if (installationPending.count >= maxPendingPerInstallation) {
      throw new RuntimeDeviceAuthorizationError(
        "This daemon installation already has too many pending authorizations.",
        "too_many_pending_authorizations",
      );
    }

    const globalPending = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runtime_device_authorizations
         WHERE approved_at IS NULL
           AND denied_at IS NULL
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .get(createdAt) as { count: number };
    if (globalPending.count >= maxPendingGlobal) {
      throw new RuntimeDeviceAuthorizationError(
        "The Cockpit has reached its pending daemon authorization capacity.",
        "authorization_capacity_exceeded",
      );
    }

    const deviceCode = `spark_device_${randomBytes(32).toString("base64url")}`;
    const userCode = createRuntimeDeviceUserCode();
    db.prepare(
      `INSERT INTO runtime_device_authorizations
        (id, device_code_hash, user_code_hash, installation_id, display_name,
         registration_json, scopes_json, created_at, expires_at, interval_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId("rtda"),
      hashSecret(deviceCode),
      hashRuntimeDeviceUserCode(userCode),
      registration.installationId,
      registration.displayName,
      JSON.stringify(registration),
      JSON.stringify(["workspace:register", "runtime:refresh"]),
      createdAt,
      expiresAt,
      interval,
    );

    db.exec("COMMIT");
    return {
      deviceCode,
      userCode,
      createdAt,
      expiresAt,
      expiresIn: Math.floor(ttlMs / 1000),
      interval,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getRuntimeDeviceAuthorizationForApproval(
  db: DatabaseSync,
  input: { userCode: string; currentUserId: string | null; now?: string },
): RuntimeDeviceAuthorizationApproval {
  requireActiveOwner(db, input.currentUserId);
  const row = findRuntimeDeviceAuthorizationByUserCode(db, input.userCode);
  if (!row) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization code is invalid.",
      "invalid_grant",
    );
  }
  return runtimeDeviceAuthorizationApproval(
    row,
    input.userCode,
    input.now ?? new Date().toISOString(),
  );
}

export function approveRuntimeDeviceAuthorization(
  db: DatabaseSync,
  input: { userCode: string; approvedByUserId: string | null; approvedAt?: string },
): RuntimeDeviceAuthorizationApproval {
  const approvedAt = input.approvedAt ?? new Date().toISOString();
  requireActiveOwner(db, input.approvedByUserId);
  const row = findRuntimeDeviceAuthorizationByUserCode(db, input.userCode);
  validateRuntimeDeviceAuthorizationForDecision(row, approvedAt);

  if (row.approvedAt) {
    return runtimeDeviceAuthorizationApproval(row, input.userCode, approvedAt);
  }

  const updated = db
    .prepare(
      `UPDATE runtime_device_authorizations
       SET approved_by_user_id = ?, approved_at = ?
       WHERE id = ?
         AND approved_at IS NULL
         AND denied_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > ?`,
    )
    .run(input.approvedByUserId, approvedAt, row.id, approvedAt);
  if (updated.changes !== 1) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization can no longer be approved.",
      "invalid_grant",
    );
  }

  return getRuntimeDeviceAuthorizationForApproval(db, {
    userCode: input.userCode,
    currentUserId: input.approvedByUserId,
    now: approvedAt,
  });
}

export function denyRuntimeDeviceAuthorization(
  db: DatabaseSync,
  input: { userCode: string; deniedByUserId: string | null; deniedAt?: string },
): RuntimeDeviceAuthorizationApproval {
  const deniedAt = input.deniedAt ?? new Date().toISOString();
  requireActiveOwner(db, input.deniedByUserId);
  const row = findRuntimeDeviceAuthorizationByUserCode(db, input.userCode);
  validateRuntimeDeviceAuthorizationForDecision(row, deniedAt);
  if (row.approvedAt) {
    throw new RuntimeDeviceAuthorizationError(
      "Approved runtime device authorization cannot be denied.",
      "invalid_grant",
    );
  }

  const updated = db
    .prepare(
      `UPDATE runtime_device_authorizations
       SET denied_by_user_id = ?, denied_at = ?
       WHERE id = ?
         AND approved_at IS NULL
         AND denied_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > ?`,
    )
    .run(input.deniedByUserId, deniedAt, row.id, deniedAt);
  if (updated.changes !== 1) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization can no longer be denied.",
      "invalid_grant",
    );
  }

  return getRuntimeDeviceAuthorizationForApproval(db, {
    userCode: input.userCode,
    currentUserId: input.deniedByUserId,
    now: deniedAt,
  });
}

export function exchangeRuntimeDeviceAuthorization(
  db: DatabaseSync,
  input: { deviceCode: string; polledAt?: string },
): RegisteredRuntime {
  const polledAt = input.polledAt ?? new Date().toISOString();
  const deviceCodeHash = hashSecret(input.deviceCode);
  const initial = findRuntimeDeviceAuthorizationByDeviceCodeHash(db, deviceCodeHash);
  validateRuntimeDeviceAuthorizationForExchange(initial, polledAt);

  if (!initial.approvedAt) {
    const polledTooSoon =
      initial.lastPolledAt !== null &&
      new Date(polledAt).getTime() - new Date(initial.lastPolledAt).getTime() <
        initial.intervalSeconds * 1000;
    db.prepare(
      `UPDATE runtime_device_authorizations
       SET last_polled_at = ?
       WHERE id = ? AND consumed_at IS NULL`,
    ).run(polledAt, initial.id);
    throw new RuntimeDeviceAuthorizationError(
      polledTooSoon
        ? "Runtime device authorization is being polled too quickly."
        : "Runtime device authorization is waiting for browser approval.",
      polledTooSoon ? "slow_down" : "authorization_pending",
    );
  }

  return withRuntimeRegistrationTransaction(db, () => {
    const authorization = findRuntimeDeviceAuthorizationByDeviceCodeHash(db, deviceCodeHash);
    validateRuntimeDeviceAuthorizationForExchange(authorization, polledAt);
    if (!authorization.approvedAt) {
      throw new RuntimeDeviceAuthorizationError(
        "Runtime device authorization is waiting for browser approval.",
        "authorization_pending",
      );
    }

    const registration = parseRuntimeDeviceRegistration(authorization.registrationJson);
    const grantScopes = parseScopes(authorization.scopesJson);
    if (!grantScopes.includes("workspace:register")) {
      throw new RuntimeDeviceAuthorizationError(
        "Runtime device authorization does not grant workspace registration.",
        "invalid_grant",
      );
    }

    const workspaceGrant = emptyWorkspaceGrant();
    const runtimeId = resolveRuntimeRegistrationId(db, registration.installationId);
    const preparedWorkspace = prepareWorkspaceRegistration(
      db,
      runtimeId,
      workspaceGrant,
      registration.workspaceRegistration,
      polledAt,
    );
    const registered = registerRuntimeInTransaction(
      db,
      runtimeId,
      registration,
      grantScopes,
      workspaceGrant,
      preparedWorkspace,
      polledAt,
    );
    const consumed = db
      .prepare(
        `UPDATE runtime_device_authorizations
         SET consumed_at = ?, created_runtime_id = ?
         WHERE id = ?
           AND approved_at IS NOT NULL
           AND denied_at IS NULL
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .run(polledAt, registered.runtimeId, authorization.id, polledAt);
    if (consumed.changes !== 1) {
      throw new RuntimeDeviceAuthorizationError(
        "Runtime device authorization has already been consumed.",
        "invalid_grant",
      );
    }

    return registered;
  });
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
  return withRuntimeRegistrationTransaction(db, () => {
    const enrollment = consumeRuntimeEnrollmentToken(db, enrollmentToken, now);
    const workspaceGrant = workspaceGrantFromEnrollment(enrollment);
    const runtimeId = resolveRuntimeRegistrationId(db, request.installationId);
    const preparedWorkspace = prepareWorkspaceRegistration(
      db,
      runtimeId,
      workspaceGrant,
      request.workspaceRegistration,
      now,
    );
    const consumed = db
      .prepare(
        `UPDATE runtime_enrollment_tokens
       SET used_at = ?, created_runtime_id = ?
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .run(now, null, enrollment.id);
    if (consumed.changes !== 1) {
      throw new RuntimeEnrollmentError(
        "Workspace registration token was already consumed.",
        "WORKSPACE_REGISTRATION_TOKEN_USED",
      );
    }

    const registered = registerRuntimeInTransaction(
      db,
      runtimeId,
      request,
      [],
      workspaceGrant,
      preparedWorkspace,
      now,
    );
    db.prepare(
      `UPDATE runtime_enrollment_tokens
       SET created_runtime_id = ?
       WHERE id = ?`,
    ).run(registered.runtimeId, enrollment.id);

    return registered;
  });
}

export function registerRuntimeWorkspace(
  db: DatabaseSync,
  runtimeId: string,
  request: RuntimeWorkspaceRegistrationRequest,
  runtimeToken: string | null,
): RegisteredRuntimeWorkspace {
  const now = new Date().toISOString();
  const usesEnrollmentToken = request.registrationToken !== undefined;
  return withRuntimeRegistrationTransaction(db, () => {
    authenticateRuntimeAccessToken(
      db,
      runtimeId,
      runtimeToken,
      now,
      usesEnrollmentToken ? ["runtime:connect"] : ["runtime:connect", "workspace:register"],
    );

    let workspaceGrant: RuntimeWorkspaceGrant;
    if (usesEnrollmentToken) {
      const enrollment = consumeRuntimeEnrollmentToken(db, request.registrationToken ?? null, now);
      workspaceGrant = workspaceGrantFromEnrollment(enrollment);
    } else {
      workspaceGrant = emptyWorkspaceGrant();
    }

    const preparedWorkspace = prepareWorkspaceRegistration(
      db,
      runtimeId,
      workspaceGrant,
      request.workspaceRegistration,
      now,
    );
    if (workspaceGrant.enrollmentTokenId) {
      const consumed = db
        .prepare(
          `UPDATE runtime_enrollment_tokens
           SET used_at = ?, created_runtime_id = ?
           WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
        )
        .run(now, runtimeId, workspaceGrant.enrollmentTokenId);
      if (consumed.changes !== 1) {
        throw new RuntimeEnrollmentError(
          "Workspace registration token was already consumed.",
          "WORKSPACE_REGISTRATION_TOKEN_USED",
        );
      }
    }

    const workspaceBinding = completeWorkspaceRegistration(
      db,
      runtimeId,
      workspaceGrant,
      preparedWorkspace,
      now,
    );
    if (!workspaceBinding) {
      throw new RuntimeEnrollmentError(
        "Workspace registration payload is required for this token.",
        "WORKSPACE_REGISTRATION_PAYLOAD_REQUIRED",
      );
    }

    return { runtimeId, registeredAt: now, workspaceBinding };
  });
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

  db.exec("BEGIN IMMEDIATE");
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
    const grantScopes = parseScopes(refreshToken.scopesJson);
    const credentials = createRuntimeCredentials(refreshedAt);

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
      scopes: runtimeAccessScopesFromGrant(grantScopes),
      createdAt: refreshedAt,
      expiresAt: credentials.runtimeTokenExpiresAt,
    });
    insertRuntimeToken(db, {
      runtimeId: input.runtimeId,
      token: credentials.refreshToken,
      label: "runtime refresh token",
      scopes: runtimeRefreshScopesFromGrant(grantScopes),
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
              scopes_json AS scopesJson,
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
        scopesJson: string;
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

  const scopes = parseScopes(enrollment.scopesJson);
  if (!scopes.includes("workspace:register")) {
    throw new RuntimeEnrollmentError(
      "Workspace registration token does not grant workspace registration.",
      "WORKSPACE_REGISTRATION_TOKEN_SCOPE_INVALID",
    );
  }

  return { ...enrollment, scopes };
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

function resolveRuntimeRegistrationId(db: DatabaseSync, installationId: string): string {
  const existing = db
    .prepare("SELECT id FROM runtime_connections WHERE installation_id = ? LIMIT 1")
    .get(installationId) as { id: string } | undefined;
  return existing?.id ?? createId("rt");
}

function registerRuntimeInTransaction(
  db: DatabaseSync,
  runtimeId: string,
  request: RuntimeRegistrationRequest,
  grantScopes: string[],
  workspaceGrant: RuntimeWorkspaceGrant,
  preparedWorkspace: PreparedWorkspaceRegistration | undefined,
  now: string,
): RegisteredRuntime {
  const credentials = createRuntimeCredentials(now);
  const existing = db
    .prepare("SELECT 1 AS present FROM runtime_connections WHERE id = ? LIMIT 1")
    .get(runtimeId) as { present: number } | undefined;

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
    scopes: runtimeAccessScopesFromGrant(grantScopes),
    createdAt: now,
    expiresAt: credentials.runtimeTokenExpiresAt,
  });
  insertRuntimeToken(db, {
    runtimeId,
    token: credentials.refreshToken,
    label: "runtime refresh token",
    scopes: runtimeRefreshScopesFromGrant(grantScopes),
    createdAt: now,
    expiresAt: credentials.refreshTokenExpiresAt,
  });

  const workspaceBinding = completeWorkspaceRegistration(
    db,
    runtimeId,
    workspaceGrant,
    preparedWorkspace,
    now,
  );
  return {
    runtimeId,
    ...credentials,
    registeredAt: now,
    ...(workspaceBinding ? { workspaceBinding } : {}),
  };
}

type RuntimeEnrollmentRow = ReturnType<typeof consumeRuntimeEnrollmentToken>;

interface RuntimeWorkspaceGrant {
  enrollmentTokenId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceSlug: string | null;
}

function workspaceGrantFromEnrollment(enrollment: RuntimeEnrollmentRow): RuntimeWorkspaceGrant {
  return {
    enrollmentTokenId: enrollment.id,
    workspaceId: enrollment.workspaceId,
    workspaceName: enrollment.workspaceName,
    workspaceSlug: enrollment.workspaceSlug,
  };
}

function emptyWorkspaceGrant(): RuntimeWorkspaceGrant {
  return {
    enrollmentTokenId: null,
    workspaceId: null,
    workspaceName: null,
    workspaceSlug: null,
  };
}

interface PreparedWorkspaceRegistration {
  workspace: { id: string; slug: string; name: string };
  bindingId: string;
  workspaceRegistration: NonNullable<RuntimeRegistrationRequest["workspaceRegistration"]>;
}

function prepareWorkspaceRegistration(
  db: DatabaseSync,
  runtimeId: string,
  workspaceGrant: RuntimeWorkspaceGrant,
  workspaceRegistration: RuntimeRegistrationRequest["workspaceRegistration"],
  now: string,
): PreparedWorkspaceRegistration | undefined {
  if (!workspaceRegistration && !workspaceGrant.workspaceId && !workspaceGrant.workspaceSlug) {
    return undefined;
  }
  if (!workspaceRegistration) {
    throw new RuntimeEnrollmentError(
      "Workspace registration payload is required for this token.",
      "WORKSPACE_REGISTRATION_PAYLOAD_REQUIRED",
    );
  }

  const workspace = resolveRegisteredWorkspace(db, workspaceGrant, workspaceRegistration, now);
  const existingBinding = db
    .prepare(
      `SELECT id
       FROM runtime_workspace_bindings
       WHERE runtime_id = ? AND local_workspace_key = ?
       LIMIT 1`,
    )
    .get(runtimeId, workspaceRegistration.localWorkspaceKey) as { id: string } | undefined;
  const bindingId = existingBinding?.id ?? createId("rtwb");
  assertWorkspaceOwnerAvailable(db, workspace.id, runtimeId, bindingId, now);
  return { workspace, bindingId, workspaceRegistration };
}

function completeWorkspaceRegistration(
  db: DatabaseSync,
  runtimeId: string,
  workspaceGrant: RuntimeWorkspaceGrant,
  prepared: PreparedWorkspaceRegistration | undefined,
  now: string,
): RegisteredWorkspaceBinding | undefined {
  if (!prepared) return undefined;

  upsertRegisteredWorkspaceBinding(
    db,
    runtimeId,
    prepared.bindingId,
    prepared.workspaceRegistration,
    now,
  );
  ensureActiveOwnerBinding(db, prepared.workspace.id, runtimeId, prepared.bindingId, now);
  if (workspaceGrant.enrollmentTokenId) {
    db.prepare(
      `UPDATE runtime_enrollment_tokens
       SET workspace_id = COALESCE(workspace_id, ?),
           workspace_name = COALESCE(workspace_name, ?),
           workspace_slug = COALESCE(workspace_slug, ?)
       WHERE id = ?`,
    ).run(
      prepared.workspace.id,
      prepared.workspace.name,
      prepared.workspace.slug,
      workspaceGrant.enrollmentTokenId,
    );
  }

  return {
    workspaceId: prepared.workspace.id,
    bindingId: prepared.bindingId,
    localWorkspaceKey: prepared.workspaceRegistration.localWorkspaceKey,
    displayName: prepared.workspaceRegistration.displayName,
    status: "available",
  };
}

function resolveRegisteredWorkspace(
  db: DatabaseSync,
  workspaceGrant: RuntimeWorkspaceGrant,
  workspaceRegistration: NonNullable<RuntimeRegistrationRequest["workspaceRegistration"]>,
  now: string,
): { id: string; slug: string; name: string } {
  if (workspaceGrant.workspaceId) {
    const workspace = db
      .prepare("SELECT id, slug, name FROM workspaces WHERE id = ? AND status = 'active'")
      .get(workspaceGrant.workspaceId) as { id: string; slug: string; name: string } | undefined;
    if (!workspace) {
      throw new RuntimeEnrollmentError(
        "Workspace registration token references an unavailable workspace.",
        "WORKSPACE_REGISTRATION_WORKSPACE_UNAVAILABLE",
      );
    }
    return workspace;
  }

  const slug =
    workspaceGrant.workspaceSlug ??
    workspaceRegistration.workspaceSlug ??
    slugify(workspaceRegistration.displayName);
  const name =
    workspaceGrant.workspaceName ??
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
  bindingId: string,
  workspaceRegistration: NonNullable<RuntimeRegistrationRequest["workspaceRegistration"]>,
  now: string,
): void {
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
           local_path = COALESCE(?, local_path),
           status = 'available',
           updated_at = ?
       WHERE id = ?`,
    ).run(
      workspaceRegistration.displayName,
      workspaceRegistration.localPath ?? null,
      now,
      existing.id,
    );
    return;
  }

  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, local_path, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'available', '{}', '{}', ?, ?)`,
  ).run(
    bindingId,
    runtimeId,
    workspaceRegistration.localWorkspaceKey,
    workspaceRegistration.localPath ?? null,
    workspaceRegistration.displayName,
    now,
    now,
  );
}

function assertWorkspaceOwnerAvailable(
  db: DatabaseSync,
  workspaceId: string,
  attemptedRuntimeId: string,
  attemptedBindingId: string,
  occurredAt: string,
): void {
  const active = db
    .prepare(
      `SELECT wob.runtime_workspace_binding_id AS currentBindingId,
              rwb.runtime_id AS currentRuntimeId
       FROM workspace_owner_bindings wob
       JOIN runtime_workspace_bindings rwb ON rwb.id = wob.runtime_workspace_binding_id
       WHERE wob.workspace_id = ? AND wob.ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { currentBindingId: string; currentRuntimeId: string } | undefined;
  if (!active || active.currentBindingId === attemptedBindingId) return;

  throw new RuntimeWorkspaceOwnerConflictError({
    workspaceId,
    currentRuntimeId: active.currentRuntimeId,
    currentBindingId: active.currentBindingId,
    attemptedRuntimeId,
    attemptedBindingId,
    occurredAt,
  });
}

function ensureActiveOwnerBinding(
  db: DatabaseSync,
  workspaceId: string,
  runtimeId: string,
  runtimeWorkspaceBindingId: string,
  now: string,
): void {
  assertWorkspaceOwnerAvailable(db, workspaceId, runtimeId, runtimeWorkspaceBindingId, now);
  const active = db
    .prepare(
      `SELECT 1 AS present
       FROM workspace_owner_bindings
       WHERE workspace_id = ? AND ended_at IS NULL
       LIMIT 1`,
    )
    .get(workspaceId) as { present: number } | undefined;
  if (active) return;

  db.prepare(
    `INSERT INTO workspace_owner_bindings
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
     VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
  ).run(createId("wob"), workspaceId, runtimeWorkspaceBindingId, now, now);
}

function withRuntimeRegistrationTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof RuntimeWorkspaceOwnerConflictError) {
      appendWorkspaceOwnerConflictAudit(db, error.conflict);
    }
    throw error;
  }
}

function appendWorkspaceOwnerConflictAudit(
  db: DatabaseSync,
  conflict: RuntimeWorkspaceOwnerConflict,
): void {
  appendEvent(db, {
    workspaceId: conflict.workspaceId,
    actorKind: "server",
    kind: "workspace.owner_registration_conflict",
    subjectKind: "workspace_owner_binding",
    subjectId: conflict.currentBindingId,
    createdAt: conflict.occurredAt,
    payload: {
      currentRuntimeId: conflict.currentRuntimeId,
      currentBindingId: conflict.currentBindingId,
      attemptedRuntimeId: conflict.attemptedRuntimeId,
      attemptedBindingId: conflict.attemptedBindingId,
      outcome: "rejected",
    },
  });
}

interface RuntimeDeviceAuthorizationRow {
  id: string;
  installationId: string;
  displayName: string;
  registrationJson: string;
  scopesJson: string;
  createdAt: string;
  expiresAt: string;
  intervalSeconds: number;
  lastPolledAt: string | null;
  approvedAt: string | null;
  deniedAt: string | null;
  consumedAt: string | null;
}

function findRuntimeDeviceAuthorizationByUserCode(
  db: DatabaseSync,
  userCode: string,
): RuntimeDeviceAuthorizationRow | undefined {
  return db
    .prepare(
      `SELECT id,
              installation_id AS installationId,
              display_name AS displayName,
              registration_json AS registrationJson,
              scopes_json AS scopesJson,
              created_at AS createdAt,
              expires_at AS expiresAt,
              interval_seconds AS intervalSeconds,
              last_polled_at AS lastPolledAt,
              approved_at AS approvedAt,
              denied_at AS deniedAt,
              consumed_at AS consumedAt
       FROM runtime_device_authorizations
       WHERE user_code_hash = ?
       LIMIT 1`,
    )
    .get(hashRuntimeDeviceUserCode(userCode)) as RuntimeDeviceAuthorizationRow | undefined;
}

function findRuntimeDeviceAuthorizationByDeviceCodeHash(
  db: DatabaseSync,
  deviceCodeHash: string,
): RuntimeDeviceAuthorizationRow | undefined {
  return db
    .prepare(
      `SELECT id,
              installation_id AS installationId,
              display_name AS displayName,
              registration_json AS registrationJson,
              scopes_json AS scopesJson,
              created_at AS createdAt,
              expires_at AS expiresAt,
              interval_seconds AS intervalSeconds,
              last_polled_at AS lastPolledAt,
              approved_at AS approvedAt,
              denied_at AS deniedAt,
              consumed_at AS consumedAt
       FROM runtime_device_authorizations
       WHERE device_code_hash = ?
       LIMIT 1`,
    )
    .get(deviceCodeHash) as RuntimeDeviceAuthorizationRow | undefined;
}

function runtimeDeviceAuthorizationApproval(
  row: RuntimeDeviceAuthorizationRow,
  userCode: string,
  now: string,
): RuntimeDeviceAuthorizationApproval {
  return {
    id: row.id,
    userCode: formatRuntimeDeviceUserCode(normalizeRuntimeDeviceUserCode(userCode)),
    installationId: row.installationId,
    displayName: row.displayName,
    registration: parseRuntimeDeviceRegistration(row.registrationJson),
    status: runtimeDeviceAuthorizationStatus(row, now),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    approvedAt: row.approvedAt,
    deniedAt: row.deniedAt,
    consumedAt: row.consumedAt,
  };
}

function runtimeDeviceAuthorizationStatus(
  row: RuntimeDeviceAuthorizationRow,
  now: string,
): RuntimeDeviceAuthorizationStatus {
  if (row.consumedAt) return "consumed";
  if (row.deniedAt) return "denied";
  if (row.expiresAt <= now) return "expired";
  if (row.approvedAt) return "approved";
  return "pending";
}

function validateRuntimeDeviceAuthorizationForDecision(
  row: RuntimeDeviceAuthorizationRow | undefined,
  now: string,
): asserts row is RuntimeDeviceAuthorizationRow {
  if (!row || row.consumedAt) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization code is invalid or has already been used.",
      "invalid_grant",
    );
  }
  if (row.deniedAt) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization was denied.",
      "access_denied",
    );
  }
  if (row.expiresAt <= now) {
    throw new RuntimeDeviceAuthorizationError(
      "Runtime device authorization has expired.",
      "expired_token",
    );
  }
}

function validateRuntimeDeviceAuthorizationForExchange(
  row: RuntimeDeviceAuthorizationRow | undefined,
  now: string,
): asserts row is RuntimeDeviceAuthorizationRow {
  validateRuntimeDeviceAuthorizationForDecision(row, now);
}

function requireActiveOwner(db: DatabaseSync, userId: string | null): void {
  if (!userId) {
    throw new RuntimeDeviceAuthorizationError(
      "An authenticated Cockpit owner is required to approve daemon registration.",
      "approval_forbidden",
    );
  }
  const owner = db
    .prepare(
      `SELECT id
       FROM users
       WHERE id = ? AND role = 'owner' AND status = 'active'
       LIMIT 1`,
    )
    .get(userId);
  if (!owner) {
    throw new RuntimeDeviceAuthorizationError(
      "Only an active Cockpit owner can approve daemon registration.",
      "approval_forbidden",
    );
  }
}

function parseRuntimeDeviceRegistration(registrationJson: string): RuntimeRegistrationRequest {
  try {
    return runtimeDeviceAuthorizationRequestSchema.parse(JSON.parse(registrationJson) as unknown);
  } catch {
    throw new RuntimeDeviceAuthorizationError(
      "Stored runtime device registration metadata is invalid.",
      "invalid_grant",
    );
  }
}

function createRuntimeDeviceUserCode(): string {
  const bytes = randomBytes(8);
  const normalized = [...bytes]
    .map((byte) => runtimeDeviceUserCodeAlphabet[byte % runtimeDeviceUserCodeAlphabet.length])
    .join("");
  return formatRuntimeDeviceUserCode(normalized);
}

function normalizeRuntimeDeviceUserCode(userCode: string): string {
  return userCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatRuntimeDeviceUserCode(normalized: string): string {
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

function hashRuntimeDeviceUserCode(userCode: string): string {
  return hashSecret(normalizeRuntimeDeviceUserCode(userCode));
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
  requiredScopes: string[] = ["runtime:connect"],
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
  const scopes = parseScopes(token.scopesJson);
  if (requiredScopes.some((scope) => !scopes.includes(scope))) {
    throw new RuntimeAccessTokenError(
      "Runtime token is not allowed to register workspaces.",
      "RUNTIME_TOKEN_SCOPE_INVALID",
    );
  }
}

function runtimeAccessScopesFromGrant(grantScopes: string[]): string[] {
  return uniqueScopes([
    "runtime:connect",
    ...grantScopes.filter((scope) => scope !== "runtime:connect" && scope !== "runtime:refresh"),
  ]);
}

function runtimeRefreshScopesFromGrant(grantScopes: string[]): string[] {
  return uniqueScopes([
    "runtime:refresh",
    ...grantScopes.filter((scope) => scope !== "runtime:connect" && scope !== "runtime:refresh"),
  ]);
}

function uniqueScopes(scopes: string[]): string[] {
  return [...new Set(scopes)];
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
