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
  RuntimeWorkspaceOwnerConflictError,
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
      displayName: "Local default",
      status: "available",
    });
    if (!workspaceBinding) {
      throw new Error("Expected workspace binding registration result.");
    }
    const workspace = db
      .prepare("SELECT id, slug, name FROM workspaces WHERE slug = ?")
      .get("spark-dev") as { id: string; slug: string; name: string };
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
      slug: "spark-dev",
      name: "Spark Dev",
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
           FROM workspace_owner_bindings
           WHERE workspace_id = ?`,
        )
        .all(firstBinding.workspaceId),
    ).toEqual([{ bindingId: firstBinding.bindingId, endedAt: null }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_workspace_bindings").get()).toEqual({
      count: 1,
    });
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
    conflictErrors.push(
      expectWorkspaceOwnerConflict(() =>
        registerRuntimeWorkspace(
          db,
          deviceRuntime.runtimeId,
          {
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
      "WORKSPACE_OWNER_CONFLICT",
      "WORKSPACE_OWNER_CONFLICT",
      "WORKSPACE_OWNER_CONFLICT",
    ]);
    expect(ownerBindingState(db, ownerBinding.workspaceId)).toEqual(originalOwner);
    expect(pendingDeliveryState(db)).toEqual(originalDelivery);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM workspace_owner_bindings WHERE ended_at IS NULL")
        .get(),
    ).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_owner_bindings").get()).toEqual({
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
         WHERE kind = 'workspace.owner_registration_conflict'
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
        kind: "workspace.owner_registration_conflict",
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
    db.close();

    try {
      const children = runtimes.map(() => startRaceChild());
      await Promise.all(children.map((child) => waitForRaceMessage(child, "ready")));
      const exits = children.map((child) => waitForRaceExit(child));
      const results = children.map((child) => waitForRaceMessage(child, "ok"));
      children.forEach((child, index) => {
        child.send({
          databasePath,
          runtimeId: runtimes[index]?.runtimeId,
          runtimeToken: runtimes[index]?.runtimeToken,
          localWorkspaceKey: `race-local-${index}`,
        });
      });
      const outcomes = await Promise.all(results);
      await Promise.all(exits);

      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
        { ok: false, reasonCode: "WORKSPACE_OWNER_CONFLICT" },
      ]);
      const verified = openDatabase({ path: databasePath });
      expect(
        verified
          .prepare("SELECT COUNT(*) AS count FROM workspace_owner_bindings WHERE ended_at IS NULL")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        verified.prepare("SELECT COUNT(*) AS count FROM workspace_owner_bindings").get(),
      ).toEqual({ count: 1 });
      expect(
        verified.prepare("SELECT COUNT(*) AS count FROM runtime_workspace_bindings").get(),
      ).toEqual({ count: 1 });
      expect(
        verified
          .prepare(
            "SELECT COUNT(*) AS count FROM events WHERE kind = 'workspace.owner_registration_conflict'",
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
      ["runtime:connect", "workspace:register"],
      ["runtime:refresh", "workspace:register"],
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

  it("lets a browser-approved daemon register another workspace without another token", () => {
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

    const workspace = registerRuntimeWorkspace(
      db,
      registered.runtimeId,
      {
        workspaceRegistration: {
          localWorkspaceKey: "spore",
          displayName: "Spore",
          workspaceSlug: "spore",
        },
      },
      registered.runtimeToken,
    );

    expect(workspace.workspaceBinding).toMatchObject({
      workspaceId: expect.stringMatching(/^ws_/),
      bindingId: expect.stringMatching(/^rtwb_/),
      localWorkspaceKey: "spore",
      displayName: "Spore",
      status: "available",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_workspace_bindings").get()).toEqual({
      count: 1,
    });
    db.close();
  });

  it("keeps workspace enrollment credentials workspace-bound", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db);
    const registered = registerRuntime(db, registrationRequest, enrollment.refreshToken);
    const request = {
      workspaceRegistration: {
        localWorkspaceKey: "spore",
        displayName: "Spore",
      },
    };

    expectRuntimeAccessError(
      db,
      registered.runtimeId,
      request,
      registered.runtimeToken,
      "RUNTIME_TOKEN_SCOPE_INVALID",
    );
    expectRuntimeAccessError(
      db,
      registered.runtimeId,
      request,
      registered.refreshToken,
      "RUNTIME_TOKEN_SCOPE_INVALID",
    );
    db.close();
  });

  it("preserves installation-wide workspace scope when device credentials refresh", () => {
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

    const workspace = registerRuntimeWorkspace(
      db,
      registered.runtimeId,
      {
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
      ["runtime:connect", "workspace:register"],
      ["runtime:refresh", "workspace:register"],
    ]);
    db.close();
  });
});

function expectWorkspaceOwnerConflict(action: () => unknown): RuntimeWorkspaceOwnerConflictError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeWorkspaceOwnerConflictError);
    const conflict = error as RuntimeWorkspaceOwnerConflictError;
    expect(conflict.reasonCode).toBe("WORKSPACE_OWNER_CONFLICT");
    return conflict;
  }
  throw new Error("Expected WORKSPACE_OWNER_CONFLICT.");
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

function ownerBindingState(db: ReturnType<typeof openMemoryDatabase>, workspaceId: string) {
  return db
    .prepare(
      `SELECT id, runtime_workspace_binding_id AS bindingId,
              started_at AS startedAt, ended_at AS endedAt
       FROM workspace_owner_bindings
       WHERE workspace_id = ?`,
    )
    .get(workspaceId);
}

function pendingDeliveryState(db: ReturnType<typeof openMemoryDatabase>) {
  return db
    .prepare(
      `SELECT runtime_workspace_binding_id AS bindingId, status, attempt_count AS attemptCount
       FROM command_deliveries
       WHERE id = 'delivery_owner_guard'`,
    )
    .get();
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

function startRaceChild(): ChildProcess {
  return spawn(
    fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url)),
    [fileURLToPath(new URL("./runtime-registration-race-child.ts", import.meta.url))],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
}

function waitForRaceMessage(child: ChildProcess, field: "ready" | "ok"): Promise<RaceMessage> {
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
      reject(new Error(`Owner race child exited before ${field} with code ${String(code)}.`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForRaceExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Owner race child exited with code ${String(code)}.`));
    });
  });
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
