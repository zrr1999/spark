import { createHash, randomBytes } from "node:crypto";
import {
  consumeWorkspaceAccessToken,
  type ConsumedWorkspaceAccessToken,
} from "@zendev-lab/spark-coordination/workspace-access";
import { createId } from "@zendev-lab/spark-protocol";
import type { Cookies } from "@sveltejs/kit";
import type { DatabaseSync } from "node:sqlite";

export const sessionCookieName = "spark_cockpit_session";
export const sessionRefreshCookieName = "spark_cockpit_refresh";

const workspaceAccessTtlMs = 15 * 60 * 1_000;
const workspaceRefreshTtlMs = 30 * 24 * 60 * 60 * 1_000;

export interface SetupStatus {
  hasOwner: boolean;
}

export interface CreatedOwnerSession {
  userId: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

export interface WorkspaceSession extends CreatedOwnerSession {
  workspaceId: string;
  workspaceSlug: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export class WorkspaceSessionError extends Error {}

export function getSetupStatus(db: DatabaseSync): SetupStatus {
  const owner = db
    .prepare("SELECT id FROM users WHERE role = 'owner' AND status = 'active' LIMIT 1")
    .get();
  return { hasOwner: Boolean(owner) };
}

export function createOwnerSession(
  db: DatabaseSync,
  displayName: string,
  email: string | null,
): CreatedOwnerSession {
  const now = new Date();
  const nowIso = now.toISOString();
  const userId = createId("usr");
  let session: CreatedOwnerSession;

  db.exec("BEGIN");
  try {
    const setup = getSetupStatus(db);
    if (setup.hasOwner) {
      throw new Error("Spark Cockpit owner has already been set up");
    }

    db.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
    ).run(userId, email, displayName, nowIso, nowIso);

    session = insertSession(db, userId, now);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return session;
}

export function createLocalOwnerSession(db: DatabaseSync): CreatedOwnerSession {
  const owner = db
    .prepare(
      `SELECT id
       FROM users
       WHERE role = 'owner' AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get() as { id: string } | undefined;

  if (!owner) {
    throw new Error("Spark Cockpit owner has not been set up");
  }

  return insertSession(db, owner.id, new Date());
}

export function getCurrentUserId(
  db: DatabaseSync,
  sessionToken: string | null,
  now = new Date(),
): string | null {
  if (!sessionToken) {
    return null;
  }

  const session = db
    .prepare(
      `SELECT s.user_id AS userId
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND u.status = 'active'
       LIMIT 1`,
    )
    .get(hashSecret(sessionToken), now.toISOString()) as { userId: string } | undefined;

  return session?.userId ?? null;
}

export function getCurrentWorkspaceSession(
  db: DatabaseSync,
  sessionToken: string | null,
  now = new Date(),
): Omit<WorkspaceSession, "sessionToken" | "refreshToken" | "refreshExpiresAt"> | null {
  if (!sessionToken) return null;
  const row = db
    .prepare(
      `SELECT s.id AS sessionId,
              s.user_id AS userId,
              s.workspace_id AS workspaceId,
              s.expires_at AS expiresAt,
              w.slug AS workspaceSlug
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.token_hash = ?
         AND s.workspace_id IS NOT NULL
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND u.status = 'active'
         AND w.status = 'active'
       LIMIT 1`,
    )
    .get(hashSecret(sessionToken), now.toISOString()) as
    | {
        sessionId: string;
        userId: string;
        workspaceId: string;
        workspaceSlug: string;
        expiresAt: string;
      }
    | undefined;
  return row ?? null;
}

export function exchangeWorkspaceAccessToken(
  db: DatabaseSync,
  token: string | null,
  now = new Date(),
): WorkspaceSession {
  db.exec("BEGIN IMMEDIATE");
  try {
    const grant = consumeWorkspaceAccessToken(db, token, now.toISOString());
    const userId = createWorkspaceMember(db, grant, now.toISOString());
    const session = insertWorkspaceSession(db, userId, grant, now);
    db.exec("COMMIT");
    return session;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function refreshWorkspaceSession(
  db: DatabaseSync,
  refreshToken: string | null,
  now = new Date(),
): WorkspaceSession | null {
  if (!refreshToken) return null;
  const nowIso = now.toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare(
        `SELECT s.id AS sessionId,
                s.user_id AS userId,
                s.workspace_id AS workspaceId,
                w.slug AS workspaceSlug,
                w.name AS workspaceName
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.refresh_token_hash = ?
           AND s.workspace_id IS NOT NULL
           AND s.revoked_at IS NULL
           AND s.refresh_expires_at > ?
           AND u.status = 'active'
           AND w.status = 'active'
         LIMIT 1`,
      )
      .get(hashSecret(refreshToken), nowIso) as
      | {
          sessionId: string;
          userId: string;
          workspaceId: string;
          workspaceSlug: string;
          workspaceName: string;
        }
      | undefined;
    if (!current) {
      db.exec("ROLLBACK");
      return null;
    }
    const rotated = db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(nowIso, current.sessionId);
    if (rotated.changes !== 1) {
      db.exec("ROLLBACK");
      return null;
    }
    const session = insertWorkspaceSession(
      db,
      current.userId,
      {
        tokenId: "refresh",
        workspaceId: current.workspaceId,
        workspaceSlug: current.workspaceSlug,
        workspaceName: current.workspaceName,
      },
      now,
    );
    db.exec("COMMIT");
    return session;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the refresh error.
    }
    throw error;
  }
}

export function ensureCurrentOwnerSession(
  db: DatabaseSync,
  _cookies: Cookies,
  sessionToken: string | null,
  workspaceId?: string,
): string {
  if (workspaceId) {
    const workspaceSession = getCurrentWorkspaceSession(db, sessionToken);
    if (workspaceSession) {
      if (workspaceSession.workspaceId !== workspaceId) {
        throw new WorkspaceSessionError("This browser session does not grant this workspace.");
      }
      return workspaceSession.userId;
    }
  }
  const currentUserId = getCurrentUserId(db, sessionToken);
  if (currentUserId) {
    return currentUserId;
  }

  return ensureLocalSystemUser(db);
}

export function ensureLocalSystemUser(db: DatabaseSync): string {
  const existing = db
    .prepare(
      `SELECT id
       FROM users
       WHERE role = 'owner' AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get() as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const now = new Date().toISOString();
  const userId = createId("usr");
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, NULL, 'Local system', 'owner', 'active', ?, ?)`,
  ).run(userId, now, now);

  return userId;
}

export function setSessionCookie(
  cookies: Cookies,
  session: CreatedOwnerSession,
  options: { secure?: boolean } = {},
): void {
  cookies.set(sessionCookieName, session.sessionToken, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: options.secure ?? false,
    expires: new Date(session.expiresAt),
  });
}

export function setWorkspaceSessionCookies(
  cookies: Cookies,
  session: WorkspaceSession,
  options: { secure?: boolean } = {},
): void {
  const common = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: options.secure ?? false,
  };
  cookies.set(sessionCookieName, session.sessionToken, {
    ...common,
    expires: new Date(session.expiresAt),
  });
  cookies.set(sessionRefreshCookieName, session.refreshToken, {
    ...common,
    expires: new Date(session.refreshExpiresAt),
  });
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function workspaceSessionAllowsRequest(
  db: DatabaseSync,
  workspaceId: string,
  pathname: string,
): boolean {
  const segments = pathname.split("/").filter(Boolean).map(decodePathSegment);
  if (segments.length === 0 || segments[0] === "logout") return true;
  if (segments[0] === "sessions") {
    // Remote browsers must use the canonical /{workspace}/sessions route.
    // Otherwise POST actions on the legacy global route would lack a route
    // workspace against which to validate their submitted session id.
    return false;
  }
  if (segments[0] === "api" && segments[1] === "v1") {
    if (segments[2] === "events") return true;
    if (segments[2] === "sessions" && segments[3]) {
      const projected = db
        .prepare(
          `SELECT workspace_id AS workspaceId
           FROM runtime_session_projections
           WHERE session_id = ?
           LIMIT 1`,
        )
        .get(segments[3]) as { workspaceId: string | null } | undefined;
      return projected?.workspaceId === workspaceId;
    }
    if (segments[2] === "artifacts" && segments[3]) {
      const artifact = db
        .prepare("SELECT workspace_id AS workspaceId FROM artifacts WHERE id = ? LIMIT 1")
        .get(segments[3]) as { workspaceId: string } | undefined;
      return artifact?.workspaceId === workspaceId;
    }
    return false;
  }
  const routeWorkspace = db
    .prepare("SELECT id FROM workspaces WHERE (id = ? OR slug = ?) AND status = 'active' LIMIT 1")
    .get(segments[0], segments[0]) as { id: string } | undefined;
  if (routeWorkspace?.id !== workspaceId) return false;

  const resourceId = segments[2];
  if (!resourceId) return true;
  if (segments[1] === "sessions") {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM runtime_session_projections
           WHERE session_id = ? AND workspace_id = ?
           LIMIT 1`,
        )
        .get(resourceId, workspaceId),
    );
  }
  if (segments[1] === "artifacts") {
    return resourceBelongsToWorkspace(db, "artifacts", resourceId, workspaceId);
  }
  if (segments[1] === "inbox") {
    return resourceBelongsToWorkspace(db, "inbox_items", resourceId, workspaceId);
  }
  if (segments[1] === "projects") {
    return resourceBelongsToWorkspace(db, "projects", resourceId, workspaceId);
  }
  return true;
}

function resourceBelongsToWorkspace(
  db: DatabaseSync,
  table: "artifacts" | "inbox_items" | "projects",
  id: string,
  workspaceId: string,
): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_id = ? LIMIT 1`)
      .get(id, workspaceId),
  );
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function insertSession(db: DatabaseSync, userId: string, now: Date): CreatedOwnerSession {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30).toISOString();
  const sessionId = createId("sess");
  const sessionToken = createSessionToken();

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, userId, hashSecret(sessionToken), nowIso, expiresAt);

  return { userId, sessionId, sessionToken, expiresAt };
}

function insertWorkspaceSession(
  db: DatabaseSync,
  userId: string,
  grant: ConsumedWorkspaceAccessToken,
  now: Date,
): WorkspaceSession {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + workspaceAccessTtlMs).toISOString();
  const refreshExpiresAt = new Date(now.getTime() + workspaceRefreshTtlMs).toISOString();
  const sessionId = createId("sess");
  const sessionToken = `spark_cockpit_access_${randomBytes(32).toString("base64url")}`;
  const refreshToken = `spark_cockpit_refresh_${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO sessions
      (id, user_id, token_hash, workspace_id, refresh_token_hash, created_at, expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    hashSecret(sessionToken),
    grant.workspaceId,
    hashSecret(refreshToken),
    nowIso,
    expiresAt,
    refreshExpiresAt,
  );
  return {
    userId,
    sessionId,
    sessionToken,
    expiresAt,
    workspaceId: grant.workspaceId,
    workspaceSlug: grant.workspaceSlug,
    refreshToken,
    refreshExpiresAt,
  };
}

function createWorkspaceMember(
  db: DatabaseSync,
  grant: ConsumedWorkspaceAccessToken,
  now: string,
): string {
  const userId = createId("usr");
  db.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, NULL, ?, 'member', 'active', ?, ?)`,
  ).run(userId, `${grant.workspaceName} member`, now, now);
  return userId;
}

function createSessionToken(): string {
  return `spark_cockpit_sess_${randomBytes(32).toString("base64url")}`;
}
