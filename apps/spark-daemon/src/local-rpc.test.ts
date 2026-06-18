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
