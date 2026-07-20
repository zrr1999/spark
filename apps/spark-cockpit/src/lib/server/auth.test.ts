import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { createWorkspaceAccessToken } from "@zendev-lab/spark-coordination/workspace-access";
import {
  createRuntimeEnrollmentToken,
  registerRuntime,
} from "@zendev-lab/spark-coordination/runtime-registration";
import type { Cookies } from "@sveltejs/kit";
import {
  createLocalOwnerSession,
  createOwnerSession,
  ensureCurrentOwnerSession,
  ensureLocalSystemUser,
  exchangeWorkspaceAccessToken,
  getCurrentWorkspaceSession,
  getCurrentUserId,
  hashSecret,
  sessionCookieName,
  refreshWorkspaceSession,
  workspaceSessionAllowsRequest,
} from "./auth";
import { isLoopbackClientAddress, remoteAccessDecision } from "./remote-access";

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
    expect(session.sessionToken).toMatch(/^spark_cockpit_sess_/);
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

describe("remote access auth", () => {
  it("exchanges the one-time browser key returned by daemon workspace registration", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      workspaceName: "Spore",
      workspaceSlug: "spore",
    });
    const registered = registerRuntime(
      db,
      {
        installationId: "install-spore",
        displayName: "Spore daemon",
        runtimeVersion: "0.1.0-test",
        supportedFeatures: [],
        labels: {},
        workspaceRegistration: {
          localWorkspaceKey: "spore-local",
          displayName: "Spore local",
        },
      },
      enrollment.refreshToken,
    );
    const authorization = registered.workspaceAuthorization;
    if (!authorization) throw new Error("Expected workspace browser authorization.");

    const session = exchangeWorkspaceAccessToken(db, authorization.oneTimeToken);
    expect(session).toMatchObject({
      workspaceId: authorization.workspaceId,
      workspaceSlug: "spore",
    });
    expect(() => exchangeWorkspaceAccessToken(db, authorization.oneTimeToken)).toThrow(
      /already been used/,
    );
    db.close();
  });

  it("exchanges and rotates a one-time workspace grant without broadening scope", () => {
    const db = openMemoryDatabase();
    migrate(db);
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, status, settings_json, created_at, updated_at)
       VALUES ('ws_11111111111141111111111111111111', 'spark', 'Spark', 'active', '{}', ?, ?),
              ('ws_22222222222242222222222222222222', 'spore', 'Spore', 'active', '{}', ?, ?)`,
    ).run(
      "2026-07-20T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
    );
    const grant = createWorkspaceAccessToken(db, {
      workspaceId: "ws_11111111111141111111111111111111",
      createdAt: "2026-07-20T00:00:00.000Z",
      ttlMs: 60_000,
    });
    const session = exchangeWorkspaceAccessToken(
      db,
      grant.token,
      new Date("2026-07-20T00:00:01.000Z"),
    );
    expect(
      getCurrentWorkspaceSession(db, session.sessionToken, new Date("2026-07-20T00:00:02.000Z")),
    ).toMatchObject({
      workspaceId: "ws_11111111111141111111111111111111",
      workspaceSlug: "spark",
    });
    expect(() =>
      exchangeWorkspaceAccessToken(db, grant.token, new Date("2026-07-20T00:00:02.000Z")),
    ).toThrow(/already been used/);
    expect(workspaceSessionAllowsRequest(db, session.workspaceId, "/spark/sessions")).toBe(true);
    expect(workspaceSessionAllowsRequest(db, session.workspaceId, "/sessions")).toBe(false);
    expect(
      workspaceSessionAllowsRequest(db, session.workspaceId, "/spark/sessions/missing-session"),
    ).toBe(false);
    expect(workspaceSessionAllowsRequest(db, session.workspaceId, "/spore/sessions")).toBe(false);
    expect(workspaceSessionAllowsRequest(db, session.workspaceId, "/settings/models")).toBe(false);

    const refreshed = refreshWorkspaceSession(
      db,
      session.refreshToken,
      new Date("2026-07-20T00:16:00.000Z"),
    );
    expect(refreshed?.workspaceId).toBe(session.workspaceId);
    expect(refreshed?.refreshToken).not.toBe(session.refreshToken);
    expect(refreshWorkspaceSession(db, session.refreshToken)).toBeNull();
    db.close();
  });

  it("does not require token auth for loopback client addresses", () => {
    expect(isLoopbackClientAddress("localhost")).toBe(true);
    expect(isLoopbackClientAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackClientAddress("::1")).toBe(true);
    expect(isLoopbackClientAddress("::ffff:127.0.0.1")).toBe(true);
    expect(
      remoteAccessDecision({
        url: new URL("http://localhost:5173/inbox"),
        clientAddress: "127.0.0.1",
      }).required,
    ).toBe(false);
  });

  it("requires token auth for protected non-loopback UI/API paths", () => {
    expect(
      remoteAccessDecision({
        url: new URL("http://spark.tailnet.test:5173/inbox"),
        clientAddress: "100.64.0.8",
      }).required,
    ).toBe(true);
    expect(
      remoteAccessDecision({
        url: new URL("http://spark.tailnet.test:5173/api/search"),
        clientAddress: "100.64.0.8",
      }).required,
    ).toBe(true);
  });

  it("does not trust a spoofed localhost Host header from a remote client", () => {
    expect(
      remoteAccessDecision({
        url: new URL("http://localhost:5173/api/search"),
        clientAddress: "100.64.0.8",
      }).required,
    ).toBe(true);
  });

  it("allows login, PWA assets, and runtime bearer endpoints before Cockpit login", () => {
    for (const path of [
      "/login",
      "/manifest.webmanifest",
      "/service-worker.js",
      "/icons/spark-maskable.svg",
      "/_app/immutable/start.js",
      "/api/v1/runtime/runtimes/register",
    ]) {
      expect(
        remoteAccessDecision({
          url: new URL(`http://spark.tailnet.test:5173${path}`),
          clientAddress: "100.64.0.8",
        }),
      ).toMatchObject({
        required: false,
        publicPath: true,
      });
    }
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
