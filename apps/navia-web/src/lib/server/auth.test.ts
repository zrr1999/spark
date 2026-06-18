import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/navia-db";
import type { Cookies } from "@sveltejs/kit";
import {
  createLocalOwnerSession,
  createOwnerSession,
  ensureCurrentOwnerSession,
  ensureLocalSystemUser,
  getCurrentUserId,
  hashSecret,
  sessionCookieName,
} from "./auth";

describe("local owner auth", () => {
  it("creates a new session for an existing local owner", () => {
    const db = openMemoryDatabase();
    migrate(db);
    db.prepare(
      `INSERT INTO users
        (id, email, display_name, role, status, created_at, updated_at)
       VALUES ('usr_owner', NULL, 'Local Owner', 'owner', 'active', ?, ?)`,
    ).run("2026-05-25T00:00:00.000Z", "2026-05-25T00:00:00.000Z");

    const session = createLocalOwnerSession(db);

    expect(session.userId).toBe("usr_owner");
    expect(session.sessionToken).toMatch(/^navia_sess_/);
    expect(getCurrentUserId(db, session.sessionToken)).toBe("usr_owner");
    db.close();
  });

  it("uses an existing local owner when the browser has no valid session", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const session = createOwnerSession(db, "Local Owner", null);
    const cookies = createCookieCapture();

    const userId = ensureCurrentOwnerSession(db, cookies as unknown as Cookies, null);

    expect(userId).toBe(session.userId);
    expect(cookies.value).toBeUndefined();
    expect(cookies.options).toBeUndefined();
    db.close();
  });

  it("creates a hidden local system user when no owner exists", () => {
    const db = openMemoryDatabase();
    migrate(db);

    const userId = ensureLocalSystemUser(db);

    expect(userId).toMatch(/^usr_/);
    expect(ensureLocalSystemUser(db)).toBe(userId);
    const row = db
      .prepare("SELECT display_name AS displayName, role, status FROM users WHERE id = ?")
      .get(userId) as { displayName: string; role: string; status: string };
    expect(row).toEqual({
      displayName: "Local system",
      role: "owner",
      status: "active",
    });
    db.close();
  });

  it("rejects revoked or expired sessions", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const session = createOwnerSession(db, "Local Owner", null);

    expect(getCurrentUserId(db, session.sessionToken, new Date("2026-05-25T00:00:00.000Z"))).toBe(
      session.userId,
    );

    db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(
      "2026-05-25T00:01:00.000Z",
      hashSecret(session.sessionToken),
    );
    expect(getCurrentUserId(db, session.sessionToken)).toBeNull();

    const expired = createLocalOwnerSession(db);
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(
      "2026-05-24T00:00:00.000Z",
      hashSecret(expired.sessionToken),
    );
    expect(
      getCurrentUserId(db, expired.sessionToken, new Date("2026-05-25T00:00:00.000Z")),
    ).toBeNull();

    db.close();
  });
});

function createCookieCapture() {
  const capture: {
    value: string | undefined;
    options: Record<string, unknown> | undefined;
    set(name: string, value: string, options: Record<string, unknown>): void;
  } = {
    value: undefined,
    options: undefined,
    set(name, value, options) {
      expect(name).toBe(sessionCookieName);
      capture.value = value;
      capture.options = options;
    },
  };

  return capture;
}
