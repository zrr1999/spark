import { randomBytes } from "node:crypto";
import { createId } from "@zendev-lab/spark-protocol";
import { hashSecret } from "./security.ts";
import type { DatabaseSync } from "node:sqlite";

const defaultWorkspaceAccessTokenTtlMs = 10 * 60 * 1_000;

export interface WorkspaceAccessToken {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceAccessTokenSummary {
  id: string;
  workspaceId: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdByRuntimeName: string | null;
}

export interface ConsumedWorkspaceAccessToken {
  tokenId: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
}

export class WorkspaceAccessTokenError extends Error {
  readonly reasonCode:
    | "WORKSPACE_ACCESS_TOKEN_REQUIRED"
    | "WORKSPACE_ACCESS_TOKEN_INVALID"
    | "WORKSPACE_ACCESS_TOKEN_USED"
    | "WORKSPACE_ACCESS_TOKEN_REVOKED"
    | "WORKSPACE_ACCESS_TOKEN_EXPIRED";

  constructor(
    message: string,
    reasonCode:
      | "WORKSPACE_ACCESS_TOKEN_REQUIRED"
      | "WORKSPACE_ACCESS_TOKEN_INVALID"
      | "WORKSPACE_ACCESS_TOKEN_USED"
      | "WORKSPACE_ACCESS_TOKEN_REVOKED"
      | "WORKSPACE_ACCESS_TOKEN_EXPIRED",
  ) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export function createWorkspaceAccessToken(
  db: DatabaseSync,
  input: {
    workspaceId: string;
    label?: string | null;
    createdByUserId?: string | null;
    createdByRuntimeId?: string | null;
    ttlMs?: number;
    createdAt?: string;
  },
): WorkspaceAccessToken {
  const workspace = db
    .prepare("SELECT id, slug FROM workspaces WHERE id = ? AND status = 'active' LIMIT 1")
    .get(input.workspaceId) as { id: string; slug: string } | undefined;
  if (!workspace) throw new Error("Workspace not found or archived.");

  const createdAtDate = input.createdAt ? new Date(input.createdAt) : new Date();
  const createdAt = createdAtDate.toISOString();
  const expiresAt = new Date(
    createdAtDate.getTime() + (input.ttlMs ?? defaultWorkspaceAccessTokenTtlMs),
  ).toISOString();
  const id = createId("watok");
  const token = `spark_workspace_auth_${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO workspace_access_tokens
      (id, workspace_id, token_hash, label, created_by_user_id, created_by_runtime_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspace.id,
    hashSecret(token),
    input.label ?? "Workspace browser access",
    input.createdByUserId ?? null,
    input.createdByRuntimeId ?? null,
    createdAt,
    expiresAt,
  );
  return {
    id,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    token,
    createdAt,
    expiresAt,
  };
}

export function listWorkspaceAccessTokens(
  db: DatabaseSync,
  workspaceId: string,
  limit = 50,
): WorkspaceAccessTokenSummary[] {
  return db
    .prepare(
      `SELECT wat.id,
              wat.workspace_id AS workspaceId,
              wat.label,
              wat.created_at AS createdAt,
              wat.expires_at AS expiresAt,
              wat.used_at AS usedAt,
              wat.revoked_at AS revokedAt,
              rc.name AS createdByRuntimeName
       FROM workspace_access_tokens wat
       LEFT JOIN runtime_connections rc ON rc.id = wat.created_by_runtime_id
       WHERE wat.workspace_id = ?
       ORDER BY wat.created_at DESC
       LIMIT ?`,
    )
    .all(workspaceId, limit) as unknown as WorkspaceAccessTokenSummary[];
}

export function revokeWorkspaceAccessToken(
  db: DatabaseSync,
  input: { workspaceId: string; tokenId: string; revokedAt?: string },
): boolean {
  const result = db
    .prepare(
      `UPDATE workspace_access_tokens
       SET revoked_at = ?
       WHERE id = ? AND workspace_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .run(input.revokedAt ?? new Date().toISOString(), input.tokenId, input.workspaceId);
  return result.changes === 1;
}

/** Consume inside the caller's transaction so session creation is atomic with one-time use. */
export function consumeWorkspaceAccessToken(
  db: DatabaseSync,
  token: string | null,
  consumedAt = new Date().toISOString(),
): ConsumedWorkspaceAccessToken {
  if (!token) {
    throw new WorkspaceAccessTokenError(
      "Workspace access token is required.",
      "WORKSPACE_ACCESS_TOKEN_REQUIRED",
    );
  }
  const row = db
    .prepare(
      `SELECT wat.id,
              wat.workspace_id AS workspaceId,
              wat.expires_at AS expiresAt,
              wat.used_at AS usedAt,
              wat.revoked_at AS revokedAt,
              w.slug AS workspaceSlug,
              w.name AS workspaceName
       FROM workspace_access_tokens wat
       JOIN workspaces w ON w.id = wat.workspace_id
       WHERE wat.token_hash = ? AND w.status = 'active'
       LIMIT 1`,
    )
    .get(hashSecret(token)) as
    | {
        id: string;
        workspaceId: string;
        workspaceSlug: string;
        workspaceName: string;
        expiresAt: string;
        usedAt: string | null;
        revokedAt: string | null;
      }
    | undefined;
  if (!row) {
    throw new WorkspaceAccessTokenError(
      "Workspace access token is invalid.",
      "WORKSPACE_ACCESS_TOKEN_INVALID",
    );
  }
  if (row.revokedAt) {
    throw new WorkspaceAccessTokenError(
      "Workspace access token has been revoked.",
      "WORKSPACE_ACCESS_TOKEN_REVOKED",
    );
  }
  if (row.usedAt) {
    throw new WorkspaceAccessTokenError(
      "Workspace access token has already been used.",
      "WORKSPACE_ACCESS_TOKEN_USED",
    );
  }
  if (row.expiresAt <= consumedAt) {
    throw new WorkspaceAccessTokenError(
      "Workspace access token has expired.",
      "WORKSPACE_ACCESS_TOKEN_EXPIRED",
    );
  }
  const consumed = db
    .prepare(
      `UPDATE workspace_access_tokens
       SET used_at = ?
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .run(consumedAt, row.id, consumedAt);
  if (consumed.changes !== 1) {
    throw new WorkspaceAccessTokenError(
      "Workspace access token has already been used.",
      "WORKSPACE_ACCESS_TOKEN_USED",
    );
  }
  return {
    tokenId: row.id,
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspaceSlug,
    workspaceName: row.workspaceName,
  };
}

export function hasActiveWorkspaceAccessTokens(
  db: DatabaseSync,
  now = new Date().toISOString(),
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM workspace_access_tokens
         WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         LIMIT 1`,
      )
      .get(now),
  );
}
