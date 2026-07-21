import { randomBytes } from "node:crypto";
import { createId } from "@zendev-lab/spark-protocol";
import { hashSecret } from "./security.ts";
import type { DatabaseSync } from "node:sqlite";

const defaultCockpitAccessTokenTtlMs = 10 * 60 * 1_000;

export interface CockpitAccessToken {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

export interface CockpitAccessTokenSummary {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface ConsumedCockpitAccessToken {
  tokenId: string;
}

export class CockpitAccessTokenError extends Error {
  readonly reasonCode:
    | "COCKPIT_ACCESS_TOKEN_REQUIRED"
    | "COCKPIT_ACCESS_TOKEN_INVALID"
    | "COCKPIT_ACCESS_TOKEN_USED"
    | "COCKPIT_ACCESS_TOKEN_REVOKED"
    | "COCKPIT_ACCESS_TOKEN_EXPIRED";

  constructor(
    message: string,
    reasonCode:
      | "COCKPIT_ACCESS_TOKEN_REQUIRED"
      | "COCKPIT_ACCESS_TOKEN_INVALID"
      | "COCKPIT_ACCESS_TOKEN_USED"
      | "COCKPIT_ACCESS_TOKEN_REVOKED"
      | "COCKPIT_ACCESS_TOKEN_EXPIRED",
  ) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export function createCockpitAccessToken(
  db: DatabaseSync,
  input: {
    label?: string | null;
    createdByUserId?: string | null;
    ttlMs?: number;
    createdAt?: string;
  } = {},
): CockpitAccessToken {
  const createdAtDate = input.createdAt ? new Date(input.createdAt) : new Date();
  const createdAt = createdAtDate.toISOString();
  const expiresAt = new Date(
    createdAtDate.getTime() + (input.ttlMs ?? defaultCockpitAccessTokenTtlMs),
  ).toISOString();
  const id = createId("catok");
  const token = `spark_cockpit_auth_${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO cockpit_access_tokens
      (id, token_hash, label, created_by_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    hashSecret(token),
    input.label ?? "Cockpit browser access",
    input.createdByUserId ?? null,
    createdAt,
    expiresAt,
  );
  return { id, token, createdAt, expiresAt };
}

export function listCockpitAccessTokens(db: DatabaseSync, limit = 50): CockpitAccessTokenSummary[] {
  return db
    .prepare(
      `SELECT id,
              label,
              created_at AS createdAt,
              expires_at AS expiresAt,
              used_at AS usedAt,
              revoked_at AS revokedAt
       FROM cockpit_access_tokens
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as CockpitAccessTokenSummary[];
}

export function revokeCockpitAccessToken(
  db: DatabaseSync,
  input: { tokenId: string; revokedAt?: string },
): boolean {
  const result = db
    .prepare(
      `UPDATE cockpit_access_tokens
       SET revoked_at = ?
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .run(input.revokedAt ?? new Date().toISOString(), input.tokenId);
  return result.changes === 1;
}

/** Consume inside the caller's transaction so session creation is atomic with one-time use. */
export function consumeCockpitAccessToken(
  db: DatabaseSync,
  token: string | null,
  consumedAt = new Date().toISOString(),
): ConsumedCockpitAccessToken {
  if (!token) {
    throw new CockpitAccessTokenError(
      "Cockpit access token is required.",
      "COCKPIT_ACCESS_TOKEN_REQUIRED",
    );
  }
  const row = db
    .prepare(
      `SELECT id,
              expires_at AS expiresAt,
              used_at AS usedAt,
              revoked_at AS revokedAt
       FROM cockpit_access_tokens
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .get(hashSecret(token)) as
    | {
        id: string;
        expiresAt: string;
        usedAt: string | null;
        revokedAt: string | null;
      }
    | undefined;
  if (!row) {
    throw new CockpitAccessTokenError(
      "Cockpit access token is invalid.",
      "COCKPIT_ACCESS_TOKEN_INVALID",
    );
  }
  if (row.revokedAt) {
    throw new CockpitAccessTokenError(
      "Cockpit access token has been revoked.",
      "COCKPIT_ACCESS_TOKEN_REVOKED",
    );
  }
  if (row.usedAt) {
    throw new CockpitAccessTokenError(
      "Cockpit access token has already been used.",
      "COCKPIT_ACCESS_TOKEN_USED",
    );
  }
  if (row.expiresAt <= consumedAt) {
    throw new CockpitAccessTokenError(
      "Cockpit access token has expired.",
      "COCKPIT_ACCESS_TOKEN_EXPIRED",
    );
  }
  const consumed = db
    .prepare(
      `UPDATE cockpit_access_tokens
       SET used_at = ?
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .run(consumedAt, row.id, consumedAt);
  if (consumed.changes !== 1) {
    throw new CockpitAccessTokenError(
      "Cockpit access token has already been used.",
      "COCKPIT_ACCESS_TOKEN_USED",
    );
  }
  return { tokenId: row.id };
}

export function hasActiveCockpitAccessTokens(
  db: DatabaseSync,
  now = new Date().toISOString(),
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM cockpit_access_tokens
         WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         LIMIT 1`,
      )
      .get(now),
  );
}
