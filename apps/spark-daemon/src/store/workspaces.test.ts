import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { openSparkDaemonDatabase } from "./schema.js";
import {
  addWorkspace,
  attachWorkspace,
  attachWorkspaceClient,
  ensureWorkspaceExecutorClient,
  heartbeatWorkspaceClient,
  getWorkspaceById,
  isBorrowedWorkspace,
  listWorkspaceClients,
  listWorkspaces,
  markSparkDaemonServerConnected,
  markSparkDaemonServerDisconnected,
  planWorkspaceRegistration,
  reconcileWorkspaces,
  registerWorkspace,
  releaseWorkspaceClient,
  sparkDaemonServerStatusSummaries,
  stopWorkspace,
  workspaceKeyForName,
  workspaceKeyForPath,
  workspaceSummaries,
} from "./workspaces.js";

function withSparkDaemonWorkspaceStore<T>(
  run: (context: { db: ReturnType<typeof openSparkDaemonDatabase>; root: string }) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-store-"));
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const db = openSparkDaemonDatabase(paths);

  try {
    return run({ db, root });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Spark daemon workspace store", () => {
  it("stores workspace bindings in daemon SQLite", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
    });
  });

  it("projects recent local invocation sessions onto workspaces", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
    });
  });

  it("reconciles missing paths without deleting workspace bindings", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
    });
  });

  it("marks stopped workspaces as user-detached until they are attached again", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
    });
  });

  it("derives borrowed state from connected interactive workspace clients", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const workspace = registerWorkspace(db, {
        localPath: root,
        displayName: "Local default",
      });

      const first = attachWorkspaceClient(db, {
        workspaceId: workspace.id,
        clientId: "wcl-tui-1",
        kind: "interactive",
        displayName: "Spark TUI 1",
        now: "2026-05-26T00:00:00.000Z",
      });
      attachWorkspaceClient(db, {
        workspaceId: workspace.id,
        clientId: "wcl-tui-2",
        kind: "interactive",
        displayName: "Spark TUI 2",
        now: "2026-05-26T00:01:00.000Z",
      });
      attachWorkspaceClient(db, {
        workspaceId: workspace.id,
        clientId: "exec-local-1",
        kind: "executor",
        displayName: "Background executor",
        now: "2026-05-26T00:01:30.000Z",
      });

      expect(first.status).toBe("connected");
      expect(isBorrowedWorkspace(db, workspace.id)).toBe(true);
      expect(listWorkspaceClients(db, workspace.id)).toHaveLength(3);
      expect(getWorkspaceById(db, workspace.id)).toMatchObject({
        borrowed: {
          borrowed: true,
          interactiveClientCount: 2,
          borrowedByClientIds: expect.arrayContaining(["wcl-tui-1", "wcl-tui-2"]),
        },
        workspaceClients: expect.arrayContaining([
          expect.objectContaining({ clientId: "wcl-tui-1", kind: "interactive" }),
          expect.objectContaining({ clientId: "exec-local-1", kind: "executor" }),
        ]),
        executor: expect.objectContaining({ state: "online", clientId: "exec-local-1" }),
      });

      releaseWorkspaceClient(db, { clientId: "wcl-tui-1", now: "2026-05-26T00:02:00.000Z" });
      expect(getWorkspaceById(db, workspace.id)?.borrowed).toMatchObject({
        borrowed: true,
        interactiveClientCount: 1,
        borrowedByClientIds: ["wcl-tui-2"],
      });

      releaseWorkspaceClient(db, { clientId: "wcl-tui-2", now: "2026-05-26T00:03:00.000Z" });
      expect(getWorkspaceById(db, workspace.id)?.borrowed).toMatchObject({
        borrowed: false,
        interactiveClientCount: 0,
        borrowedByClientIds: [],
      });
    });
  });

  it("expires borrowed workspace clients by lease", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const workspace = registerWorkspace(db, {
        localPath: root,
        displayName: "Local default",
      });

      attachWorkspaceClient(db, {
        workspaceId: workspace.id,
        clientId: "wcl-tui-expiring",
        kind: "interactive",
        leaseTtlMs: 1_000,
        now: "2026-05-26T00:00:00.000Z",
      });
      expect(isBorrowedWorkspace(db, workspace.id, "2026-05-26T00:00:00.500Z")).toBe(true);

      heartbeatWorkspaceClient(db, {
        clientId: "wcl-tui-expiring",
        leaseTtlMs: 1_000,
        now: "2026-05-26T00:00:01.000Z",
      });
      expect(isBorrowedWorkspace(db, workspace.id, "2026-05-26T00:00:01.500Z")).toBe(true);
      expect(isBorrowedWorkspace(db, workspace.id, "2026-05-26T00:00:02.001Z")).toBe(false);
    });
  });

  it("ensures and reuses one executor client per workspace without busy backpressure", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const workspace = registerWorkspace(db, {
        localPath: root,
        displayName: "Local default",
      });
      const first = ensureWorkspaceExecutorClient(db, {
        workspaceId: workspace.id,
        clientId: "exec-local-1",
        now: "2026-05-26T00:00:00.000Z",
      });
      const reused = ensureWorkspaceExecutorClient(db, {
        workspaceId: workspace.id,
        clientId: "exec-local-2",
        now: "2026-05-26T00:01:00.000Z",
      });

      expect(reused.id).toBe(first.id);
      db.prepare(
        `INSERT INTO invocations
          (id, command_id, workspace_binding_id, status, prompt, created_at, updated_at)
         VALUES
          ('inv_running_1', NULL, ?, 'running', 'one', ?, ?),
          ('inv_running_2', NULL, ?, 'queued', 'two', ?, ?)`,
      ).run(
        workspace.id,
        "2026-05-26T00:02:00.000Z",
        "2026-05-26T00:02:00.000Z",
        workspace.id,
        "2026-05-26T00:02:00.000Z",
        "2026-05-26T00:02:00.000Z",
      );

      expect(getWorkspaceById(db, workspace.id)?.executor).toMatchObject({
        state: "online",
        clientId: "exec-local-1",
        activeInvocationCount: 2,
        activeAgentCount: 2,
      });
    });
  });

  it("keeps executor client ids bound to one workspace and projects unhealthy state", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const firstPath = join(root, "first");
      const secondPath = join(root, "second");
      mkdirSync(firstPath);
      mkdirSync(secondPath);
      const first = registerWorkspace(db, { localPath: firstPath, displayName: "First" });
      const second = registerWorkspace(db, { localPath: secondPath, displayName: "Second" });

      attachWorkspaceClient(db, {
        workspaceId: first.id,
        clientId: "exec-bound",
        kind: "executor",
        metadata: { state: "unhealthy", unhealthyReason: "heartbeat-missed", activeAgentCount: 3 },
        now: "2026-05-26T00:00:00.000Z",
      });

      expect(() =>
        attachWorkspaceClient(db, {
          workspaceId: second.id,
          clientId: "exec-bound",
          kind: "executor",
        }),
      ).toThrow(/already bound to workspace/);
      expect(getWorkspaceById(db, first.id)?.executor).toMatchObject({
        state: "unhealthy",
        unhealthyReason: "heartbeat-missed",
        activeAgentCount: 3,
      });
    });
  });

  it("stops one workspace without affecting another workspace on the same server", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
    });
  });

  it("rejects duplicate local paths under different workspace keys", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
    });
  });

  it("allows the same local path and slug on different servers", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const first = addWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        localWorkspaceKey: "spark",
        displayName: "spark",
        localPath: root,
      });
      const second = addWorkspace(db, {
        serverUrl: "https://spark.example.com/",
        localWorkspaceKey: "spark",
        displayName: "spark",
        localPath: root,
      });

      expect(second.id).not.toBe(first.id);
      expect(listWorkspaces(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            serverUrl: "http://127.0.0.1:5173/",
            localWorkspaceKey: "spark",
            localPath: realpathSync(root),
          }),
          expect.objectContaining({
            serverUrl: "https://spark.example.com/",
            localWorkspaceKey: "spark",
            localPath: realpathSync(root),
          }),
        ]),
      );
    });
  });

  it("rejects registering the same local path on the same server again", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        localPath: root,
        displayName: "spark",
      });

      expect(() =>
        registerWorkspace(db, {
          serverUrl: "http://127.0.0.1:5173/",
          localPath: root,
          displayName: "spark-again",
        }),
      ).toThrow(/already registered as spark/);
    });
  });

  it("rejects moving an existing workspace key to a different path", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
    });
  });

  it("rejects nested workspace paths", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
          serverUrl: "https://spark.example.com/",
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
    });
  });

  it("preflights workspace registration constraints without writing rows", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
        serverUrl: "https://spark.example.com/",
        localPath: sibling,
        displayName: "Sibling",
      });
      expect(planned).toMatchObject({
        serverUrl: "https://spark.example.com/",
        localWorkspaceKey: "sibling",
        displayName: "Sibling",
      });
      expect(listWorkspaces(db)).toHaveLength(1);
    });
  });

  it("stores real paths and detects symlink collisions", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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
    });
  });

  it("registers a workspace directory using a derived key and display name", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const workspace = registerWorkspace(db, {
        localPath: join(root, "My Workspace"),
      });

      expect(workspace).toMatchObject({
        localWorkspaceKey: "my-workspace",
        displayName: "My Workspace",
      });
      expect(workspaceKeyForName("Spark Dev")).toBe("spark-dev");
      expect(workspaceKeyForPath("/")).toBe("workspace");
    });
  });

  it("uses the server workspace binding id when registering through the service", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const workspace = registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        localPath: join(root, "checkout"),
        displayName: "Spark Dev",
      });

      expect(workspace).toMatchObject({
        id: "rtwb_11111111111141111111111111111111",
        localWorkspaceKey: "spark-dev",
        displayName: "Spark Dev",
      });
      expect(workspaceSummaries(db)[0]?.bindingId).toBe("rtwb_11111111111141111111111111111111");
    });
  });

  it("records workspace registration in the daemon-local RFC tables", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath);
      const workspace = registerWorkspace(db, {
        serverUrl: "http://127.0.0.1:5173/",
        serverWorkspaceId: "ws_11111111111141111111111111111111",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        localPath: workspacePath,
        displayName: "Spark Dev",
        consumedRegistrationToken: "spark_wsreg_secret",
        serverCredential: {
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "spark_rt_secret",
          refreshToken: "spark_rt_refresh_secret",
        },
        now: "2026-05-26T00:00:00.000Z",
      });

      const server = db.prepare("SELECT id, server_url AS serverUrl FROM daemon_servers").get() as {
        id: string;
        serverUrl: string;
      };
      expect(server.serverUrl).toBe("http://127.0.0.1:5173/");

      const credential = db
        .prepare(
          `SELECT runtime_id AS runtimeId,
                  runtime_token_hash AS runtimeTokenHash,
                  refresh_token_hash AS refreshTokenHash
           FROM daemon_server_credentials
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
      expect(credential.runtimeTokenHash).not.toContain("spark_rt_secret");
      expect(credential.refreshTokenHash).toMatch(/^sha256:/);

      const sparkDaemonWorkspace = db
        .prepare(
          `SELECT id,
                  server_workspace_id AS serverWorkspaceId,
                  server_binding_id AS serverBindingId,
                  slug,
                  local_path AS localPath,
                  last_known_status AS lastKnownStatus
           FROM daemon_workspaces
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
      expect(sparkDaemonWorkspace).toMatchObject({
        id: "rtwb_11111111111141111111111111111111",
        serverWorkspaceId: "ws_11111111111141111111111111111111",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        slug: "spark-dev",
        localPath: realpathSync(workspacePath),
        lastKnownStatus: "available",
      });

      const grant = db
        .prepare(
          `SELECT grant_token_hash AS grantTokenHash,
                  consumed_at AS consumedAt
           FROM daemon_workspace_grants
           WHERE daemon_workspace_id = ?`,
        )
        .get(workspace.id) as { grantTokenHash: string; consumedAt: string };
      expect(grant.grantTokenHash).toMatch(/^sha256:/);
      expect(grant.grantTokenHash).not.toContain("spark_wsreg_secret");
      expect(grant.consumedAt).toBe("2026-05-26T00:00:00.000Z");

      stopWorkspace(db, { id: workspace.id, now: "2026-05-26T00:01:00.000Z" });
      const stopped = db
        .prepare(
          `SELECT last_known_status AS lastKnownStatus,
                  last_known_offline_reason AS lastKnownOfflineReason
           FROM daemon_workspaces
           WHERE id = ?`,
        )
        .get(workspace.id) as { lastKnownStatus: string; lastKnownOfflineReason: string };
      expect(stopped).toEqual({
        lastKnownStatus: "unavailable",
        lastKnownOfflineReason: "user-detached",
      });
    });
  });

  it("rolls back daemon-local rows when registration metadata cannot be committed", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const workspacePath = join(root, "checkout");
      mkdirSync(workspacePath);
      db.prepare(
        `INSERT INTO daemon_servers
          (id, server_url, first_registered_at)
         VALUES (?, ?, ?)`,
      ).run("rnsrv_existing", "http://127.0.0.1:5173/", "2026-05-26T00:00:00.000Z");
      db.prepare(
        `INSERT INTO daemon_workspaces
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
          displayName: "Spark Dev",
          consumedRegistrationToken: "spark_wsreg_secret",
        }),
      ).toThrow();

      expect(listWorkspaces(db)).toHaveLength(0);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM daemon_workspace_grants").get(),
      ).toMatchObject({ count: 0 });
    });
  });

  it("keeps server projection connectivity separate from local workspace availability", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
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

      markSparkDaemonServerConnected(db, "http://127.0.0.1:5173/", "2026-05-26T00:01:00.000Z");
      expect(sparkDaemonServerStatusSummaries(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://127.0.0.1:5173/",
            workspaceCount: 1,
            wsConnected: true,
            lastHeartbeatAt: "2026-05-26T00:01:00.000Z",
          }),
        ]),
      );

      markSparkDaemonServerDisconnected(db, "http://127.0.0.1:5173/", "server.unreachable");

      expect(listWorkspaces(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.id,
            status: "available",
            diagnostics: {},
          }),
          expect.objectContaining({
            id: second.id,
            diagnostics: expect.objectContaining({
              userDetached: true,
            }),
          }),
        ]),
      );
      expect(sparkDaemonServerStatusSummaries(db)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://127.0.0.1:5173/",
            wsConnected: false,
            lastDisconnectReason: "server.unreachable",
          }),
        ]),
      );
      expect(
        db
          .prepare(
            `SELECT last_known_status AS lastKnownStatus,
                    last_known_offline_reason AS lastKnownOfflineReason
             FROM daemon_workspaces
             WHERE id = ?`,
          )
          .get(first.id),
      ).toEqual({
        lastKnownStatus: "available",
        lastKnownOfflineReason: null,
      });
    });
  });

  it("derives the default workspace key from the display name", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const workspace = registerWorkspace(db, {
        localPath: join(root, "checkout"),
        displayName: "Spark Dev",
      });

      expect(workspace).toMatchObject({
        localWorkspaceKey: "spark-dev",
        displayName: "Spark Dev",
      });
    });
  });

  it("stores one-shot workspace profile metadata", () => {
    withSparkDaemonWorkspaceStore(({ db, root }) => {
      const workspace = registerWorkspace(db, {
        localPath: join(root, "checkout"),
        displayName: "Spark Dev",
        profile: {
          sourceKind: "git",
          ref: "./spark-profile",
          commit: "0123456789abcdef0123456789abcdef01234567",
          importedAt: "2026-05-26T00:00:00.000Z",
        },
      });

      expect(listWorkspaces(db)[0]).toMatchObject({
        id: workspace.id,
        profile: {
          sourceKind: "git",
          ref: "./spark-profile",
          commit: "0123456789abcdef0123456789abcdef01234567",
          importedAt: "2026-05-26T00:00:00.000Z",
        },
      });
    });
  });
});
