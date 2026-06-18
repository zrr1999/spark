import { createHash, randomBytes } from "node:crypto";
import { createId } from "@navia-dev/protocol";
import type { Cookies } from "@sveltejs/kit";
import type { DatabaseSync } from "node:sqlite";

export const sessionCookieName = "navia_session";

export interface SetupStatus {
  hasOwner: boolean;
}

export interface CreatedOwnerSession {
  userId: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

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
      throw new Error("Navia owner has already been set up");
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
    throw new Error("Navia owner has not been set up");
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

export function ensureCurrentOwnerSession(
  db: DatabaseSync,
  _cookies: Cookies,
  sessionToken: string | null,
): string {
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

export function setSessionCookie(cookies: Cookies, session: CreatedOwnerSession): void {
  cookies.set(sessionCookieName, session.sessionToken, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    expires: new Date(session.expiresAt),
  });
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
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

function createSessionToken(): string {
  return `navia_sess_${randomBytes(32).toString("base64url")}`;
}
