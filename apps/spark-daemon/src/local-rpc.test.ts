import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { SparkDaemonInvocationRegistry, SparkDaemonQueue } from "./core/index.js";
import {
  createDaemonSessionRegistry,
  handleLocalRpcLine,
  requestWorkspaceEnsureLocal,
  startLocalRpcServer,
} from "./local-rpc.js";
import { openSparkDaemonDatabase } from "./store/schema.js";
import {
  ensureLocalWorkspace,
  listWorkspaces,
  resolveWorkspaceLocalPath,
  WorkspacePathConflictError,
} from "./store/workspaces.js";
import type { SparkDaemonModelControl } from "./model-control.ts";

describe("Spark daemon local RPC", () => {
  it("commits workspace registration only after server grant and websocket verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
    const workspacePath = join(root, "workspace");
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
      mkdirSync(workspacePath);
      const ensureRegistration = vi.fn(async () => ({
        config: {
          installationId: "install-test",
          displayName: "Test Spark daemon",
          serverUrl: "http://127.0.0.1:5173/",
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "spark_rt_token_00000000000000000000000000000000",
          refreshToken: "spark_rt_refresh_000000000000000000000000000000",
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
            registrationToken: "spark_wsreg_local_rpc",
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
          registrationToken: "spark_wsreg_local_rpc",
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
      expect(JSON.stringify(listWorkspaces(db))).not.toContain("spark_wsreg_local_rpc");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back workspace registration when websocket verification fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
    const workspacePath = join(root, "workspace");
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
      mkdirSync(workspacePath);
      const ensureRegistration = vi.fn(async () => ({
        config: {
          installationId: "install-test",
          displayName: "Test Spark daemon",
          serverUrl: "http://127.0.0.1:5173/",
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "spark_rt_token_00000000000000000000000000000000",
          refreshToken: "spark_rt_refresh_000000000000000000000000000000",
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
            registrationToken: "spark_wsreg_local_rpc",
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
      const assignment = {
        goal: "continue work",
        target: {
          sessionId: "session-a",
          role: "role:implementer",
          workspaceId: "ws-a",
        },
        constraints: ["keep the diff small"],
        evidence: ["queue contract"],
        source: { kind: "cli" },
        title: "Continue work",
      };
      const submitted = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_submit",
          method: "turn.submit",
          params: { sessionId: "session-a", prompt: "continue work", assignment },
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
            workspaceId: "ws-a",
            actor: "spark-daemon-local-rpc",
            assignment,
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
                task: {
                  type: "session.run",
                  sessionId: "session-a",
                  prompt: "continue work",
                  assignment,
                },
              },
            },
          ],
        },
      });

      const submittedFileName = (submitted as { result: { fileName: string } }).result.fileName;
      const queue = new SparkDaemonQueue({ paths });
      await queue.markProcessed(submittedFileName, {
        assistantText: "finished",
        stderr: "",
        jsonEvents: Array.from({ length: 500 }, (_, index) => ({
          type: "stream_event",
          text: `event-${index}`,
        })),
      });
      const exact = await handleLocalRpcLine(
        JSON.stringify({
          id: "queue_exact",
          method: "daemon.queue",
          params: { state: "all", fileName: submittedFileName },
        }),
        paths,
        db,
        undefined,
      );
      expect(exact).toMatchObject({
        id: "queue_exact",
        ok: true,
        result: {
          state: "all",
          byState: {
            inbox: [],
            failed: [],
            processed: [
              {
                fileName: submittedFileName,
                payload: {
                  result: {
                    assistantText: "finished",
                    stderr: "",
                    jsonEventCount: 500,
                  },
                },
              },
            ],
          },
        },
      });
      expect(JSON.stringify(exact)).not.toContain("jsonEvents");

      const invalid = await handleLocalRpcLine(
        JSON.stringify({
          id: "queue_invalid",
          method: "daemon.queue",
          params: { state: "all", fileName: "../secret.json" },
        }),
        paths,
        db,
        undefined,
      );
      expect(invalid).toMatchObject({
        id: "queue_invalid",
        ok: false,
        error: { message: "Invalid daemon queue file name." },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels active turn invocations over local RPC and reports misses", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-cancel-"));
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
    const invocations = new SparkDaemonInvocationRegistry();
    const handle = invocations.start({
      invocationId: "turn-file.json",
      kind: "session.run",
      sessionId: "session-a",
    });
    let aborted = false;
    handle.signal.addEventListener("abort", () => {
      aborted = true;
    });

    try {
      const mismatched = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_cancel_wrong_session",
          method: "turn.cancel",
          params: { invocationId: "turn-file.json", sessionId: "session-b" },
        }),
        paths,
        db,
        undefined,
        {},
        invocations,
      );
      expect(mismatched).toMatchObject({
        id: "turn_cancel_wrong_session",
        ok: false,
        error: { code: "turn_session_mismatch" },
      });
      expect(aborted).toBe(false);

      const cancelled = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_cancel",
          method: "turn.cancel",
          params: {
            invocationId: "turn-file.json",
            sessionId: "session-a",
            reason: "test cancel",
          },
        }),
        paths,
        db,
        undefined,
        {},
        invocations,
      );
      expect(cancelled).toMatchObject({
        id: "turn_cancel",
        ok: true,
        result: {
          invocationId: "turn-file.json",
          cancelled: true,
          outcome: "cancel-requested",
          message: "Cancellation requested for Spark daemon invocation turn-file.json.",
        },
      });
      expect(aborted).toBe(true);

      const missing = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_cancel_missing",
          method: "turn.cancel",
          params: { invocationId: "missing.json" },
        }),
        paths,
        db,
        undefined,
        {},
        invocations,
      );
      expect(missing).toMatchObject({
        id: "turn_cancel_missing",
        ok: true,
        result: {
          invocationId: "missing.json",
          cancelled: false,
          outcome: "not-found",
          message: "No queued or active Spark daemon invocation matched missing.json.",
        },
      });
    } finally {
      handle.finish();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dequeues pending turns and enforces their session ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-dequeue-"));
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
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "install-rpc-dequeue",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "session-b", scope: { kind: "daemon" } });
    await sessionRegistry.recordTurnQueued("session-b");
    const queue = new SparkDaemonQueue({ paths });
    const queued = await queue.enqueue({
      type: "session.run",
      sessionId: "session-b",
      prompt: "queued prompt",
    });

    try {
      const mismatched = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_dequeue_wrong_session",
          method: "turn.cancel",
          params: { invocationId: queued.fileName, sessionId: "session-a" },
        }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      );
      expect(mismatched).toMatchObject({
        id: "turn_dequeue_wrong_session",
        ok: false,
        error: { code: "turn_session_mismatch" },
      });
      await expect(queue.list("inbox")).resolves.toEqual([queued.fileName]);
      await expect(sessionRegistry.get("session-b")).resolves.toMatchObject({ status: "running" });

      const dequeued = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_dequeue",
          method: "turn.cancel",
          params: { invocationId: queued.fileName, sessionId: "session-b" },
        }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      );
      expect(dequeued).toMatchObject({
        id: "turn_dequeue",
        ok: true,
        result: {
          invocationId: queued.fileName,
          cancelled: true,
          outcome: "dequeued",
          message: `Removed queued Spark daemon invocation ${queued.fileName} from the queue.`,
        },
      });
      await expect(queue.list("inbox")).resolves.toEqual([]);
      await expect(sessionRegistry.get("session-b")).resolves.toMatchObject({ status: "ready" });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ensures implicit local workspaces idempotently before client attach", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
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
      const workspacePath = join(root, "workspace");
      mkdirSync(workspacePath);
      const first = await handleLocalRpcLine(
        JSON.stringify({
          id: "ensure_local_1",
          method: "workspace.ensure-local",
          params: { localPath: workspacePath },
        }),
        paths,
        db,
        undefined,
      );
      const second = await handleLocalRpcLine(
        JSON.stringify({
          id: "ensure_local_2",
          method: "workspace.ensure-local",
          params: { localPath: workspacePath },
        }),
        paths,
        db,
        undefined,
      );
      const firstResult = (first as { ok: true; result: { id: string; localPath: string } }).result;
      const workspaceId = firstResult.id;

      expect(first).toMatchObject({
        ok: true,
        result: { serverUrl: "", localPath: realpathSync(workspacePath), status: "available" },
      });
      expect(second).toMatchObject({ ok: true, result: { id: workspaceId } });

      await handleLocalRpcLine(
        JSON.stringify({
          id: "client_attach_1",
          method: "workspace.client.attach",
          params: { workspaceId, clientId: "wcl-tui-1", kind: "interactive" },
        }),
        paths,
        db,
        undefined,
      );
      const attached = await handleLocalRpcLine(
        JSON.stringify({
          id: "client_attach_2",
          method: "workspace.client.attach",
          params: { workspaceId, clientId: "wcl-tui-2", kind: "interactive" },
        }),
        paths,
        db,
        undefined,
      );
      expect(attached).toMatchObject({
        ok: true,
        result: { workspace: { id: workspaceId, borrowed: { interactiveClientCount: 2 } } },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves structured workspace conflict errors through the shared unary transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-client-"));
    const workspacePath = join(root, "workspace");
    const nestedPath = join(workspacePath, "nested");
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
    mkdirSync(nestedPath, { recursive: true });
    const server = await startLocalRpcServer({
      paths,
      sparkHome: join(root, ".spark"),
      db,
    });

    try {
      await requestWorkspaceEnsureLocal(paths, { localPath: workspacePath });
      await expect(
        requestWorkspaceEnsureLocal(paths, { localPath: nestedPath }),
      ).rejects.toBeInstanceOf(WorkspacePathConflictError);
    } finally {
      await server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attaches, heartbeats, and releases workspace clients over local RPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
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

  it("serves authoritative channel status and acknowledges configure/reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-channel-"));
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
    const runningStatus = {
      plane: "daemon" as const,
      resource: "channel" as const,
      workspaceId: "ws_demo",
      configPath: join(root, ".spark", "workspaces", "ws_demo", "channels", "config.json"),
      available: true as const,
      configured: true,
      ingressEnabled: true,
      state: "running" as const,
      adapters: [{ id: "feishu", type: "feishu", running: true, state: "connected" as const }],
      routes: [{ name: "ops", adapter: "feishu", recipient: "oc_ops" }],
      observedAt: "2026-07-10T00:00:00.000Z",
      text: "channels workspace=ws_demo running adapters=1/1 routes=1 ingress=on\n",
    };
    const channelIngress = {
      status: vi.fn(() => runningStatus),
      configure: vi.fn(async () => runningStatus),
      reload: vi.fn(async () => runningStatus),
      notify: vi.fn(async () => ({ action: "list" as const, adapters: [], routes: [] })),
    };

    try {
      const status = await handleLocalRpcLine(
        JSON.stringify({
          id: "channel_status",
          method: "channel.status",
          params: { workspaceId: "ws_demo" },
        }),
        paths,
        db,
        undefined,
        { channelIngress },
      );
      expect(status).toEqual({ id: "channel_status", ok: true, result: runningStatus });
      expect(channelIngress.status).toHaveBeenCalledWith("ws_demo");

      const config = {
        adapters: {
          feishu: {
            type: "feishu",
            event_mode: "websocket",
            app_id: "cli_demo",
            app_secret: "secret_demo",
          },
        },
        routes: { ops: { adapter: "feishu", recipient: "oc_ops" } },
        ingress: { enabled: true, on_unbound: "reject" },
      };
      const configured = await handleLocalRpcLine(
        JSON.stringify({
          id: "channel_configure",
          method: "channel.configure",
          params: { workspaceId: "ws_demo", config },
        }),
        paths,
        db,
        undefined,
        { channelIngress },
      );
      expect(configured).toEqual({ id: "channel_configure", ok: true, result: runningStatus });
      expect(channelIngress.configure).toHaveBeenCalledWith("ws_demo", config);

      const reloaded = await handleLocalRpcLine(
        JSON.stringify({
          id: "channel_reload",
          method: "channel.reload",
          params: { workspaceId: "ws_demo" },
        }),
        paths,
        db,
        undefined,
        { channelIngress },
      );
      expect(reloaded).toEqual({ id: "channel_reload", ok: true, result: runningStatus });
      expect(channelIngress.reload).toHaveBeenCalledWith("ws_demo");

      const invalidConfigure = await handleLocalRpcLine(
        JSON.stringify({
          id: "channel_configure_bad",
          method: "channel.configure",
          params: {
            workspaceId: "ws_demo",
            config: {
              adapters: {},
              routes: {},
              ingress: { enabled: true, on_unbound: "create_session" },
            },
          },
        }),
        paths,
        db,
        undefined,
        { channelIngress },
      );
      expect(invalidConfigure).toMatchObject({
        id: "channel_configure_bad",
        ok: false,
        error: { message: "ingress.on_unbound must be reject or create" },
      });
      expect(channelIngress.configure).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("owns managed session create/list/get/bind/unbind/archive behind local RPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-session-"));
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
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "install-rpc-session",
      daemonCwd: root,
    });
    const request = async (id: string, method: string, params?: unknown) =>
      await handleLocalRpcLine(
        JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      );

    try {
      const [first, second] = await Promise.all([
        request("session_create_a", "session.create", {
          sessionId: "sess_a",
          workspaceId: "ws_a",
          title: "First",
        }),
        request("session_create_b", "session.create", {
          sessionId: "sess_b",
          workspaceId: "ws_b",
        }),
      ]);
      expect(first).toMatchObject({ ok: true, result: { sessionId: "sess_a" } });
      expect(second).toMatchObject({ ok: true, result: { sessionId: "sess_b" } });

      const listed = await request("session_list", "session.list", {
        workspaceId: "ws_a",
      });
      expect(listed).toMatchObject({
        ok: true,
        result: [{ sessionId: "sess_a", workspaceId: "ws_a" }],
      });
      const fetched = await request("session_get", "session.get", { sessionId: "sess_a" });
      expect(fetched).toMatchObject({ ok: true, result: { title: "First" } });

      const bound = await request("session_bind", "session.bind", {
        sessionId: "sess_a",
        externalKey: "feishu:chat:oc_demo",
      });
      expect(bound).toMatchObject({
        ok: true,
        result: { bindings: [{ externalKey: "feishu:chat:oc_demo" }] },
      });
      const unbound = await request("session_unbind", "session.unbind", {
        sessionId: "sess_a",
        externalKey: "feishu:chat:oc_demo",
      });
      expect(unbound).toMatchObject({ ok: true, result: { bindings: [] } });
      const archived = await request("session_archive", "session.archive", {
        sessionId: "sess_a",
      });
      expect(archived).toMatchObject({ ok: true, result: { status: "archived" } });

      const missing = await request("session_missing", "session.get", {
        sessionId: "sess_missing",
      });
      expect(missing).toEqual({
        id: "session_missing",
        ok: false,
        error: { code: "session_not_found", message: "unknown session: sess_missing" },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("injects daemon ownership and freezes owner cwd on submitted turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-session-scope-"));
    const daemonCwd = join(root, "daemon-base");
    const workspaceCwd = join(root, "workspace");
    mkdirSync(daemonCwd);
    mkdirSync(workspaceCwd);
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
    const workspace = ensureLocalWorkspace(db, {
      localPath: workspaceCwd,
      localWorkspaceKey: "scope-workspace",
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "install-scope-test",
      daemonCwd,
      resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(db, workspaceId),
    });
    const request = async (id: string, method: string, params?: unknown) =>
      await handleLocalRpcLine(
        JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      );

    try {
      const global = await request("create_global", "session.create", {
        sessionId: "sess_global",
        scope: { kind: "daemon" },
      });
      expect(global).toMatchObject({
        ok: true,
        result: {
          sessionId: "sess_global",
          scope: { kind: "daemon", daemonId: "install-scope-test" },
          cwd: daemonCwd,
        },
      });
      expect(global).not.toHaveProperty("result.workspaceId");

      const workspaceSession = await request("create_workspace", "session.create", {
        sessionId: "sess_workspace",
        workspaceId: workspace.id,
      });
      expect(workspaceSession).toMatchObject({
        ok: true,
        result: {
          scope: { kind: "workspace", workspaceId: workspace.id },
          workspaceId: workspace.id,
          cwd: workspace.localPath,
        },
      });

      const unresolvedWorkspace = await request("create_unresolved", "session.create", {
        sessionId: "sess_unresolved",
        workspaceId: "ws_missing",
      });
      expect(unresolvedWorkspace).toMatchObject({
        ok: false,
        error: { code: "workspace_cwd_unavailable" },
      });

      const globalList = await request("list_global", "session.list", {
        scope: { kind: "daemon" },
      });
      expect(globalList).toMatchObject({
        ok: true,
        result: [{ sessionId: "sess_global" }],
      });

      const globalTurn = await request("turn_global", "turn.submit", {
        sessionId: "sess_global",
        prompt: "global work",
      });
      expect(globalTurn).toMatchObject({
        ok: true,
        result: { task: { sessionId: "sess_global", cwd: daemonCwd } },
      });
      expect(
        (globalTurn as { result?: { task?: { workspaceId?: string } } }).result?.task?.workspaceId,
      ).toBeUndefined();

      const workspaceTurn = await request("turn_workspace", "turn.submit", {
        sessionId: "sess_workspace",
        prompt: "workspace work",
      });
      expect(workspaceTurn).toMatchObject({
        ok: true,
        result: {
          task: {
            sessionId: "sess_workspace",
            cwd: workspace.localPath,
            workspaceId: workspace.id,
          },
        },
      });

      const spoofed = await request("turn_spoofed", "turn.submit", {
        sessionId: "sess_global",
        prompt: "wrong owner",
        assignment: {
          goal: "wrong owner",
          target: { sessionId: "sess_global", workspaceId: workspace.id },
          source: { kind: "cockpit" },
        },
      });
      expect(spoofed).toMatchObject({
        ok: false,
        error: { code: "session_scope_mismatch" },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a display-safe active-branch session snapshot from daemon native storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-snapshot-"));
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
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "install-rpc-snapshot",
      daemonCwd: root,
    });
    const request = async (id: string) =>
      await handleLocalRpcLine(
        JSON.stringify({ id, method: "session.snapshot", params: { sessionId: "sess_view" } }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      );

    try {
      await sessionRegistry.create({
        sessionId: "sess_view",
        workspaceId: "ws_view",
        title: "Unified conversation",
      });

      const empty = await request("snapshot_empty");
      expect(empty).toMatchObject({
        ok: true,
        result: {
          sessionId: "sess_view",
          title: "Unified conversation",
          messages: [],
          metadata: { workspaceId: "ws_view", registryStatus: "ready" },
        },
      });
      expect(JSON.stringify(empty)).not.toContain("sessionPath");

      const queue = new SparkDaemonQueue({ paths });
      const queued = await queue.enqueue({
        type: "session.run",
        sessionId: "sess_view",
        prompt: "Queued follow-up",
      });
      const pending = await request("snapshot_pending");
      expect(pending).toMatchObject({
        ok: true,
        result: {
          status: "running",
          messages: [
            {
              id: `queue:${queued.fileName}`,
              role: "user",
              text: "Queued follow-up",
              status: "done",
              metadata: { source: "daemon.queue", taskFileName: queued.fileName },
            },
          ],
        },
      });
      await queue.markProcessed(queued.fileName);
      const settled = await request("snapshot_pending_settled");
      expect(settled).toMatchObject({ ok: true, result: { messages: [] } });

      const fallbackPath = join(
        paths.piAgentDir!,
        "sessions",
        "workspace-hash",
        "2026-07-10T08-00-00-000Z_sess_view.jsonl",
      );
      mkdirSync(join(paths.piAgentDir!, "sessions", "workspace-hash"), { recursive: true });
      writeFileSync(
        fallbackPath,
        `${[
          {
            type: "session",
            version: 3,
            id: "sess_view",
            timestamp: "2026-07-10T08:00:00.000Z",
            cwd: "/workspace/view",
          },
          {
            type: "message",
            id: "user-root",
            parentId: null,
            timestamp: "2026-07-10T08:00:01.000Z",
            message: { role: "user", content: "root question" },
          },
          {
            type: "message",
            id: "inactive-assistant",
            parentId: "user-root",
            timestamp: "2026-07-10T08:00:02.000Z",
            message: { role: "assistant", content: "inactive answer" },
          },
          {
            type: "message",
            id: "branch-user",
            parentId: "user-root",
            timestamp: "2026-07-10T08:00:03.000Z",
            message: { role: "user", content: [{ type: "text", text: "branch question" }] },
          },
          {
            type: "message",
            id: "system-hidden",
            parentId: "branch-user",
            timestamp: "2026-07-10T08:00:04.000Z",
            message: { role: "system", content: "system-secret" },
          },
          {
            type: "message",
            id: "tool-hidden",
            parentId: "system-hidden",
            timestamp: "2026-07-10T08:00:05.000Z",
            message: {
              role: "toolResult",
              content: [{ type: "text", text: "tool-secret" }],
              details: { token: "secret-input" },
            },
          },
          {
            type: "message",
            id: "branch-assistant",
            parentId: "tool-hidden",
            timestamp: "2026-07-10T08:00:06.000Z",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "branch answer" },
                { type: "toolCall", name: "unsafe", arguments: { token: "secret-input" } },
              ],
            },
          },
          {
            type: "message",
            id: "custom-visible",
            parentId: "branch-assistant",
            timestamp: "2026-07-10T08:00:07.000Z",
            message: { role: "custom", content: "visible note" },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
      );

      const fallback = await request("snapshot_fallback");
      expect(fallback).toMatchObject({
        ok: true,
        result: {
          sessionId: "sess_view",
          activeLeafId: "custom-visible",
          messages: [
            { id: "user-root", role: "user", text: "root question" },
            { id: "branch-user", role: "user", text: "branch question" },
            { id: "branch-assistant", role: "assistant", text: "branch answer" },
            { id: "custom-visible", role: "custom", text: "visible note" },
          ],
        },
      });
      expect(JSON.stringify(fallback)).not.toMatch(
        /inactive answer|system-secret|tool-secret|secret-input|sessionPath/u,
      );

      const preferredPath = join(
        paths.piAgentDir!,
        "sessions",
        "preferred",
        "2026-07-10T09-00-00-000Z_sess_view.jsonl",
      );
      mkdirSync(join(paths.piAgentDir!, "sessions", "preferred"), { recursive: true });
      writeFileSync(
        preferredPath,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "sess_view",
          timestamp: "2026-07-10T09:00:00.000Z",
          cwd: "/workspace/view",
        })}\n${JSON.stringify({
          type: "message",
          id: "preferred-user",
          parentId: null,
          timestamp: "2026-07-10T09:00:01.000Z",
          message: { role: "user", content: "preferred transcript" },
        })}\n`,
      );
      await sessionRegistry.recordRun({
        sessionId: "sess_view",
        sessionPath: preferredPath,
      });
      const preferred = await request("snapshot_preferred");
      expect(preferred).toMatchObject({
        ok: true,
        result: { messages: [{ id: "preferred-user", text: "preferred transcript" }] },
      });
      expect(JSON.stringify(preferred)).not.toContain(preferredPath);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves model/auth control and freezes the effective model on submitted turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-model-rpc-"));
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
    const model = { providerName: "baidu-oneapi", modelId: "ernie-4.5" };
    const snapshot = {
      providers: [],
      defaultModel: model,
      session: { sessionId: "sess_model", model },
      diagnostics: [],
    };
    const setApiKey = vi.fn(async () => snapshot);
    const prepareModel = vi.fn(async () => undefined);
    const modelControl = {
      snapshot: vi.fn(async () => snapshot),
      setDefaultModel: vi.fn(async () => snapshot),
      setSessionModel: vi.fn(async () => ({
        sessionId: "sess_model",
        scope: { kind: "workspace" as const, workspaceId: "ws_model" },
        workspaceId: "ws_model",
        model,
        bindings: [],
        status: "ready" as const,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:01:00.000Z",
      })),
      setSessionThinkingLevel: vi.fn(async () => ({
        sessionId: "sess_model",
        scope: { kind: "workspace" as const, workspaceId: "ws_model" },
        workspaceId: "ws_model",
        model,
        thinkingLevel: "high" as const,
        bindings: [],
        status: "ready" as const,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:01:00.000Z",
      })),
      setApiKey,
      logout: vi.fn(async () => ({ removed: true, snapshot })),
      startOAuth: vi.fn(),
      oauthStatus: vi.fn(),
      respondOAuth: vi.fn(),
      cancelOAuth: vi.fn(),
      effectiveModel: vi.fn(async () => model),
      effectiveThinkingLevel: vi.fn(async () => undefined),
      prepareModel,
    } satisfies SparkDaemonModelControl;

    try {
      const catalog = await handleLocalRpcLine(
        JSON.stringify({
          id: "model_catalog",
          method: "model.catalog",
          params: { sessionId: "sess_model" },
        }),
        paths,
        db,
        undefined,
        { modelControl },
      );
      expect(catalog).toMatchObject({ ok: true, result: { defaultModel: model } });

      const credential = await handleLocalRpcLine(
        JSON.stringify({
          id: "auth_set",
          method: "provider.auth.api-key.set",
          params: { providerName: "baidu-oneapi", apiKey: "secret-value" },
        }),
        paths,
        db,
        undefined,
        { modelControl },
      );
      expect(credential).toMatchObject({ ok: true });
      expect(setApiKey).toHaveBeenCalledWith("baidu-oneapi", "secret-value");

      const submitted = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_model",
          method: "turn.submit",
          params: { sessionId: "sess_model", prompt: "Use the selected model" },
        }),
        paths,
        db,
        undefined,
        { modelControl },
      );
      expect(submitted).toMatchObject({
        ok: true,
        result: { task: { model: "baidu-oneapi/ernie-4.5" } },
      });
      expect(prepareModel).toHaveBeenCalledWith(model);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requests daemon shutdown over the local socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-"));
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
