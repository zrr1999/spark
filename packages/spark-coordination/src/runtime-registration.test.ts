import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase, openMemoryDatabase } from "@zendev-lab/spark-db";
import {
  runtimeProtocolVersion,
  type RuntimeRegistrationRequest,
} from "@zendev-lab/spark-protocol";
import {
  approveRuntimeDeviceAuthorization,
  createRuntimeDeviceAuthorization,
  createRuntimeEnrollmentToken,
  createRuntimeWorkspaceBrowserAccess,
  denyRuntimeDeviceAuthorization,
  exchangeRuntimeDeviceAuthorization,
  getRuntimeDeviceAuthorizationForApproval,
  listRuntimeEnrollmentTokens,
  registerRuntime,
  registerRuntimeWorkspace,
  refreshRuntimeToken,
  revokeRuntimeEnrollmentToken,
  RuntimeAccessTokenError,
  RuntimeDeviceAuthorizationError,
  RuntimeEnrollmentError,
  RuntimeTokenRefreshError,
  RuntimeWorkspaceLeaseConflictError,
  RuntimeWorkspaceOwnerConflictError,
  unbindRuntimeWorkspace,
} from "./runtime-registration";

const registrationRequest = {
  installationId: "install-test",
  displayName: "Test Spark daemon",
  runtimeVersion: "0.1.0-test",
  supportedFeatures: ["ws-control-v1", "command-routing-v1"],
  labels: { test: "true" },
} satisfies RuntimeRegistrationRequest;

const durableEnrollmentTtlMs = 100 * 365 * 24 * 60 * 60 * 1000;

describe("runtime registration", () => {
  it("mints browser access only for this runtime's actively leased binding", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      workspaceName: "Browser access",
      workspaceSlug: "browser-access",
      ttlMs: durableEnrollmentTtlMs,
    });
    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "browser-access",
          localPath: "/Users/test/workspaces/browser-access",
          displayName: "Browser access",
        },
      },
      enrollment.refreshToken,
    );
    const bindingId = registered.workspaceBinding?.bindingId;
    expect(bindingId).toMatch(/^rtwb_/);
    const activeBindingId = bindingId!;

    const authorization = createRuntimeWorkspaceBrowserAccess(db, {
      runtimeId: registered.runtimeId,
      bindingId: activeBindingId,
      runtimeToken: registered.runtimeToken,
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    expect(authorization).toMatchObject({
      workspaceId: registered.workspaceBinding?.workspaceId,
      oneTimeToken: expect.stringMatching(/^spark_workspace_auth_/),
    });

    db.prepare(
      "UPDATE workspace_leases SET ended_at = ? WHERE runtime_workspace_binding_id = ? AND ended_at IS NULL",
    ).run("2026-07-20T00:00:01.000Z", activeBindingId);
    expect(() =>
      createRuntimeWorkspaceBrowserAccess(db, {
        runtimeId: registered.runtimeId,
        bindingId: activeBindingId,
        runtimeToken: registered.runtimeToken,
        createdAt: "2026-07-20T00:00:02.000Z",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeEnrollmentError>>({
        reasonCode: "WORKSPACE_BINDING_NOT_FOUND",
      }),
    );
    db.close();
  });

  it("rejects browser access when the binding does not belong to the authenticated runtime", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const firstEnrollment = createRuntimeEnrollmentToken(db, {
      workspaceName: "Browser owner",
      workspaceSlug: "browser-owner",
      ttlMs: durableEnrollmentTtlMs,
    });
    const owner = registerRuntime(
      db,
      {
        ...registrationRequest,
        installationId: "install-browser-owner",
        workspaceRegistration: {
          localWorkspaceKey: "browser-owner",
          localPath: "/Users/test/workspaces/browser-owner",
          displayName: "Browser owner",
        },
      },
      firstEnrollment.refreshToken,
    );
    const otherEnrollment = createRuntimeEnrollmentToken(db, { ttlMs: durableEnrollmentTtlMs });
    const other = registerRuntime(
      db,
      { ...registrationRequest, installationId: "install-browser-other" },
      otherEnrollment.refreshToken,
    );

    expect(() =>
      createRuntimeWorkspaceBrowserAccess(db, {
        runtimeId: other.runtimeId,
        bindingId: owner.workspaceBinding!.bindingId,
        runtimeToken: other.runtimeToken,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeEnrollmentError>>({
        reasonCode: "WORKSPACE_BINDING_NOT_FOUND",
      }),
    );
    db.close();
  });

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
      workspaceName: "Spark Dev",
      workspaceSlug: "spark-dev",
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
      workspaceName: "Spark Dev",
      workspaceSlug: "spark-dev",
    });
    db.close();
  });

  it("exchanges one workspace registration token for runtime access and refresh tokens", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      label: "Test enrollment",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: durableEnrollmentTtlMs,
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
      workspaceName: "Spark Dev",
      workspaceSlug: "spark-dev",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: durableEnrollmentTtlMs,
    });

    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "local-default",
          localPath: "/Users/test/workspaces/local-default",
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
      displayName: "local-default",
      status: "available",
    });
    expect(registered.workspaceAuthorization).toMatchObject({
      workspaceId: workspaceBinding?.workspaceId,
      workspaceSlug: "local-default",
      oneTimeToken: expect.stringMatching(/^spark_workspace_auth_/),
      expiresAt: expect.any(String),
    });
    if (!workspaceBinding) {
      throw new Error("Expected workspace binding registration result.");
    }
    const workspace = db
      .prepare("SELECT id, slug, name FROM workspaces WHERE slug = ?")
      .get("local-default") as { id: string; slug: string; name: string };
    const binding = db
      .prepare(
        `SELECT id,
                runtime_id AS runtimeId,
                local_workspace_key AS localWorkspaceKey,
                local_path AS localPath,
                display_name AS displayName,
                status
         FROM runtime_workspace_bindings
         WHERE id = ?`,
      )
      .get(workspaceBinding.bindingId) as {
      id: string;
      runtimeId: string;
      localWorkspaceKey: string;
      localPath: string | null;
      displayName: string;
      status: string;
    };
    expect(binding.localPath).toBe("/Users/test/workspaces/local-default");
    const owner = db
      .prepare(
        `SELECT workspace_id AS workspaceId,
                runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
                ended_at AS endedAt
         FROM workspace_leases
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
      slug: "local-default",
      name: "local-default",
    });
    expect(binding).toMatchObject({
      id: workspaceBinding.bindingId,
      runtimeId: registered.runtimeId,
      localWorkspaceKey: "local-default",
      displayName: "local-default",
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

  it("rebinds a drifted workspace name to the connected directory basename", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      label: "Drifted workspace",
      workspaceName: "spore",
      workspaceSlug: "spore",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: durableEnrollmentTtlMs,
    });

    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "spark",
          localPath: "/Users/test/workspaces/spark",
          displayName: "Unrelated label",
        },
      },
      enrollment.refreshToken,
    );

    expect(registered.workspaceBinding?.displayName).toBe("spark");
    expect(registered.workspaceAuthorization?.workspaceSlug).toBe("spark");
    const workspace = db
      .prepare("SELECT slug, name FROM workspaces WHERE id = ?")
      .get(registered.workspaceBinding!.workspaceId) as { slug: string; name: string };
    expect(workspace).toEqual({ slug: "spark", name: "spark" });
    db.close();
  });

  it("rejects a second active origin lease for the same local path", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const localPath = "/Users/test/workspaces/shared-lease";
    const firstEnrollment = createRuntimeEnrollmentToken(db, {
      workspaceName: "shared-lease",
      workspaceSlug: "shared-lease",
      ttlMs: durableEnrollmentTtlMs,
    });
    const first = registerRuntime(
      db,
      {
        ...registrationRequest,
        installationId: "install-lease-a",
        workspaceRegistration: {
          localWorkspaceKey: "lease-a",
          localPath,
          displayName: "shared-lease",
        },
      },
      firstEnrollment.refreshToken,
    );
    expect(first.workspaceBinding?.bindingId).toMatch(/^rtwb_/);

    const now = "2026-07-15T00:00:00.000Z";
    db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, description, status, settings_json, created_at, updated_at)
       VALUES ('ws_lease_other', 'other-lease', 'other-lease', NULL, 'active', '{}', ?, ?)`,
    ).run(now, now);
    const secondEnrollment = createRuntimeEnrollmentToken(db, {
      workspaceId: "ws_lease_other",
      ttlMs: durableEnrollmentTtlMs,
    });
    const conflict = expectWorkspaceOwnerConflict(() =>
      registerRuntime(
        db,
        {
          ...registrationRequest,
          installationId: "install-lease-b",
          workspaceRegistration: {
            localWorkspaceKey: "lease-b",
            localPath,
            displayName: "other-lease",
          },
        },
        secondEnrollment.refreshToken,
      ),
    );
    expect(conflict.conflict.workspaceId).toBe(first.workspaceBinding?.workspaceId);
    expect(conflict.conflict.currentBindingId).toBe(first.workspaceBinding?.bindingId);
    const activeLeases = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM workspace_leases
         WHERE ended_at IS NULL`,
      )
      .get() as { count: number };
    expect(activeLeases.count).toBe(1);
    db.close();
  });

  it("keeps the same active owner binding for idempotent same-runtime registration", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      workspaceName: "Shared workspace",
      workspaceSlug: "shared-workspace",
      ttlMs: durableEnrollmentTtlMs,
    });
    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "shared-local",
          displayName: "Shared workspace",
        },
      },
      enrollment.refreshToken,
    );
    const firstBinding = registered.workspaceBinding;
    if (!firstBinding) throw new Error("Expected the initial workspace binding.");
    const repeatGrant = createRuntimeEnrollmentToken(db, {
      workspaceId: firstBinding.workspaceId,
      ttlMs: durableEnrollmentTtlMs,
    });

    const repeated = registerRuntimeWorkspace(
      db,
      registered.runtimeId,
      {
        registrationToken: repeatGrant.refreshToken,
        workspaceRegistration: {
          localWorkspaceKey: "shared-local",
          displayName: "Shared workspace updated",
        },
      },
      registered.runtimeToken,
    );

    expect(repeated.workspaceBinding.bindingId).toBe(firstBinding.bindingId);
    expect(
      db
        .prepare(
          `SELECT runtime_workspace_binding_id AS bindingId, ended_at AS endedAt
           FROM workspace_leases
           WHERE workspace_id = ?`,
        )
        .all(firstBinding.workspaceId),
    ).toEqual([{ bindingId: firstBinding.bindingId, endedAt: null }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_workspace_bindings").get()).toEqual({
      count: 1,
    });
    db.close();
  });

  it("moves one daemon-owned directory with an explicit target workspace token", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const firstGrant = createRuntimeEnrollmentToken(db, {
      workspaceName: "First workspace",
      workspaceSlug: "first-workspace",
      ttlMs: durableEnrollmentTtlMs,
    });
    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "shared-local",
          displayName: "Shared local directory",
        },
      },
      firstGrant.refreshToken,
    );
    const first = registered.workspaceBinding;
    if (!first) throw new Error("Expected the initial workspace binding.");
    const targetGrant = createRuntimeEnrollmentToken(db, {
      workspaceName: "Second workspace",
      workspaceSlug: "second-workspace",
      ttlMs: durableEnrollmentTtlMs,
    });

    const rebound = registerRuntimeWorkspace(
      db,
      registered.runtimeId,
      {
        registrationToken: targetGrant.refreshToken,
        workspaceRegistration: {
          localWorkspaceKey: "shared-local",
          displayName: "Shared local directory",
        },
      },
      registered.runtimeToken,
    );

    expect(rebound.workspaceBinding.bindingId).toBe(first.bindingId);
    expect(rebound.workspaceBinding.workspaceId).not.toBe(first.workspaceId);
    expect(
      db
        .prepare(
          `SELECT workspace_id AS workspaceId, ended_at AS endedAt
           FROM workspace_leases
           WHERE runtime_workspace_binding_id = ?
           ORDER BY started_at`,
        )
        .all(first.bindingId),
    ).toEqual([
      { workspaceId: first.workspaceId, endedAt: expect.any(String) },
      { workspaceId: rebound.workspaceBinding.workspaceId, endedAt: null },
    ]);
    expect(
      db.prepare("SELECT kind FROM events WHERE kind = 'workspace.lease_rebound'").get(),
    ).toEqual({ kind: "workspace.lease_rebound" });
    db.close();
  });

  it("rejects a second workspace lease when another workspace already holds the same local_path", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const sharedPath = "/Users/test/workspaces/shared-path-lease";
    const firstGrant = createRuntimeEnrollmentToken(db, {
      workspaceName: "Path first",
      workspaceSlug: "path-first",
      ttlMs: durableEnrollmentTtlMs,
    });
    registerRuntime(
      db,
      {
        ...registrationRequest,
        installationId: "install-path-first",
        workspaceRegistration: {
          localWorkspaceKey: "path-first",
          localPath: sharedPath,
          displayName: "Path first",
        },
      },
      firstGrant.refreshToken,
    );

    const secondGrant = createRuntimeEnrollmentToken(db, {
      workspaceName: "Path second",
      workspaceSlug: "path-second",
      ttlMs: durableEnrollmentTtlMs,
    });
    expectWorkspaceOwnerConflict(() =>
      registerRuntime(
        db,
        {
          ...registrationRequest,
          installationId: "install-path-second",
          workspaceRegistration: {
            localWorkspaceKey: "path-second",
            localPath: sharedPath,
            displayName: "Path second",
          },
        },
        secondGrant.refreshToken,
      ),
    );
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM workspace_leases WHERE ended_at IS NULL").get(),
    ).toEqual({ count: 1 });
    db.close();
  });

  it("lets an authenticated daemon unbind its own directory before switching Cockpits", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const grant = createRuntimeEnrollmentToken(db, {
      workspaceName: "Source workspace",
      workspaceSlug: "source-workspace",
      ttlMs: durableEnrollmentTtlMs,
    });
    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "source-local",
          displayName: "Source local",
        },
      },
      grant.refreshToken,
    );
    const binding = registered.workspaceBinding;
    if (!binding) throw new Error("Expected a workspace binding.");

    const result = unbindRuntimeWorkspace(db, {
      runtimeId: registered.runtimeId,
      bindingId: binding.bindingId,
      runtimeToken: registered.runtimeToken,
      unboundAt: "2026-07-20T00:00:00.000Z",
    });

    expect(result).toEqual({
      runtimeId: registered.runtimeId,
      bindingId: binding.bindingId,
      workspaceIds: [binding.workspaceId],
      unboundAt: "2026-07-20T00:00:00.000Z",
    });
    expect(ownerBindingState(db, binding.workspaceId)?.endedAt).toBe("2026-07-20T00:00:00.000Z");
    db.close();
  });

  it("rejects owner takeover across enrollment, device, and refreshed-token registration", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertUser(db, "usr_owner", "owner", "active");
    const ownerEnrollment = createRuntimeEnrollmentToken(db, {
      workspaceName: "Shared workspace",
      workspaceSlug: "shared-workspace",
      ttlMs: durableEnrollmentTtlMs,
    });
    const owner = registerRuntime(
      db,
      {
        ...registrationRequest,
        installationId: "install-owner",
        workspaceRegistration: {
          localWorkspaceKey: "owner-local",
          displayName: "Shared workspace",
        },
      },
      ownerEnrollment.refreshToken,
    );
    const ownerBinding = owner.workspaceBinding;
    if (!ownerBinding) throw new Error("Expected the owner workspace binding.");
    insertPendingCommandDelivery(db, ownerBinding.workspaceId, ownerBinding.bindingId);
    const originalOwner = ownerBindingState(db, ownerBinding.workspaceId);
    const originalDelivery = pendingDeliveryState(db);
    if (!originalOwner || !originalDelivery) throw new Error("Expected original owner state.");
    const originalOwnerBindingId = originalOwner.bindingId;
    const originalDeliveryBindingId = originalDelivery.bindingId;
    const conflictErrors: RuntimeWorkspaceOwnerConflictError[] = [];

    const directGrant = createRuntimeEnrollmentToken(db, {
      workspaceId: ownerBinding.workspaceId,
      ttlMs: durableEnrollmentTtlMs,
    });
    const tokenMarker = "spark_wsreg_OWNER_GUARD_SECRET_MARKER_DO_NOT_PERSIST";
    db.prepare("UPDATE runtime_enrollment_tokens SET token_hash = ? WHERE id = ?").run(
      hash(tokenMarker),
      directGrant.id,
    );
    conflictErrors.push(
      expectWorkspaceOwnerConflict(() =>
        registerRuntime(
          db,
          {
            ...registrationRequest,
            installationId: "install-direct-conflict",
            workspaceRegistration: {
              localWorkspaceKey: "direct-conflict",
              displayName: "Direct conflict",
            },
          },
          tokenMarker,
        ),
      ),
    );

    const deviceAuthorization = createRuntimeDeviceAuthorization(db, {
      ...registrationRequest,
      installationId: "install-device-conflict",
    });
    approveRuntimeDeviceAuthorization(db, {
      userCode: deviceAuthorization.userCode,
      approvedByUserId: "usr_owner",
    });
    const deviceRuntime = exchangeRuntimeDeviceAuthorization(db, {
      deviceCode: deviceAuthorization.deviceCode,
    });
    const deviceWorkspaceGrant = createRuntimeEnrollmentToken(db, {
      workspaceId: ownerBinding.workspaceId,
      ttlMs: durableEnrollmentTtlMs,
    });
    conflictErrors.push(
      expectWorkspaceOwnerConflict(() =>
        registerRuntimeWorkspace(
          db,
          deviceRuntime.runtimeId,
          {
            registrationToken: deviceWorkspaceGrant.refreshToken,
            workspaceRegistration: {
              localWorkspaceKey: "device-conflict",
              displayName: "Device conflict",
              workspaceSlug: "shared-workspace",
            },
          },
          deviceRuntime.runtimeToken,
        ),
      ),
    );

    const bootstrapGrant = createRuntimeEnrollmentToken(db, {
      ttlMs: durableEnrollmentTtlMs,
    });
    const refreshRuntime = registerRuntime(
      db,
      { ...registrationRequest, installationId: "install-refresh-conflict" },
      bootstrapGrant.refreshToken,
    );
    const refreshed = refreshRuntimeToken(db, {
      runtimeId: refreshRuntime.runtimeId,
      refreshToken: refreshRuntime.refreshToken,
    });
    const refreshWorkspaceGrant = createRuntimeEnrollmentToken(db, {
      workspaceId: ownerBinding.workspaceId,
      ttlMs: durableEnrollmentTtlMs,
    });
    conflictErrors.push(
      expectWorkspaceOwnerConflict(() =>
        registerRuntimeWorkspace(
          db,
          refreshRuntime.runtimeId,
          {
            registrationToken: refreshWorkspaceGrant.refreshToken,
            workspaceRegistration: {
              localWorkspaceKey: "refresh-conflict",
              displayName: "Refresh conflict",
            },
          },
          refreshed.runtimeToken,
        ),
      ),
    );

    expect(conflictErrors.map((error) => error.reasonCode)).toEqual([
      "WORKSPACE_LEASE_CONFLICT",
      "WORKSPACE_LEASE_CONFLICT",
      "WORKSPACE_LEASE_CONFLICT",
    ]);
    expect(ownerBindingState(db, ownerBinding.workspaceId)).toEqual(originalOwner);
    expect(pendingDeliveryState(db)).toEqual(originalDelivery);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM workspace_leases WHERE ended_at IS NULL").get(),
    ).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_workspace_bindings").get()).toEqual({
      count: 1,
    });
    expect(enrollmentConsumption(db, directGrant.id)).toEqual({ usedAt: null });
    expect(enrollmentConsumption(db, refreshWorkspaceGrant.id)).toEqual({ usedAt: null });

    const auditEvents = db
      .prepare(
        `SELECT workspace_id AS workspaceId, kind, subject_id AS subjectId,
                payload_json AS payloadJson, created_at AS createdAt
         FROM events
         WHERE kind = 'workspace.lease_registration_conflict'
         ORDER BY rowid`,
      )
      .all() as Array<{
      workspaceId: string;
      kind: string;
      subjectId: string;
      payloadJson: string;
      createdAt: string;
    }>;
    expect(auditEvents).toHaveLength(3);
    for (const event of auditEvents) {
      expect(event).toMatchObject({
        workspaceId: ownerBinding.workspaceId,
        kind: "workspace.lease_registration_conflict",
        subjectId: ownerBinding.bindingId,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(JSON.parse(event.payloadJson)).toMatchObject({
        currentRuntimeId: owner.runtimeId,
        currentBindingId: ownerBinding.bindingId,
        attemptedRuntimeId: expect.stringMatching(/^rt_/),
        attemptedBindingId: expect.stringMatching(/^rtwb_/),
        outcome: "rejected",
      });
    }
    const enrollmentRows = db
      .prepare(
        "SELECT token_hash AS tokenHash, label, used_at AS usedAt FROM runtime_enrollment_tokens",
      )
      .all();
    const auditableText = JSON.stringify({ auditEvents, conflictErrors, enrollmentRows });
    for (const secret of [
      tokenMarker,
      directGrant.refreshToken,
      deviceAuthorization.deviceCode,
      deviceAuthorization.userCode,
      deviceRuntime.runtimeToken,
      deviceRuntime.refreshToken,
      refreshed.runtimeToken,
      refreshed.refreshToken,
      refreshWorkspaceGrant.refreshToken,
    ]) {
      expect(auditableText).not.toContain(secret);
    }
    console.log(
      `SPARK_WORKSPACE_LEASE_CONFLICT_EVIDENCE ${JSON.stringify({
        conflictCode: conflictErrors[0]?.reasonCode,
        attemptedRuntimeCount: conflictErrors.length,
        activeOwnerCount: 1,
        activeBindingId: originalOwnerBindingId,
        expectedBindingId: ownerBinding.bindingId,
        totalOwnerBindingCount: 1,
        pendingDeliveryPreserved: pendingDeliveryState(db)?.bindingId === originalDeliveryBindingId,
        registrationTokensConsumed: 0,
        secretMarkerPersisted: auditableText.includes(tokenMarker),
      })}`,
    );
    db.close();
  });

  it("allows only one active owner when two runtime processes race", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-owner-race-"));
    const databasePath = join(root, "cockpit.sqlite");
    const db = openDatabase({ path: databasePath });
    migrate(db);
    insertUser(db, "usr_owner", "owner", "active");
    const runtimes = ["race-one", "race-two"].map((installationId) => {
      const authorization = createRuntimeDeviceAuthorization(db, {
        ...registrationRequest,
        installationId,
      });
      approveRuntimeDeviceAuthorization(db, {
        userCode: authorization.userCode,
        approvedByUserId: "usr_owner",
      });
      return exchangeRuntimeDeviceAuthorization(db, { deviceCode: authorization.deviceCode });
    });
    const grants = runtimes.map(() =>
      createRuntimeEnrollmentToken(db, {
        workspaceName: "Shared race workspace",
        workspaceSlug: "shared-race-workspace",
        ttlMs: durableEnrollmentTtlMs,
      }),
    );
    db.close();

    try {
      const children = runtimes.map(() => startRaceChild());
      await Promise.all(children.map((child) => waitForRaceMessage(child, "ready")));
      const results = children.map((child) => waitForRaceResult(child));
      children.forEach((child, index) => {
        child.process.send({
          databasePath,
          runtimeId: runtimes[index]?.runtimeId,
          runtimeToken: runtimes[index]?.runtimeToken,
          registrationToken: grants[index]?.refreshToken,
          localWorkspaceKey: `race-local-${index}`,
        });
      });
      const settledResults = await Promise.allSettled(results);
      const childErrors = settledResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (childErrors.length > 0) {
        throw new AggregateError(childErrors, "Owner race child process failed.");
      }
      const outcomes = settledResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );

      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
        { ok: false, reasonCode: "WORKSPACE_LEASE_CONFLICT" },
      ]);
      const verified = openDatabase({ path: databasePath });
      expect(
        verified
          .prepare("SELECT COUNT(*) AS count FROM workspace_leases WHERE ended_at IS NULL")
          .get(),
      ).toEqual({ count: 1 });
      expect(verified.prepare("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({
        count: 1,
      });
      expect(
        verified.prepare("SELECT COUNT(*) AS count FROM runtime_workspace_bindings").get(),
      ).toEqual({ count: 1 });
      expect(
        verified
          .prepare(
            "SELECT COUNT(*) AS count FROM events WHERE kind = 'workspace.lease_registration_conflict'",
          )
          .get(),
      ).toEqual({ count: 1 });
      verified.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers an additional workspace grant without rotating runtime credentials", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const initial = createRuntimeEnrollmentToken(db, {
      label: "Initial workspace enrollment",
      workspaceName: "Spark Dev",
      workspaceSlug: "spark-dev",
      createdAt: "2026-05-25T00:00:00.000Z",
      ttlMs: durableEnrollmentTtlMs,
    });
    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "spark-dev",
          displayName: "Spark Dev",
        },
      },
      initial.refreshToken,
    );
    const second = createRuntimeEnrollmentToken(db, {
      label: "Second workspace enrollment",
      workspaceName: "Spore",
      workspaceSlug: "spore",
      createdAt: "2026-05-25T00:01:00.000Z",
      ttlMs: durableEnrollmentTtlMs,
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
      ttlMs: durableEnrollmentTtlMs,
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

  it("stores daemon device and user codes as hashes only", () => {
    const db = openMemoryDatabase();
    migrate(db);

    const authorization = createRuntimeDeviceAuthorization(db, registrationRequest, {
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const stored = db
      .prepare(
        `SELECT device_code_hash AS deviceCodeHash,
                user_code_hash AS userCodeHash,
                registration_json AS registrationJson,
                expires_at AS expiresAt,
                interval_seconds AS intervalSeconds
         FROM runtime_device_authorizations`,
      )
      .get() as {
      deviceCodeHash: string;
      userCodeHash: string;
      registrationJson: string;
      expiresAt: string;
      intervalSeconds: number;
    };

    expect(authorization.deviceCode).toMatch(/^spark_device_/);
    expect(authorization.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(authorization.expiresIn).toBe(600);
    expect(authorization.interval).toBe(5);
    expect(stored).toMatchObject({
      deviceCodeHash: hash(authorization.deviceCode),
      userCodeHash: hash(authorization.userCode.replace("-", "")),
      expiresAt: "2026-07-13T00:10:00.000Z",
      intervalSeconds: 5,
    });
    expect(JSON.stringify(stored)).not.toContain(authorization.deviceCode);
    expect(JSON.stringify(stored)).not.toContain(authorization.userCode);
    expect(JSON.parse(stored.registrationJson)).toMatchObject(registrationRequest);
    db.close();
  });

  it("bounds pending device authorizations per installation and across Cockpit", () => {
    const installationDb = openMemoryDatabase();
    migrate(installationDb);
    for (let index = 0; index < 3; index += 1) {
      createRuntimeDeviceAuthorization(installationDb, registrationRequest, {
        createdAt: "2026-07-13T00:00:00.000Z",
      });
    }

    expectRuntimeDeviceError(
      () =>
        createRuntimeDeviceAuthorization(installationDb, registrationRequest, {
          createdAt: "2026-07-13T00:00:01.000Z",
        }),
      "too_many_pending_authorizations",
    );
    expect(
      installationDb.prepare("SELECT COUNT(*) AS count FROM runtime_device_authorizations").get(),
    ).toEqual({ count: 3 });
    installationDb.close();

    const globalDb = openMemoryDatabase();
    migrate(globalDb);
    for (const installationId of ["install-one", "install-two"]) {
      createRuntimeDeviceAuthorization(
        globalDb,
        { ...registrationRequest, installationId },
        { createdAt: "2026-07-13T00:00:00.000Z" },
      );
    }

    expectRuntimeDeviceError(
      () =>
        createRuntimeDeviceAuthorization(
          globalDb,
          { ...registrationRequest, installationId: "install-three" },
          {
            createdAt: "2026-07-13T00:00:01.000Z",
            maxPendingGlobal: 2,
          },
        ),
      "authorization_capacity_exceeded",
    );
    expect(
      globalDb.prepare("SELECT COUNT(*) AS count FROM runtime_device_authorizations").get(),
    ).toEqual({ count: 2 });
    globalDb.close();
  });

  it("deletes old expired, denied, and consumed device authorizations on creation", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertUser(db, "usr_owner", "owner", "active");

    createRuntimeDeviceAuthorization(
      db,
      { ...registrationRequest, installationId: "install-expired" },
      { createdAt: "2026-07-13T00:00:00.000Z", ttlMs: 1_000 },
    );
    const denied = createRuntimeDeviceAuthorization(
      db,
      { ...registrationRequest, installationId: "install-denied" },
      { createdAt: "2026-07-13T00:00:00.000Z" },
    );
    denyRuntimeDeviceAuthorization(db, {
      userCode: denied.userCode,
      deniedByUserId: "usr_owner",
      deniedAt: "2026-07-13T00:00:10.000Z",
    });
    const consumed = createRuntimeDeviceAuthorization(
      db,
      { ...registrationRequest, installationId: "install-consumed" },
      { createdAt: "2026-07-13T00:00:00.000Z" },
    );
    approveRuntimeDeviceAuthorization(db, {
      userCode: consumed.userCode,
      approvedByUserId: "usr_owner",
      approvedAt: "2026-07-13T00:00:10.000Z",
    });
    exchangeRuntimeDeviceAuthorization(db, {
      deviceCode: consumed.deviceCode,
      polledAt: "2026-07-13T00:00:11.000Z",
    });

    createRuntimeDeviceAuthorization(
      db,
      { ...registrationRequest, installationId: "install-current" },
      {
        createdAt: "2026-07-13T00:02:01.000Z",
        retentionMs: 60_000,
      },
    );

    const rows = db
      .prepare(
        `SELECT installation_id AS installationId
         FROM runtime_device_authorizations
         ORDER BY installation_id`,
      )
      .all() as Array<{ installationId: string }>;
    expect(rows).toEqual([{ installationId: "install-current" }]);
    db.close();
  });

  it("protects browser approval with an active owner and normalizes user codes", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertUser(db, "usr_member", "member", "active");
    insertUser(db, "usr_owner", "owner", "active");
    const authorization = createRuntimeDeviceAuthorization(db, registrationRequest, {
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    expectRuntimeDeviceError(
      () =>
        getRuntimeDeviceAuthorizationForApproval(db, {
          userCode: authorization.userCode,
          currentUserId: null,
        }),
      "approval_forbidden",
    );
    expectRuntimeDeviceError(
      () =>
        getRuntimeDeviceAuthorizationForApproval(db, {
          userCode: authorization.userCode,
          currentUserId: "usr_member",
        }),
      "approval_forbidden",
    );

    const normalizedInput = authorization.userCode.toLowerCase().replace("-", " ");
    expect(
      getRuntimeDeviceAuthorizationForApproval(db, {
        userCode: normalizedInput,
        currentUserId: "usr_owner",
        now: "2026-07-13T00:01:00.000Z",
      }),
    ).toMatchObject({
      userCode: authorization.userCode,
      installationId: registrationRequest.installationId,
      displayName: registrationRequest.displayName,
      status: "pending",
    });

    expect(
      approveRuntimeDeviceAuthorization(db, {
        userCode: normalizedInput,
        approvedByUserId: "usr_owner",
        approvedAt: "2026-07-13T00:01:00.000Z",
      }).status,
    ).toBe("approved");
    db.close();
  });

  it("reports pending, slow-down, denied, and expired device authorization states", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertUser(db, "usr_owner", "owner", "active");
    const pending = createRuntimeDeviceAuthorization(db, registrationRequest, {
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    expectRuntimeDeviceError(
      () =>
        exchangeRuntimeDeviceAuthorization(db, {
          deviceCode: pending.deviceCode,
          polledAt: "2026-07-13T00:00:01.000Z",
        }),
      "authorization_pending",
    );
    expectRuntimeDeviceError(
      () =>
        exchangeRuntimeDeviceAuthorization(db, {
          deviceCode: pending.deviceCode,
          polledAt: "2026-07-13T00:00:02.000Z",
        }),
      "slow_down",
    );
    expectRuntimeDeviceError(
      () =>
        exchangeRuntimeDeviceAuthorization(db, {
          deviceCode: pending.deviceCode,
          polledAt: "2026-07-13T00:10:00.000Z",
        }),
      "expired_token",
    );

    const denied = createRuntimeDeviceAuthorization(
      db,
      { ...registrationRequest, installationId: "install-denied" },
      { createdAt: "2026-07-13T00:00:00.000Z" },
    );
    expect(
      denyRuntimeDeviceAuthorization(db, {
        userCode: denied.userCode,
        deniedByUserId: "usr_owner",
        deniedAt: "2026-07-13T00:01:00.000Z",
      }).status,
    ).toBe("denied");
    expectRuntimeDeviceError(
      () =>
        exchangeRuntimeDeviceAuthorization(db, {
          deviceCode: denied.deviceCode,
          polledAt: "2026-07-13T00:01:05.000Z",
        }),
      "access_denied",
    );
    db.close();
  });

  it("exchanges an approved device authorization exactly once", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertUser(db, "usr_owner", "owner", "active");
    const authorization = createRuntimeDeviceAuthorization(db, registrationRequest, {
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    approveRuntimeDeviceAuthorization(db, {
      userCode: authorization.userCode,
      approvedByUserId: "usr_owner",
      approvedAt: "2026-07-13T00:01:00.000Z",
    });

    const registered = exchangeRuntimeDeviceAuthorization(db, {
      deviceCode: authorization.deviceCode,
      polledAt: "2026-07-13T00:01:05.000Z",
    });

    expect(registered).toMatchObject({
      runtimeId: expect.stringMatching(/^rt_/),
      runtimeToken: expect.stringMatching(/^spark_rt_/),
      refreshToken: expect.stringMatching(/^spark_rt_refresh_/),
    });
    expect(registered.workspaceBinding).toBeUndefined();
    const scopes = db
      .prepare(
        `SELECT scopes_json AS scopesJson
         FROM runtime_tokens
         WHERE runtime_id = ?
         ORDER BY label`,
      )
      .all(registered.runtimeId) as Array<{ scopesJson: string }>;
    expect(scopes.map((row) => JSON.parse(row.scopesJson))).toEqual([
      ["runtime:connect"],
      ["runtime:refresh"],
    ]);
    expect(
      getRuntimeDeviceAuthorizationForApproval(db, {
        userCode: authorization.userCode,
        currentUserId: "usr_owner",
        now: "2026-07-13T00:01:06.000Z",
      }).status,
    ).toBe("consumed");
    expectRuntimeDeviceError(
      () =>
        exchangeRuntimeDeviceAuthorization(db, {
          deviceCode: authorization.deviceCode,
          polledAt: "2026-07-13T00:01:06.000Z",
        }),
      "invalid_grant",
    );
    db.close();
  });

  it("requires a new token even after browser-approved daemon login", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertUser(db, "usr_owner", "owner", "active");
    const authorization = createRuntimeDeviceAuthorization(db, registrationRequest);
    approveRuntimeDeviceAuthorization(db, {
      userCode: authorization.userCode,
      approvedByUserId: "usr_owner",
    });
    const registered = exchangeRuntimeDeviceAuthorization(db, {
      deviceCode: authorization.deviceCode,
    });

    expect(() =>
      registerRuntimeWorkspace(
        db,
        registered.runtimeId,
        {
          registrationToken: "",
          workspaceRegistration: {
            localWorkspaceKey: "spore",
            displayName: "Spore",
            workspaceSlug: "spore",
          },
        },
        registered.runtimeToken,
      ),
    ).toThrow(/registration token is required/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_workspace_bindings").get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it("uses a fresh workspace token instead of broad runtime scope", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db);
    const registered = registerRuntime(db, registrationRequest, enrollment.refreshToken);
    const additionalGrant = createRuntimeEnrollmentToken(db, {
      workspaceName: "Spore",
      workspaceSlug: "spore",
    });
    const request = {
      registrationToken: additionalGrant.refreshToken,
      workspaceRegistration: {
        localWorkspaceKey: "spore",
        displayName: "Spore",
      },
    };

    const workspace = registerRuntimeWorkspace(
      db,
      registered.runtimeId,
      request,
      registered.runtimeToken,
    );
    expect(workspace.workspaceBinding.localWorkspaceKey).toBe("spore");
    expect(workspace.workspaceAuthorization.oneTimeToken).toMatch(/^spark_workspace_auth_/);
    db.close();
  });

  it("does not add workspace registration scope when device credentials refresh", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertUser(db, "usr_owner", "owner", "active");
    const authorization = createRuntimeDeviceAuthorization(db, registrationRequest);
    approveRuntimeDeviceAuthorization(db, {
      userCode: authorization.userCode,
      approvedByUserId: "usr_owner",
    });
    const registered = exchangeRuntimeDeviceAuthorization(db, {
      deviceCode: authorization.deviceCode,
    });
    const refreshed = refreshRuntimeToken(db, {
      runtimeId: registered.runtimeId,
      refreshToken: registered.refreshToken,
    });
    const workspaceGrant = createRuntimeEnrollmentToken(db, {
      workspaceName: "Spore after refresh",
      workspaceSlug: "spore-after-refresh",
    });

    const workspace = registerRuntimeWorkspace(
      db,
      registered.runtimeId,
      {
        registrationToken: workspaceGrant.refreshToken,
        workspaceRegistration: {
          localWorkspaceKey: "spore-after-refresh",
          displayName: "Spore after refresh",
          workspaceSlug: "spore-after-refresh",
        },
      },
      refreshed.runtimeToken,
    );

    expect(workspace.workspaceBinding).toMatchObject({
      localWorkspaceKey: "spore-after-refresh",
      displayName: "Spore after refresh",
      status: "available",
    });
    const activeScopes = db
      .prepare(
        `SELECT scopes_json AS scopesJson
         FROM runtime_tokens
         WHERE runtime_id = ? AND revoked_at IS NULL
         ORDER BY label`,
      )
      .all(registered.runtimeId) as Array<{ scopesJson: string }>;
    expect(activeScopes.map((row) => JSON.parse(row.scopesJson))).toEqual([
      ["runtime:connect"],
      ["runtime:refresh"],
    ]);
    db.close();
  });
});

function expectWorkspaceOwnerConflict(action: () => unknown): RuntimeWorkspaceLeaseConflictError {
  try {
    action();
  } catch (error) {
    // Throws deprecated RuntimeWorkspaceOwnerConflictError subclass; reasonCode is WORKSPACE_LEASE_CONFLICT.
    expect(error).toBeInstanceOf(RuntimeWorkspaceLeaseConflictError);
    expect(error).toBeInstanceOf(RuntimeWorkspaceOwnerConflictError);
    const conflict = error as RuntimeWorkspaceLeaseConflictError;
    expect(conflict.reasonCode).toBe("WORKSPACE_LEASE_CONFLICT");
    expect(conflict.aliasReasonCode).toBe("WORKSPACE_OWNER_CONFLICT");
    return conflict;
  }
  throw new Error("Expected WORKSPACE_LEASE_CONFLICT.");
}

function insertPendingCommandDelivery(
  db: ReturnType<typeof openMemoryDatabase>,
  workspaceId: string,
  bindingId: string,
): void {
  const now = "2026-07-15T00:00:00.000Z";
  db.prepare(
    `INSERT INTO commands
      (id, workspace_id, kind, payload_json, status, created_at, updated_at)
     VALUES ('cmd_owner_guard', ?, 'session.send', '{}', 'queued', ?, ?)`,
  ).run(workspaceId, now, now);
  db.prepare(
    `INSERT INTO command_deliveries
      (id, command_id, runtime_workspace_binding_id, status, attempt_count, created_at, updated_at)
     VALUES ('delivery_owner_guard', 'cmd_owner_guard', ?, 'pending', 0, ?, ?)`,
  ).run(bindingId, now, now);
}

function ownerBindingState(
  db: ReturnType<typeof openMemoryDatabase>,
  workspaceId: string,
): { id: string; bindingId: string; startedAt: string; endedAt: string | null } | undefined {
  return db
    .prepare(
      `SELECT id, runtime_workspace_binding_id AS bindingId,
              started_at AS startedAt, ended_at AS endedAt
       FROM workspace_leases
       WHERE workspace_id = ?`,
    )
    .get(workspaceId) as
    | { id: string; bindingId: string; startedAt: string; endedAt: string | null }
    | undefined;
}

function pendingDeliveryState(
  db: ReturnType<typeof openMemoryDatabase>,
): { bindingId: string; status: string; attemptCount: number } | undefined {
  return db
    .prepare(
      `SELECT runtime_workspace_binding_id AS bindingId, status, attempt_count AS attemptCount
       FROM command_deliveries
       WHERE id = 'delivery_owner_guard'`,
    )
    .get() as { bindingId: string; status: string; attemptCount: number } | undefined;
}

function enrollmentConsumption(db: ReturnType<typeof openMemoryDatabase>, tokenId: string) {
  return db
    .prepare("SELECT used_at AS usedAt FROM runtime_enrollment_tokens WHERE id = ?")
    .get(tokenId);
}

interface RaceMessage {
  ready?: true;
  ok?: boolean;
  reasonCode?: string;
}

interface RaceChild {
  process: ChildProcess;
  stderr: string[];
}

function startRaceChild(): RaceChild {
  const child = spawn(
    fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url)),
    [fileURLToPath(new URL("./runtime-registration-race-child.ts", import.meta.url))],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
  return { process: child, stderr };
}

function waitForRaceMessage(child: RaceChild, field: "ready"): Promise<RaceMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: RaceMessage) => {
      if (!(field in message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Owner race child exited before ${field} with code ${String(code)}.${raceChildStderr(child)}`,
        ),
      );
    };
    const cleanup = () => {
      child.process.off("message", onMessage);
      child.process.off("error", onError);
      child.process.off("exit", onExit);
    };
    child.process.on("message", onMessage);
    child.process.once("error", onError);
    child.process.once("exit", onExit);
  });
}

function waitForRaceResult(child: RaceChild): Promise<RaceMessage> {
  return new Promise((resolve, reject) => {
    let outcome: RaceMessage | undefined;
    const onMessage = (message: RaceMessage) => {
      if (!("ok" in message)) return;
      outcome = message;
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (code !== 0) {
        reject(
          new Error(
            `Owner race child exited with code ${String(code)} and signal ${String(signal)}.${raceChildStderr(child)}`,
          ),
        );
        return;
      }
      if (!outcome) {
        reject(
          new Error(`Owner race child exited without a result message.${raceChildStderr(child)}`),
        );
        return;
      }
      resolve(outcome);
    };
    const cleanup = () => {
      child.process.off("message", onMessage);
      child.process.off("error", onError);
      child.process.off("close", onClose);
    };
    child.process.on("message", onMessage);
    child.process.once("error", onError);
    child.process.once("close", onClose);
  });
}

function raceChildStderr(child: RaceChild): string {
  const stderr = child.stderr.join("").trim();
  return stderr ? ` stderr: ${stderr}` : "";
}

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

function expectRuntimeDeviceError(action: () => unknown, reasonCode: string) {
  try {
    action();
  } catch (caught) {
    expect(caught).toBeInstanceOf(RuntimeDeviceAuthorizationError);
    expect((caught as RuntimeDeviceAuthorizationError).reasonCode).toBe(reasonCode);
    return;
  }

  throw new Error(`Expected RuntimeDeviceAuthorizationError ${reasonCode}`);
}

function insertUser(
  db: ReturnType<typeof openMemoryDatabase>,
  id: string,
  role: "owner" | "member",
  status: "active" | "disabled",
) {
  db.prepare(
    `INSERT INTO users
      (id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?)`,
  ).run(id, id, role, status, "2026-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z");
}

function hash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
