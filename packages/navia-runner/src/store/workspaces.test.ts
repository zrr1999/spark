import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNaviaPaths } from "@navia-dev/system";
import { openRunnerDatabase } from "./schema.js";
import {
  addWorkspace,
  attachWorkspace,
  listWorkspaces,
  markRunnerServerConnected,
  markServerWorkspacesDisconnected,
  planWorkspaceRegistration,
  reconcileWorkspaces,
  registerWorkspace,
  runnerServerStatusSummaries,
  stopWorkspace,
  workspaceKeyForName,
  workspaceKeyForPath,
  workspaceSummaries,
} from "./workspaces.js";

describe("runner workspace store", () => {
  it("stores workspace bindings in runner SQLite", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const workspace = addWorkspace(db, {
        localWorkspaceKey: "local-default",
        displayName: "Local default",
        localPath: root,
      });
      const updated = addWorkspace(db, {
        localWorkspaceKey: "local-default",
        displayName: "Local default renamed",
        localPath: root,
      });

      expect(updated.id).toBe(workspace.id);
      expect(listWorkspaces(db)).toHaveLength(1);
      expect(workspaceSummaries(db)).toEqual([
        {
          bindingId: workspace.id,
          localWorkspaceKey: "local-default",
          displayName: "Local default renamed",
          status: "available",
          capabilities: {},
          diagnostics: {},
        },
      ]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects recent local invocation sessions onto workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const workspace = addWorkspace(db, {
        localWorkspaceKey: "local-default",
        displayName: "Local default",
        localPath: root,
      });
      db.prepare(
        `INSERT INTO invocations
          (id, command_id, workspace_binding_id, status, prompt, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "inv_old",
        "cmd_old",
        workspace.id,
        "failed",
        "old",
        "2026-05-26T00:00:00.000Z",
        "2026-05-26T00:01:00.000Z",
        "inv_new",
        "cmd_new",
        workspace.id,
        "succeeded",
        "new",
        "2026-05-26T00:02:00.000Z",
        "2026-05-26T00:03:00.000Z",
      );

      expect(listWorkspaces(db)[0]).toMatchObject({
        sessionCount: 2,
        lastSessionAt: "2026-05-26T00:03:00.000Z",
        recentSessions: [
          {
            id: "inv_new",
            project: "workspace",
            model: "pi",
            lastActivityAt: "2026-05-26T00:03:00.000Z",
            state: "succeeded",
          },
          {
            id: "inv_old",
            state: "failed",
          },
        ],
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles missing paths without deleting workspace bindings", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const missingPath = join(root, "missing-workspace");
      const workspace = addWorkspace(db, {
        localWorkspaceKey: "missing",
        displayName: "Missing workspace",
        localPath: missingPath,
      });

      const reconciled = reconcileWorkspaces(db, "2026-05-25T00:00:00.000Z");

      expect(reconciled).toEqual([
        expect.objectContaining({
          id: workspace.id,
          localWorkspaceKey: "missing",
          status: "unavailable",
          diagnostics: expect.objectContaining({ pathMissing: true, localPath: missingPath }),
        }),
      ]);
      expect(workspaceSummaries(db)).toEqual([
        expect.objectContaining({
          bindingId: workspace.id,
          localWorkspaceKey: "missing",
          status: "unavailable",
        }),
      ]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks stopped workspaces as user-detached until they are attached again", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const workspace = registerWorkspace(db, {
        localPath: root,
        displayName: "Local default",
      });

      const stopped = stopWorkspace(db, {
        id: workspace.id,
        now: "2026-05-26T00:00:00.000Z",
      });

      expect(stopped).toMatchObject({
        id: workspace.id,
        status: "unavailable",
        diagnostics: {
          userDetached: true,
          detachedAt: "2026-05-26T00:00:00.000Z",
          reason: "user_stop",
        },
      });
      expect(reconcileWorkspaces(db, "2026-05-26T00:01:00.000Z")[0]).toMatchObject({
        id: workspace.id,
        status: "unavailable",
        diagnostics: expect.objectContaining({ userDetached: true }),
      });
      expect(workspaceSummaries(db)[0]).toMatchObject({
        bindingId: workspace.id,
        status: "unavailable",
        diagnostics: expect.objectContaining({ userDetached: true }),
      });

      const attachedAgain = attachWorkspace(db, { id: workspace.id });

      expect(attachedAgain).toMatchObject({
        id: workspace.id,
        status: "available",
        diagnostics: {},
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops one workspace without affecting another workspace on the same server", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const firstPath = join(root, "first");
      const secondPath = join(root, "second");
      mkdirSync(firstPath);
      mkdirSync(secondPath);
      const first = registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        localPath: firstPath,
        displayName: "First",
      });
      const second = registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        localPath: secondPath,
        displayName: "Second",
      });

      stopWorkspace(db, { id: first.id, now: "2026-05-26T00:00:00.000Z" });

      expect(listWorkspaces(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.id,
            status: "unavailable",
            diagnostics: expect.objectContaining({ userDetached: true }),
          }),
          expect.objectContaining({
            id: second.id,
            status: "available",
            diagnostics: {},
          }),
        ]),
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate local paths under different workspace keys", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      addWorkspace(db, {
        localWorkspaceKey: "one",
        localPath: root,
      });

      expect(() =>
        addWorkspace(db, {
          localWorkspaceKey: "two",
          localPath: root,
        }),
      ).toThrow(/already bound as one/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows the same local path and slug on different servers", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const first = addWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        localWorkspaceKey: "navia",
        displayName: "navia",
        localPath: root,
      });
      const second = addWorkspace(db, {
        serverUrl: "https://navia.example.com/",
        localWorkspaceKey: "navia",
        displayName: "navia",
        localPath: root,
      });

      expect(second.id).not.toBe(first.id);
      expect(listWorkspaces(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            serverUrl: "http://127.0.0.1:5173/",
            localWorkspaceKey: "navia",
            localPath: realpathSync(root),
          }),
          expect.objectContaining({
            serverUrl: "https://navia.example.com/",
            localWorkspaceKey: "navia",
            localPath: realpathSync(root),
          }),
        ]),
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects registering the same local path on the same server again", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        localPath: root,
        displayName: "navia",
      });

      expect(() =>
        registerWorkspace(db, {
          serverUrl: "http://127.0.0.1:5173/",
          localPath: root,
          displayName: "navia-again",
        }),
      ).toThrow(/already registered as navia/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects moving an existing workspace key to a different path", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });

      addWorkspace(db, {
        localWorkspaceKey: "stable",
        localPath: first,
      });

      expect(() =>
        addWorkspace(db, {
          localWorkspaceKey: "stable",
          localPath: second,
        }),
      ).toThrow(/Workspace key stable is already registered/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects nested workspace paths", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const parent = join(root, "parent");
      const child = join(parent, "child");
      const sibling = join(root, "sibling");
      mkdirSync(child, { recursive: true });
      mkdirSync(sibling, { recursive: true });

      addWorkspace(db, {
        localWorkspaceKey: "parent",
        localPath: parent,
      });

      expect(() =>
        addWorkspace(db, {
          serverUrl: "https://navia.example.com/",
          localWorkspaceKey: "child",
          localPath: child,
        }),
      ).toThrow(/cannot be nested with registered workspace parent/);

      expect(() =>
        addWorkspace(db, {
          localWorkspaceKey: "ancestor",
          localPath: root,
        }),
      ).toThrow(/cannot be nested with registered workspace parent/);

      expect(() =>
        addWorkspace(db, {
          localWorkspaceKey: "sibling",
          localPath: sibling,
        }),
      ).not.toThrow();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preflights workspace registration constraints without writing rows", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const parent = join(root, "parent");
      const child = join(parent, "child");
      const sibling = join(root, "sibling");
      mkdirSync(child, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        localPath: parent,
        displayName: "Parent",
      });

      expect(() =>
        planWorkspaceRegistration(db, {
          serverUrl: "http://127.0.0.1:5173/",
          localPath: child,
          displayName: "Child",
        }),
      ).toThrow(/cannot be nested with registered workspace parent/);
      expect(listWorkspaces(db)).toHaveLength(1);

      const planned = planWorkspaceRegistration(db, {
        serverUrl: "https://navia.example.com/",
        localPath: sibling,
        displayName: "Sibling",
      });
      expect(planned).toMatchObject({
        serverUrl: "https://navia.example.com/",
        localWorkspaceKey: "sibling",
        displayName: "Sibling",
      });
      expect(listWorkspaces(db)).toHaveLength(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores real paths and detects symlink collisions", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const realWorkspace = join(root, "real-workspace");
      const linkedWorkspace = join(root, "linked-workspace");
      mkdirSync(realWorkspace, { recursive: true });
      symlinkSync(realWorkspace, linkedWorkspace, "dir");
      const realWorkspacePath = realpathSync(realWorkspace);

      const workspace = registerWorkspace(db, {
        localPath: linkedWorkspace,
      });

      expect(workspace).toMatchObject({
        localWorkspaceKey: "real-workspace",
        displayName: "real-workspace",
        localPath: realWorkspacePath,
      });

      expect(() =>
        addWorkspace(db, {
          localWorkspaceKey: "second",
          localPath: realWorkspace,
        }),
      ).toThrow(/already bound as real-workspace/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers a workspace directory using a derived key and display name", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const workspace = registerWorkspace(db, {
        localPath: join(root, "My Workspace"),
      });

      expect(workspace).toMatchObject({
        localWorkspaceKey: "my-workspace",
        displayName: "My Workspace",
      });
      expect(workspaceKeyForName("Navia Dev")).toBe("navia-dev");
      expect(workspaceKeyForPath("/")).toBe("workspace");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the server workspace binding id when registering through the service", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const workspace = registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        localPath: join(root, "checkout"),
        displayName: "Navia Dev",
      });

      expect(workspace).toMatchObject({
        id: "rtwb_11111111111141111111111111111111",
        localWorkspaceKey: "navia-dev",
        displayName: "Navia Dev",
      });
      expect(workspaceSummaries(db)[0]?.bindingId).toBe("rtwb_11111111111141111111111111111111");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records workspace registration in the runner-local RFC tables", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath);
      const workspace = registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        serverWorkspaceId: "ws_11111111111141111111111111111111",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        localPath: workspacePath,
        displayName: "Navia Dev",
        consumedRegistrationToken: "navia_wsreg_secret",
        serverCredential: {
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "navia_rt_secret",
          refreshToken: "navia_rt_refresh_secret",
        },
        now: "2026-05-26T00:00:00.000Z",
      });

      const server = db.prepare("SELECT id, server_url AS serverUrl FROM runner_servers").get() as {
        id: string;
        serverUrl: string;
      };
      expect(server.serverUrl).toBe("http://127.0.0.1:5173/");

      const credential = db
        .prepare(
          `SELECT runtime_id AS runtimeId,
                  runtime_token_hash AS runtimeTokenHash,
                  refresh_token_hash AS refreshTokenHash
           FROM runner_server_credentials
           WHERE server_id = ?`,
        )
        .get(server.id) as {
        runtimeId: string;
        runtimeTokenHash: string;
        refreshTokenHash: string;
      };
      expect(credential).toMatchObject({
        runtimeId: "rt_11111111111141111111111111111111",
      });
      expect(credential.runtimeTokenHash).toMatch(/^sha256:/);
      expect(credential.runtimeTokenHash).not.toContain("navia_rt_secret");
      expect(credential.refreshTokenHash).toMatch(/^sha256:/);

      const runnerWorkspace = db
        .prepare(
          `SELECT id,
                  server_workspace_id AS serverWorkspaceId,
                  server_binding_id AS serverBindingId,
                  slug,
                  local_path AS localPath,
                  last_known_status AS lastKnownStatus
           FROM runner_workspaces
           WHERE id = ?`,
        )
        .get(workspace.id) as {
        id: string;
        serverWorkspaceId: string;
        serverBindingId: string;
        slug: string;
        localPath: string;
        lastKnownStatus: string;
      };
      expect(runnerWorkspace).toMatchObject({
        id: "rtwb_11111111111141111111111111111111",
        serverWorkspaceId: "ws_11111111111141111111111111111111",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        slug: "navia-dev",
        localPath: realpathSync(workspacePath),
        lastKnownStatus: "available",
      });

      const grant = db
        .prepare(
          `SELECT grant_token_hash AS grantTokenHash,
                  consumed_at AS consumedAt
           FROM runner_workspace_grants
           WHERE runner_workspace_id = ?`,
        )
        .get(workspace.id) as { grantTokenHash: string; consumedAt: string };
      expect(grant.grantTokenHash).toMatch(/^sha256:/);
      expect(grant.grantTokenHash).not.toContain("navia_wsreg_secret");
      expect(grant.consumedAt).toBe("2026-05-26T00:00:00.000Z");

      stopWorkspace(db, { id: workspace.id, now: "2026-05-26T00:01:00.000Z" });
      const stopped = db
        .prepare(
          `SELECT last_known_status AS lastKnownStatus,
                  last_known_offline_reason AS lastKnownOfflineReason
           FROM runner_workspaces
           WHERE id = ?`,
        )
        .get(workspace.id) as { lastKnownStatus: string; lastKnownOfflineReason: string };
      expect(stopped).toEqual({
        lastKnownStatus: "unavailable",
        lastKnownOfflineReason: "user-detached",
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back runner-local rows when registration metadata cannot be committed", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath);
      db.prepare(
        `INSERT INTO runner_servers
          (id, server_url, first_registered_at)
         VALUES (?, ?, ?)`,
      ).run("rnsrv_existing", "http://127.0.0.1:5173/", "2026-05-26T00:00:00.000Z");
      db.prepare(
        `INSERT INTO runner_workspaces
          (id, server_id, name, slug, local_path, registered_at, last_known_status, last_status_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "rtwb_duplicate",
        "rnsrv_existing",
        "Existing",
        "existing",
        join(root, "existing"),
        "2026-05-26T00:00:00.000Z",
        "available",
        "2026-05-26T00:00:00.000Z",
      );

      expect(() =>
        registerWorkspace(db, {
          serverUrl: "http://127.0.0.1:5173/",
          serverBindingId: "rtwb_duplicate",
          localPath: workspacePath,
          displayName: "Navia Dev",
          consumedRegistrationToken: "navia_wsreg_secret",
        }),
      ).toThrow();

      expect(listWorkspaces(db)).toHaveLength(0);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM runner_workspace_grants").get(),
      ).toMatchObject({ count: 0 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks connected and disconnected server state without overriding paused workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const firstPath = join(root, "first");
      const otherPath = join(root, "other");
      mkdirSync(firstPath);
      mkdirSync(otherPath);
      const first = registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        localPath: firstPath,
        displayName: "First",
      });
      const second = registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5174/",
        localPath: otherPath,
        displayName: "Second",
      });
      stopWorkspace(db, { id: second.id, now: "2026-05-26T00:00:00.000Z" });

      markRunnerServerConnected(db, "http://127.0.0.1:5173/", "2026-05-26T00:01:00.000Z");
      expect(runnerServerStatusSummaries(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://127.0.0.1:5173/",
            workspaceCount: 1,
            wsConnected: true,
            lastHeartbeatAt: "2026-05-26T00:01:00.000Z",
          }),
        ]),
      );

      markServerWorkspacesDisconnected(
        db,
        "http://127.0.0.1:5173/",
        "server.unreachable",
        "2026-05-26T00:02:00.000Z",
      );

      expect(listWorkspaces(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.id,
            status: "unavailable",
            diagnostics: expect.objectContaining({
              serverDisconnected: true,
              reason: "server.unreachable",
            }),
          }),
          expect.objectContaining({
            id: second.id,
            diagnostics: expect.objectContaining({
              userDetached: true,
            }),
          }),
        ]),
      );
      expect(runnerServerStatusSummaries(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://127.0.0.1:5173/",
            wsConnected: false,
            lastDisconnectReason: "server.unreachable",
          }),
        ]),
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the default workspace key from the display name", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const workspace = registerWorkspace(db, {
        localPath: join(root, "checkout"),
        displayName: "Navia Dev",
      });

      expect(workspace).toMatchObject({
        localWorkspaceKey: "navia-dev",
        displayName: "Navia Dev",
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores one-shot workspace profile metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-store-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openRunnerDatabase(paths);

    try {
      const workspace = registerWorkspace(db, {
        localPath: join(root, "checkout"),
        displayName: "Navia Dev",
        profile: {
          sourceKind: "git",
          ref: "./navia-profile",
          commit: "0123456789abcdef0123456789abcdef01234567",
          importedAt: "2026-05-26T00:00:00.000Z",
        },
      });

      expect(listWorkspaces(db)[0]).toMatchObject({
        id: workspace.id,
        profile: {
          sourceKind: "git",
          ref: "./navia-profile",
          commit: "0123456789abcdef0123456789abcdef01234567",
          importedAt: "2026-05-26T00:00:00.000Z",
        },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
