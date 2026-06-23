import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/navia-db";
import {
  runtimeProtocolVersion,
  type RuntimeRegistrationRequest,
} from "@zendev-lab/spark-protocol";
import {
  createRuntimeEnrollmentToken,
  listRuntimeEnrollmentTokens,
  registerRuntime,
  registerRuntimeWorkspace,
  refreshRuntimeToken,
  revokeRuntimeEnrollmentToken,
  RuntimeAccessTokenError,
  RuntimeEnrollmentError,
  RuntimeTokenRefreshError,
} from "./runtime-registration";

const registrationRequest = {
  installationId: "install-test",
  displayName: "Test Spark daemon",
  runtimeVersion: "0.1.0-test",
  supportedFeatures: ["ws-control-v1", "command-routing-v1"],
  labels: { test: "true" },
} satisfies RuntimeRegistrationRequest;

describe("runtime registration", () => {
  it("stores workspace registration token hashes only", () => {
    const db = openMemoryDatabase();
    migrate(db);
    db.prepare(
      `INSERT INTO users
        (id, email, display_name, role, status, created_at, updated_at)
       VALUES ('usr_test', NULL, 'Test User', 'owner', 'active', ?, ?)`,
    ).run("2026-05-25T00:00:00.000Z", "2026-05-25T00:00:00.000Z");

    const enrollment = createRuntimeEnrollmentToken(db, {
      label: "Hash-only enrollment",
      createdByUserId: "usr_test",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: 60_000,
    });
    const stored = db
      .prepare(
        `SELECT token_hash AS tokenHash,
                label,
                created_by_user_id AS createdByUserId,
                created_at AS createdAt,
                expires_at AS expiresAt
         FROM runtime_enrollment_tokens
         WHERE id = ?`,
      )
      .get(enrollment.id) as {
      tokenHash: string;
      label: string;
      createdByUserId: string;
      createdAt: string;
      expiresAt: string;
    };

    expect(enrollment.refreshToken).toMatch(/^spark_wsreg_/);
    expect(stored.tokenHash).toBe(hash(enrollment.refreshToken));
    expect(JSON.stringify(stored)).not.toContain(enrollment.refreshToken);
    expect(stored).toMatchObject({
      label: "Hash-only enrollment",
      createdByUserId: "usr_test",
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:01:00.000Z",
    });
    db.close();
  });

  it("binds initial registration token metadata to the workspace being registered", () => {
    const db = openMemoryDatabase();
    migrate(db);

    const token = createRuntimeEnrollmentToken(db, {
      label: "Workspace token",
      workspaceName: "Navia Dev",
      workspaceSlug: "navia-dev",
      createdAt: "2026-05-25T00:00:00.000Z",
    });

    const stored = db
      .prepare(
        `SELECT workspace_name AS workspaceName,
                workspace_slug AS workspaceSlug
         FROM runtime_enrollment_tokens
         WHERE id = ?`,
      )
      .get(token.id) as {
      workspaceName: string | null;
      workspaceSlug: string | null;
    };

    expect(stored).toEqual({
      workspaceName: "Navia Dev",
      workspaceSlug: "navia-dev",
    });
    db.close();
  });

  it("exchanges one workspace registration token for runtime access and refresh tokens", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      label: "Test enrollment",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });

    const registered = registerRuntime(db, registrationRequest, enrollment.refreshToken);

    expect(registered.runtimeToken).toMatch(/^spark_rt_/);
    expect(registered.refreshToken).toMatch(/^spark_rt_refresh_/);
    const runtime = db
      .prepare("SELECT name, protocol_version AS protocolVersion FROM runtime_connections")
      .get() as { name: string; protocolVersion: string };
    const token = db
      .prepare(
        `SELECT used_at AS usedAt, created_runtime_id AS createdRuntimeId
         FROM runtime_enrollment_tokens
         WHERE id = ?`,
      )
      .get(enrollment.id) as {
      usedAt: string | null;
      createdRuntimeId: string | null;
    };
    const runtimeTokens = db
      .prepare(
        `SELECT token_hash AS tokenHash,
                scopes_json AS scopesJson,
                expires_at AS expiresAt,
                revoked_at AS revokedAt
         FROM runtime_tokens
         ORDER BY label`,
      )
      .all() as Array<{
      tokenHash: string;
      scopesJson: string;
      expiresAt: string | null;
      revokedAt: string | null;
    }>;

    expect(runtime).toEqual({
      name: "Test Spark daemon",
      protocolVersion: runtimeProtocolVersion,
    });
    expect(token.usedAt).toBeTruthy();
    expect(token.createdRuntimeId).toBe(registered.runtimeId);
    expect(runtimeTokens).toHaveLength(2);
    expect(runtimeTokens.map((row) => JSON.parse(row.scopesJson))).toEqual([
      ["runtime:connect"],
      ["runtime:refresh"],
    ]);
    expect(runtimeTokens.map((row) => row.expiresAt)).toEqual([
      registered.runtimeTokenExpiresAt,
      registered.refreshTokenExpiresAt,
    ]);
    expect(runtimeTokens.map((row) => row.revokedAt)).toEqual([null, null]);
    expect(runtimeTokens.map((row) => row.tokenHash)).toContain(hash(registered.runtimeToken));
    expect(runtimeTokens.map((row) => row.tokenHash)).toContain(hash(registered.refreshToken));
    expect(JSON.stringify(runtimeTokens)).not.toContain(registered.runtimeToken);
    expect(JSON.stringify(runtimeTokens)).not.toContain(registered.refreshToken);
    expectRuntimeEnrollmentError(db, enrollment.refreshToken, "WORKSPACE_REGISTRATION_TOKEN_USED");
    db.close();
  });

  it("creates a server workspace and owner binding when registration includes a workspace", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      label: "Workspace enrollment",
      workspaceName: "Navia Dev",
      workspaceSlug: "navia-dev",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });

    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "local-default",
          displayName: "Local default",
        },
      },
      enrollment.refreshToken,
    );

    const workspaceBinding = registered.workspaceBinding;
    expect(workspaceBinding).toMatchObject({
      workspaceId: expect.stringMatching(/^ws_/),
      bindingId: expect.stringMatching(/^rtwb_/),
      localWorkspaceKey: "local-default",
      displayName: "Local default",
      status: "available",
    });
    if (!workspaceBinding) {
      throw new Error("Expected workspace binding registration result.");
    }
    const workspace = db
      .prepare("SELECT id, slug, name FROM workspaces WHERE slug = ?")
      .get("navia-dev") as { id: string; slug: string; name: string };
    const binding = db
      .prepare(
        `SELECT id,
                runtime_id AS runtimeId,
                local_workspace_key AS localWorkspaceKey,
                display_name AS displayName,
                status
         FROM runtime_workspace_bindings
         WHERE id = ?`,
      )
      .get(workspaceBinding.bindingId) as {
      id: string;
      runtimeId: string;
      localWorkspaceKey: string;
      displayName: string;
      status: string;
    };
    const owner = db
      .prepare(
        `SELECT workspace_id AS workspaceId,
                runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
                ended_at AS endedAt
         FROM workspace_owner_bindings
         WHERE workspace_id = ?`,
      )
      .get(workspace.id) as {
      workspaceId: string;
      runtimeWorkspaceBindingId: string;
      endedAt: string | null;
    };
    const token = db
      .prepare("SELECT workspace_id AS workspaceId FROM runtime_enrollment_tokens WHERE id = ?")
      .get(enrollment.id) as { workspaceId: string | null };

    expect(workspace).toMatchObject({
      id: workspaceBinding.workspaceId,
      slug: "navia-dev",
      name: "Navia Dev",
    });
    expect(binding).toMatchObject({
      id: workspaceBinding.bindingId,
      runtimeId: registered.runtimeId,
      localWorkspaceKey: "local-default",
      displayName: "Local default",
      status: "available",
    });
    expect(owner).toEqual({
      workspaceId: workspace.id,
      runtimeWorkspaceBindingId: binding.id,
      endedAt: null,
    });
    expect(token.workspaceId).toBe(workspace.id);
    db.close();
  });

  it("registers an additional workspace grant without rotating runtime credentials", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const initial = createRuntimeEnrollmentToken(db, {
      label: "Initial workspace enrollment",
      workspaceName: "Navia Dev",
      workspaceSlug: "navia-dev",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });
    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "navia-dev",
          displayName: "Navia Dev",
        },
      },
      initial.refreshToken,
    );
    const second = createRuntimeEnrollmentToken(db, {
      label: "Second workspace enrollment",
      workspaceName: "Spore",
      workspaceSlug: "spore",
      createdAt: "2026-05-25T00:01:00.000Z",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });

    const workspace = registerRuntimeWorkspace(
      db,
      registered.runtimeId,
      {
        registrationToken: second.refreshToken,
        workspaceRegistration: {
          localWorkspaceKey: "spore",
          displayName: "Spore",
        },
      },
      registered.runtimeToken,
    );

    expect(workspace).toMatchObject({
      runtimeId: registered.runtimeId,
      workspaceBinding: {
        workspaceId: expect.stringMatching(/^ws_/),
        bindingId: expect.stringMatching(/^rtwb_/),
        localWorkspaceKey: "spore",
        displayName: "Spore",
        status: "available",
      },
    });
    const runtimeTokens = db
      .prepare(
        `SELECT token_hash AS tokenHash,
                revoked_at AS revokedAt
         FROM runtime_tokens
         WHERE runtime_id = ?`,
      )
      .all(registered.runtimeId) as Array<{
      tokenHash: string;
      revokedAt: string | null;
    }>;
    expect(runtimeTokens).toHaveLength(2);
    expect(runtimeTokens.map((row) => row.tokenHash)).toContain(hash(registered.runtimeToken));
    expect(runtimeTokens.map((row) => row.tokenHash)).toContain(hash(registered.refreshToken));
    expect(runtimeTokens.map((row) => row.revokedAt)).toEqual([null, null]);

    const token = db
      .prepare(
        `SELECT used_at AS usedAt,
                created_runtime_id AS createdRuntimeId,
                workspace_id AS workspaceId
         FROM runtime_enrollment_tokens
         WHERE id = ?`,
      )
      .get(second.id) as {
      usedAt: string | null;
      createdRuntimeId: string | null;
      workspaceId: string | null;
    };
    expect(token.usedAt).toBeTruthy();
    expect(token.createdRuntimeId).toBe(registered.runtimeId);
    expect(token.workspaceId).toBe(workspace.workspaceBinding.workspaceId);
    db.close();
  });

  it("requires a runtime access token for additional workspace grants", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db);
    const registered = registerRuntime(db, registrationRequest, enrollment.refreshToken);
    const second = createRuntimeEnrollmentToken(db, {
      workspaceName: "Spore",
      workspaceSlug: "spore",
    });

    expectRuntimeAccessError(
      db,
      registered.runtimeId,
      {
        registrationToken: second.refreshToken,
        workspaceRegistration: {
          localWorkspaceKey: "spore",
          displayName: "Spore",
        },
      },
      null,
      "RUNTIME_TOKEN_REQUIRED",
    );
    db.close();
  });

  it("rotates refresh tokens once and revokes old access tokens", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      label: "Test enrollment",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });
    const registered = registerRuntime(db, registrationRequest, enrollment.refreshToken);

    const refreshed = refreshRuntimeToken(db, {
      runtimeId: registered.runtimeId,
      refreshToken: registered.refreshToken,
      refreshedAt: "2026-05-25T00:30:00.000Z",
    });

    expect(refreshed.runtimeToken).toMatch(/^spark_rt_/);
    expect(refreshed.runtimeToken).not.toBe(registered.runtimeToken);
    expect(refreshed.refreshToken).toMatch(/^spark_rt_refresh_/);
    expect(refreshed.refreshToken).not.toBe(registered.refreshToken);

    const rows = db
      .prepare(
        `SELECT token_hash AS tokenHash,
                scopes_json AS scopesJson,
                revoked_at AS revokedAt
         FROM runtime_tokens`,
      )
      .all() as Array<{
      tokenHash: string;
      scopesJson: string;
      revokedAt: string | null;
    }>;
    const originalAccess = rows.find((row) => row.tokenHash === hash(registered.runtimeToken));
    const originalRefresh = rows.find((row) => row.tokenHash === hash(registered.refreshToken));
    const newAccess = rows.find((row) => row.tokenHash === hash(refreshed.runtimeToken));
    const newRefresh = rows.find((row) => row.tokenHash === hash(refreshed.refreshToken));

    expect(originalAccess?.revokedAt).toBe("2026-05-25T00:30:00.000Z");
    expect(originalRefresh?.revokedAt).toBe("2026-05-25T00:30:00.000Z");
    expect(JSON.parse(newAccess?.scopesJson ?? "[]")).toEqual(["runtime:connect"]);
    expect(JSON.parse(newRefresh?.scopesJson ?? "[]")).toEqual(["runtime:refresh"]);
    expect(newAccess?.revokedAt).toBeNull();
    expect(newRefresh?.revokedAt).toBeNull();
    expectRuntimeRefreshError(
      db,
      registered.runtimeId,
      registered.refreshToken,
      "REFRESH_TOKEN_USED",
    );
    db.close();
  });

  it("rejects missing, invalid, expired, and revoked workspace registration tokens", () => {
    const db = openMemoryDatabase();
    migrate(db);

    const expired = createRuntimeEnrollmentToken(db, {
      label: "Expired enrollment",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: -1,
    });
    const revoked = createRuntimeEnrollmentToken(db, {
      label: "Revoked enrollment",
      createdAt: "2026-05-25T00:00:00.000Z",
    });

    expect(revokeRuntimeEnrollmentToken(db, { id: revoked.id })).toBe(true);
    expectRuntimeEnrollmentError(db, null, "WORKSPACE_REGISTRATION_TOKEN_REQUIRED");
    expectRuntimeEnrollmentError(db, "spark_wsreg_invalid", "WORKSPACE_REGISTRATION_TOKEN_INVALID");
    expectRuntimeEnrollmentError(db, expired.refreshToken, "WORKSPACE_REGISTRATION_TOKEN_EXPIRED");
    expectRuntimeEnrollmentError(db, revoked.refreshToken, "WORKSPACE_REGISTRATION_TOKEN_REVOKED");
    db.close();
  });

  it("lists workspace registration token metadata without exposing token hashes or secrets", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const active = createRuntimeEnrollmentToken(db, {
      label: "Active enrollment",
      createdAt: "2026-05-25T00:00:00.000Z",
    });
    const revoked = createRuntimeEnrollmentToken(db, {
      label: "Revoked enrollment",
      createdAt: "2026-05-25T00:01:00.000Z",
    });
    revokeRuntimeEnrollmentToken(db, {
      id: revoked.id,
      revokedAt: "2026-05-25T00:02:00.000Z",
    });

    const tokens = listRuntimeEnrollmentTokens(db, { includeRevoked: true });

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({
      id: revoked.id,
      label: "Revoked enrollment",
      revokedAt: "2026-05-25T00:02:00.000Z",
    });
    expect(tokens[1]).toMatchObject({
      id: active.id,
      label: "Active enrollment",
      revokedAt: null,
      usedAt: null,
    });
    expect(JSON.stringify(tokens)).not.toContain(active.refreshToken);
    expect(JSON.stringify(tokens)).not.toContain(revoked.refreshToken);
    expect(JSON.stringify(tokens)).not.toContain("tokenHash");

    expect(listRuntimeEnrollmentTokens(db)).toHaveLength(1);
    expect(listRuntimeEnrollmentTokens(db)[0]?.id).toBe(active.id);
    db.close();
  });

  it("does not revoke consumed workspace registration tokens", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db);

    registerRuntime(db, registrationRequest, enrollment.refreshToken);

    expect(revokeRuntimeEnrollmentToken(db, { id: enrollment.id })).toBe(false);
    const stored = db
      .prepare("SELECT revoked_at AS revokedAt FROM runtime_enrollment_tokens WHERE id = ?")
      .get(enrollment.id) as { revokedAt: string | null };
    expect(stored.revokedAt).toBeNull();
    db.close();
  });
});

function expectRuntimeEnrollmentError(
  db: ReturnType<typeof openMemoryDatabase>,
  refreshToken: string | null,
  reasonCode: string,
) {
  try {
    registerRuntime(db, registrationRequest, refreshToken);
  } catch (caught) {
    expect(caught).toBeInstanceOf(RuntimeEnrollmentError);
    expect((caught as RuntimeEnrollmentError).reasonCode).toBe(reasonCode);
    return;
  }

  throw new Error(`Expected RuntimeEnrollmentError ${reasonCode}`);
}

function expectRuntimeRefreshError(
  db: ReturnType<typeof openMemoryDatabase>,
  runtimeId: string,
  refreshToken: string | null,
  reasonCode: string,
) {
  try {
    refreshRuntimeToken(db, { runtimeId, refreshToken });
  } catch (caught) {
    expect(caught).toBeInstanceOf(RuntimeTokenRefreshError);
    expect((caught as RuntimeTokenRefreshError).reasonCode).toBe(reasonCode);
    return;
  }

  throw new Error(`Expected RuntimeTokenRefreshError ${reasonCode}`);
}

function expectRuntimeAccessError(
  db: ReturnType<typeof openMemoryDatabase>,
  runtimeId: string,
  request: Parameters<typeof registerRuntimeWorkspace>[2],
  runtimeToken: string | null,
  reasonCode: string,
) {
  try {
    registerRuntimeWorkspace(db, runtimeId, request, runtimeToken);
  } catch (caught) {
    expect(caught).toBeInstanceOf(RuntimeAccessTokenError);
    expect((caught as RuntimeAccessTokenError).reasonCode).toBe(reasonCode);
    return;
  }

  throw new Error(`Expected RuntimeAccessTokenError ${reasonCode}`);
}

function hash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
