import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { resolveNaviaPaths } from "@zendev-lab/navia-system";
import { handleLocalRpcLine } from "./local-rpc.js";
import { openSparkDaemonDatabase } from "./store/schema.js";
import { listWorkspaces } from "./store/workspaces.js";

describe("Spark daemon local RPC", () => {
  it("commits workspace registration only after server grant and websocket verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
    const workspacePath = join(root, "workspace");
    const paths = resolveNaviaPaths({
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
      mkdirSync(workspacePath);
      const ensureRegistration = vi.fn(async () => ({
        config: {
          installationId: "install-test",
          displayName: "Test Spark daemon",
          serverUrl: "http://127.0.0.1:5173/",
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "navia_rt_token_00000000000000000000000000000000",
          refreshToken: "navia_rt_refresh_000000000000000000000000000000",
          webSocketUrl:
            "ws://127.0.0.1:5173/api/v1/runtime/runtimes/rt_11111111111141111111111111111111/ws",
        },
        workspaceBinding: {
          workspaceId: "ws_22222222222241112222222222222222",
          bindingId: "rtwb_33333333333341113333333333333333",
          localWorkspaceKey: "spore",
          displayName: "Spore",
          status: "indexing" as const,
        },
      }));
      const verifyConnection = vi.fn(async () => {
        expect(listWorkspaces(db)).toHaveLength(0);
      });

      const response = await handleLocalRpcLine(
        JSON.stringify({
          id: "rpc_register",
          method: "workspace.register",
          params: {
            serverUrl: "http://127.0.0.1:5173/",
            localPath: workspacePath,
            displayName: "Spore",
            registrationToken: "navia_wsreg_local_rpc",
          },
        }),
        paths,
        db,
        undefined,
        {
          ensureSparkDaemonRegistrationForWorkspace: ensureRegistration,
          verifySparkDaemonWorkspaceConnection: verifyConnection,
        },
      );

      expect(response).toMatchObject({
        id: "rpc_register",
        ok: true,
        result: {
          id: "rtwb_33333333333341113333333333333333",
          serverUrl: "http://127.0.0.1:5173/",
          localWorkspaceKey: "spore",
          displayName: "Spore",
          status: "indexing",
        },
      });
      expect(ensureRegistration).toHaveBeenCalledWith(
        paths,
        expect.objectContaining({
          serverUrl: "http://127.0.0.1:5173/",
          registrationToken: "navia_wsreg_local_rpc",
          workspaceRegistration: {
            localWorkspaceKey: "spore",
            displayName: "Spore",
          },
        }),
      );
      expect(verifyConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceBinding: expect.objectContaining({
            bindingId: "rtwb_33333333333341113333333333333333",
          }),
        }),
      );
      expect(
        db
          .prepare(
            `SELECT server_workspace_id AS serverWorkspaceId,
                    server_binding_id AS serverBindingId,
                    last_known_status AS lastKnownStatus
             FROM daemon_workspaces`,
          )
          .get(),
      ).toMatchObject({
        serverWorkspaceId: "ws_22222222222241112222222222222222",
        serverBindingId: "rtwb_33333333333341113333333333333333",
        lastKnownStatus: "indexing",
      });
      expect(JSON.stringify(listWorkspaces(db))).not.toContain("navia_wsreg_local_rpc");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back workspace registration when websocket verification fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
    const workspacePath = join(root, "workspace");
    const paths = resolveNaviaPaths({
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
      mkdirSync(workspacePath);
      const ensureRegistration = vi.fn(async () => ({
        config: {
          installationId: "install-test",
          displayName: "Test Spark daemon",
          serverUrl: "http://127.0.0.1:5173/",
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "navia_rt_token_00000000000000000000000000000000",
          refreshToken: "navia_rt_refresh_000000000000000000000000000000",
          webSocketUrl:
            "ws://127.0.0.1:5173/api/v1/runtime/runtimes/rt_11111111111141111111111111111111/ws",
        },
        workspaceBinding: {
          workspaceId: "ws_22222222222241112222222222222222",
          bindingId: "rtwb_33333333333341113333333333333333",
          localWorkspaceKey: "spore",
          displayName: "Spore",
          status: "indexing" as const,
        },
      }));

      const response = await handleLocalRpcLine(
        JSON.stringify({
          id: "rpc_register",
          method: "workspace.register",
          params: {
            serverUrl: "http://127.0.0.1:5173/",
            localPath: workspacePath,
            displayName: "Spore",
            registrationToken: "navia_wsreg_local_rpc",
          },
        }),
        paths,
        db,
        undefined,
        {
          ensureSparkDaemonRegistrationForWorkspace: ensureRegistration,
          verifySparkDaemonWorkspaceConnection: vi.fn(async () => {
            throw new Error("hello ack failed");
          }),
        },
      );

      expect(response).toMatchObject({
        id: "rpc_register",
        ok: false,
        error: { message: "hello ack failed" },
      });
      expect(listWorkspaces(db)).toHaveLength(0);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM daemon_workspace_grants").get(),
      ).toMatchObject({ count: 0 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles daemon-local turn queue submit/list/status over local RPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
    const paths = resolveNaviaPaths({
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
      const submitted = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_submit",
          method: "turn.submit",
          params: { sessionId: "session-a", prompt: "continue work" },
        }),
        paths,
        db,
        undefined,
      );
      expect(submitted).toMatchObject({
        id: "turn_submit",
        ok: true,
        result: {
          task: {
            type: "session.run",
            sessionId: "session-a",
            prompt: "continue work",
            actor: "spark-daemon-local-rpc",
          },
        },
      });

      const status = await handleLocalRpcLine(
        JSON.stringify({ id: "daemon_status", method: "daemon.status" }),
        paths,
        db,
        undefined,
      );
      expect(status).toMatchObject({
        id: "daemon_status",
        ok: true,
        result: { queue: { inbox: 1, processed: 0, failed: 0 } },
      });

      const listed = await handleLocalRpcLine(
        JSON.stringify({
          id: "queue_list",
          method: "daemon.queue",
          params: { state: "inbox" },
        }),
        paths,
        db,
        undefined,
      );
      expect(listed).toMatchObject({
        id: "queue_list",
        ok: true,
        result: {
          state: "inbox",
          entries: [
            {
              payload: {
                task: { type: "session.run", sessionId: "session-a", prompt: "continue work" },
              },
            },
          ],
        },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attaches, heartbeats, and releases workspace clients over local RPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
    const paths = resolveNaviaPaths({
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
      const workspacePath = join(root, "workspace");
      mkdirSync(workspacePath);
      db.prepare(
        `INSERT INTO workspaces
          (id, server_url, local_workspace_key, display_name, local_path, status, capabilities_json, diagnostics_json, created_at, updated_at)
         VALUES ('rtwb_test', '', 'workspace', 'Workspace', ?, 'available', '{}', '{}', ?, ?)`,
      ).run(workspacePath, "2026-05-26T00:00:00.000Z", "2026-05-26T00:00:00.000Z");

      const attached = await handleLocalRpcLine(
        JSON.stringify({
          id: "client_attach",
          method: "workspace.client.attach",
          params: {
            workspaceId: "rtwb_test",
            clientId: "wcl-rpc-tui",
            kind: "interactive",
            displayName: "Spark TUI",
            leaseTtlMs: 60_000,
          },
        }),
        paths,
        db,
        undefined,
      );
      expect(attached).toMatchObject({
        id: "client_attach",
        ok: true,
        result: {
          client: { id: "wcl-rpc-tui", kind: "interactive", status: "connected" },
          workspace: {
            id: "rtwb_test",
            borrowed: { borrowed: true, interactiveClientCount: 1 },
          },
        },
      });

      const heartbeat = await handleLocalRpcLine(
        JSON.stringify({
          id: "client_heartbeat",
          method: "workspace.client.heartbeat",
          params: { clientId: "wcl-rpc-tui", leaseTtlMs: 60_000 },
        }),
        paths,
        db,
        undefined,
      );
      expect(heartbeat).toMatchObject({ ok: true, result: { client: { status: "connected" } } });

      const released = await handleLocalRpcLine(
        JSON.stringify({
          id: "client_release",
          method: "workspace.client.release",
          params: { clientId: "wcl-rpc-tui" },
        }),
        paths,
        db,
        undefined,
      );
      expect(released).toMatchObject({
        ok: true,
        result: {
          client: { status: "disconnected" },
          workspace: { borrowed: { borrowed: false, interactiveClientCount: 0 } },
        },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ensures and reuses an executor client over local RPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
    const paths = resolveNaviaPaths({
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
      const workspacePath = join(root, "workspace");
      mkdirSync(workspacePath);
      db.prepare(
        `INSERT INTO workspaces
          (id, server_url, local_workspace_key, display_name, local_path, status, capabilities_json, diagnostics_json, created_at, updated_at)
         VALUES ('rtwb_executor', '', 'workspace', 'Workspace', ?, 'available', '{}', '{}', ?, ?)`,
      ).run(workspacePath, "2026-05-26T00:00:00.000Z", "2026-05-26T00:00:00.000Z");

      const first = await handleLocalRpcLine(
        JSON.stringify({
          id: "executor_ensure_1",
          method: "workspace.executor.ensure",
          params: {
            workspaceId: "rtwb_executor",
            clientId: "exec-rpc-1",
            metadata: { activeAgentCount: 4 },
          },
        }),
        paths,
        db,
        undefined,
      );
      const second = await handleLocalRpcLine(
        JSON.stringify({
          id: "executor_ensure_2",
          method: "workspace.executor.ensure",
          params: { workspaceId: "rtwb_executor", clientId: "exec-rpc-2" },
        }),
        paths,
        db,
        undefined,
      );

      expect(first).toMatchObject({
        ok: true,
        result: {
          client: { id: "exec-rpc-1", kind: "executor", status: "connected" },
          workspace: { executor: { state: "online", clientId: "exec-rpc-1" } },
        },
      });
      expect(second).toMatchObject({
        ok: true,
        result: {
          client: { id: "exec-rpc-1", kind: "executor", status: "connected" },
          workspace: { executor: { state: "online", clientId: "exec-rpc-1" } },
        },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requests daemon shutdown over the local socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
    const paths = resolveNaviaPaths({
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
    const onStop = vi.fn();

    try {
      const response = await handleLocalRpcLine(
        JSON.stringify({ id: "local_test", method: "daemon.stop" }),
        paths,
        db,
        onStop,
      );
      expect(response).toMatchObject({
        id: "local_test",
        ok: true,
        result: {
          stopping: true,
          observedAt: expect.any(String),
        },
      });
      await delay(10);

      expect(onStop).toHaveBeenCalledOnce();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
