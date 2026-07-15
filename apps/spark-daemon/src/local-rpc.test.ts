import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ChannelNotifyInput, ChannelNotifyResult } from "@zendev-lab/spark-channels";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { requestSparkDaemonLocalRpcWire } from "@zendev-lab/spark-system/daemon-local-rpc";
import {
  createDaemonSessionRegistry,
  handleLocalRpcLine,
  requestDaemonRestart,
  requestWorkspaceEnsureLocal,
  startLocalRpcServer,
} from "./local-rpc.js";
import { SparkInvocationStore } from "./store/invocations.ts";
import { openSparkDaemonDatabase } from "./store/schema.js";
import {
  ensureLocalWorkspace,
  listWorkspaces,
  resolveWorkspaceLocalPath,
  WorkspacePathConflictError,
} from "./store/workspaces.js";
import type { SparkDaemonModelControl } from "./model-control.ts";
import { SparkDaemonLifecycle } from "./core/lifecycle.ts";
import type {
  DaemonChannelIngressRuntime,
  DaemonChannelIngressStatus,
} from "./channels/ingress.ts";

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
      const normalizedWorkspacePath = realpathSync(workspacePath);
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
            localPath: normalizedWorkspacePath,
            displayName: "Spore",
            workspaceName: "Spore profile",
            workspaceSlug: "spore-profile",
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
            localPath: normalizedWorkspacePath,
            displayName: "Spore",
            workspaceName: "Spore profile",
            workspaceSlug: "spore-profile",
          },
        }),
      );
      expect(verifyConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          localPath: normalizedWorkspacePath,
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

  it("hard-cuts local turn submit/status/stream to invocation ids and bounded cursors", async () => {
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
      const request = {
        id: "turn_submit",
        method: "turn.submit",
        params: {
          sessionId: "session-a",
          prompt: "continue work",
          idempotencyKey: "local-turn-1",
        },
      };
      const submitted = await handleLocalRpcLine(JSON.stringify(request), paths, db, undefined);
      expect(submitted).toMatchObject({
        id: "turn_submit",
        ok: true,
        result: { status: "queued", acceptedAt: expect.any(String) },
      });
      const result = (submitted as { result: { invocationId: string } }).result;
      expect(result.invocationId).toMatch(/^inv_/u);
      expect(JSON.stringify(submitted)).not.toMatch(/fileName|filePath|inbox|processed/u);

      const duplicate = await handleLocalRpcLine(
        JSON.stringify({ ...request, id: "turn_submit_duplicate" }),
        paths,
        db,
        undefined,
      );
      expect(duplicate).toMatchObject({ result: { invocationId: result.invocationId } });

      const store = new SparkInvocationStore(db);
      store.appendEvent(result.invocationId, "delta", { index: 1 });
      store.appendEvent(result.invocationId, "delta", { index: 2 });
      const status = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_status",
          method: "turn.status",
          params: { invocationId: result.invocationId },
        }),
        paths,
        db,
        undefined,
      );
      expect(status).toMatchObject({
        ok: true,
        result: { invocationId: result.invocationId, status: "queued", eventCursor: 2 },
      });
      expect(JSON.stringify(status)).not.toMatch(/fileName|filePath|inbox|processed/u);

      const page = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_stream",
          method: "turn.stream",
          params: { invocationId: result.invocationId, after: 0, limit: 1 },
        }),
        paths,
        db,
        undefined,
      );
      expect(page).toMatchObject({
        ok: true,
        result: {
          invocationId: result.invocationId,
          events: [{ sequence: 1 }],
          nextCursor: 1,
          hasMore: true,
        },
      });

      const gap = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_stream_gap",
          method: "turn.stream",
          params: { invocationId: result.invocationId, after: 3 },
        }),
        paths,
        db,
        undefined,
      );
      expect(gap).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("CURSOR_GAP") },
      });

      const removed = await handleLocalRpcLine(
        JSON.stringify({ id: "removed_queue", method: "daemon.queue" }),
        paths,
        db,
        undefined,
      );
      expect(removed).toMatchObject({
        ok: false,
        error: { message: "Unknown local RPC method: daemon.queue" },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes cancellation races converge on one canonical terminal status", async () => {
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
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "cancel-test",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "session-a", scope: { kind: "daemon" } });

    try {
      const submitted = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_submit",
          method: "turn.submit",
          params: {
            sessionId: "session-a",
            prompt: "cancel me",
            idempotencyKey: "cancel-session-a",
          },
        }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      );
      const invocation = (submitted as { result: { invocationId: string } }).result;
      expect(await sessionRegistry.get("session-a")).toMatchObject({ status: "running" });

      const cancelled = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_cancel",
          method: "turn.cancel",
          params: {
            invocationId: invocation.invocationId,
            reason: "test cancel",
          },
        }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      );
      expect(cancelled).toMatchObject({
        id: "turn_cancel",
        ok: true,
        result: {
          invocationId: invocation.invocationId,
          status: "cancelled",
          cancelRequested: true,
        },
      });
      expect(await sessionRegistry.get("session-a")).toMatchObject({ status: "ready" });

      const duplicate = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_submit_duplicate",
          method: "turn.submit",
          params: {
            sessionId: "session-a",
            prompt: "cancel me",
            idempotencyKey: "cancel-session-a",
          },
        }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      );
      expect(duplicate).toMatchObject({
        ok: true,
        result: { invocationId: invocation.invocationId, status: "queued" },
      });
      expect(await sessionRegistry.get("session-a")).toMatchObject({ status: "ready" });
      const duplicateStatus = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_status_duplicate",
          method: "turn.status",
          params: { invocationId: invocation.invocationId },
        }),
        paths,
        db,
        undefined,
      );
      expect(duplicateStatus).toMatchObject({
        ok: true,
        result: { invocationId: invocation.invocationId, status: "cancelled" },
      });

      const repeated = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_cancel_again",
          method: "turn.cancel",
          params: { invocationId: invocation.invocationId, reason: "again" },
        }),
        paths,
        db,
        undefined,
      );
      expect(repeated).toMatchObject({
        ok: true,
        result: { status: "cancelled", cancelRequested: false },
      });

      const missing = await handleLocalRpcLine(
        JSON.stringify({
          id: "turn_cancel_missing",
          method: "turn.cancel",
          params: { invocationId: "inv_01234567890123456789012345678901" },
        }),
        paths,
        db,
        undefined,
      );
      expect(missing).toMatchObject({
        id: "turn_cancel_missing",
        ok: false,
        error: { message: expect.stringContaining("Unknown Spark invocation") },
      });
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

  it("keeps 10,000-event status and cursor pages bounded over a real daemon socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-events-"));
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
      daemonId: "socket-test",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "event-session", scope: { kind: "daemon" } });
    const server = await startLocalRpcServer({
      paths,
      sparkHome: join(root, ".spark"),
      db,
      sessionRegistry,
    });
    const request = async <T>(id: string, method: string, params?: unknown) => {
      const wireResult = await requestSparkDaemonLocalRpcWire<T | { result: T }>(
        { id, method, ...(params === undefined ? {} : { params }) },
        { paths },
      );
      const result =
        wireResult && typeof wireResult === "object" && "result" in wireResult
          ? wireResult.result
          : wireResult;
      const bytes = Buffer.byteLength(JSON.stringify(wireResult));
      expect(bytes).toBeLessThan(1024 * 1024);
      return { result, bytes };
    };

    try {
      const submitted = await request<{ invocationId: string; status: string }>(
        "submit",
        "turn.submit",
        { sessionId: "event-session", prompt: "emit many", idempotencyKey: "events-10000" },
      );
      const invocationId = submitted.result.invocationId;
      const store = new SparkInvocationStore(db);
      for (let index = 0; index < 10_000; index += 1) {
        store.appendEvent(invocationId, "delta", { index, text: `event-${index}` });
      }

      const before = await request<{ eventCursor: number; events?: unknown[] }>(
        "status_before",
        "turn.status",
        { invocationId },
      );
      expect(before.result.eventCursor).toBe(10_000);
      expect(before.result.events).toBeUndefined();

      let cursor = 0;
      let eventCount = 0;
      let maxPageBytes = 0;
      let hasMore = true;
      while (hasMore) {
        const page = await request<{
          events: Array<{ sequence: number }>;
          nextCursor: number;
          hasMore: boolean;
        }>("stream", "turn.stream", { invocationId, after: cursor, limit: 500 });
        expect(page.result.events.length).toBeLessThanOrEqual(500);
        expect(page.result.nextCursor).toBeGreaterThan(cursor);
        eventCount += page.result.events.length;
        cursor = page.result.nextCursor;
        maxPageBytes = Math.max(maxPageBytes, page.bytes);
        hasMore = page.result.hasMore;
      }
      expect({ eventCount, cursor, maxPageBytes }).toMatchObject({
        eventCount: 10_000,
        cursor: 10_000,
      });

      store.claimNext("socket-test");
      store.complete(invocationId, { status: "succeeded" });
      const terminal = await request<{ status: string; eventCursor: number }>(
        "status_terminal",
        "turn.status",
        { invocationId },
      );
      expect(terminal.result).toMatchObject({ status: "succeeded", eventCursor: 10_000 });

      const cancelSubmitted = await request<{ invocationId: string }>(
        "submit_cancel",
        "turn.submit",
        {
          sessionId: "event-session",
          prompt: "cancel over socket",
          idempotencyKey: "socket-cancel",
        },
      );
      const cancelled = await request<{ status: string; cancelRequested: boolean }>(
        "cancel",
        "turn.cancel",
        { invocationId: cancelSubmitted.result.invocationId, reason: "socket acceptance" },
      );
      expect(cancelled.result).toMatchObject({ status: "cancelled", cancelRequested: true });
      const cancelledStatus = await request<{ status: string }>("status_cancelled", "turn.status", {
        invocationId: cancelSubmitted.result.invocationId,
      });
      expect(cancelledStatus.result.status).toBe("cancelled");

      console.info(
        "SPARK_INVOCATION_SOCKET_TRANSCRIPT",
        JSON.stringify({
          invocationId,
          eventCount,
          statusBytes: before.bytes,
          maxPageBytes,
          cursor,
          terminalStatus: terminal.result.status,
          terminalStatusBytes: terminal.bytes,
          cancelledInvocationId: cancelSubmitted.result.invocationId,
          cancellationStatus: cancelledStatus.result.status,
          cancellationResponseBytes: cancelled.bytes,
        }),
      );
    } finally {
      await server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps 10,000-invocation diagnostics bounded and exposes result retry and retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-invocation-list-"));
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
    const store = new SparkInvocationStore(db);
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "invocation-list-test",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "session:selected", scope: { kind: "daemon" } });
    await sessionRegistry.create({ sessionId: "session:other", scope: { kind: "daemon" } });
    const insert = db.prepare(
      `INSERT INTO invocations
        (id, session_id, status, prompt, task_json, attempt_count, error_code, error_message,
         created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, 'failed', ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 10_000; index += 1) {
        const timestamp = new Date(
          Date.parse("2026-07-01T00:00:00.000Z") + index * 1_000,
        ).toISOString();
        const retryable = index % 2 === 0;
        insert.run(
          `inv_history${String(index).padStart(8, "0")}`,
          index % 4 === 0 ? "session:selected" : "session:other",
          `history-${index}`,
          JSON.stringify({
            type: "session.run",
            sessionId: index % 4 === 0 ? "session:selected" : "session:other",
            prompt: `history-${index}`,
          }),
          retryable ? "EXECUTOR_TIMEOUT" : "EXECUTION_FAILED",
          `failure-${index}`,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const server = await startLocalRpcServer({
      paths,
      sparkHome: join(root, ".spark"),
      db,
      sessionRegistry,
    });

    try {
      const listedWire = await requestSparkDaemonLocalRpcWire<{
        invocations: Array<Record<string, unknown>>;
        total: number;
        limit: number;
      }>(
        {
          id: "invocation_list",
          method: "invocation.list",
          params: {
            status: "failed",
            sessionId: "session:selected",
            since: "2026-07-01T00:30:00.000Z",
            limit: 50,
          },
        },
        { paths },
      );
      expect(listedWire).toMatchObject({ total: 2_050, limit: 50 });
      expect(listedWire.invocations).toHaveLength(50);
      expect(listedWire.invocations.every((entry) => entry.status === "failed")).toBe(true);
      expect(listedWire.invocations.every((entry) => entry.sessionId === "session:selected")).toBe(
        true,
      );
      expect(listedWire.invocations[0]).toEqual(
        expect.objectContaining({
          invocationId: expect.stringMatching(/^inv_history/u),
          errorCode: expect.any(String),
          retryable: expect.any(Boolean),
          eventCursor: 0,
        }),
      );
      expect(JSON.stringify(listedWire)).not.toContain("task_json");
      expect(JSON.stringify(listedWire)).not.toContain("history-9999");
      expect(Buffer.byteLength(JSON.stringify(listedWire))).toBeLessThan(64 * 1024);

      const original = store.require("inv_history00009998");
      const result = await requestSparkDaemonLocalRpcWire<{
        status: string;
        error: { code: string; message: string; retryable: boolean };
      }>(
        {
          id: "turn_result",
          method: "turn.result",
          params: { invocationId: original.invocationId },
        },
        { paths },
      );
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "EXECUTOR_TIMEOUT", retryable: true },
      });

      const retry = await requestSparkDaemonLocalRpcWire<{
        invocationId: string;
        retryOfInvocationId: string;
        status: string;
      }>(
        {
          id: "invocation_retry",
          method: "invocation.retry",
          params: { invocationId: original.invocationId },
        },
        { paths },
      );
      expect(retry).toMatchObject({
        status: "queued",
        retryOfInvocationId: original.invocationId,
      });
      expect(store.require(retry.invocationId)).toMatchObject({
        retryOfInvocationId: original.invocationId,
        sourceKind: "invocation.retry",
        sourceRef: original.invocationId,
      });
      expect(store.require(original.invocationId).status).toBe("failed");

      const retention = await requestSparkDaemonLocalRpcWire<{
        before: string;
        invocationIds: string[];
        dryRun: boolean;
      }>(
        {
          id: "retention_preview",
          method: "invocation.retention.preview",
          params: { before: "2026-07-01T00:01:00.000Z", limit: 10 },
        },
        { paths },
      );
      expect(retention).toMatchObject({
        before: "2026-07-01T00:01:00.000Z",
        dryRun: true,
      });
      expect(retention.invocationIds).toHaveLength(10);
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

      await sessionRegistry.recordTurnQueued("sess_a");
      const staleRegistry = await request("session_get_stale", "session.get", {
        sessionId: "sess_a",
      });
      expect(staleRegistry).toMatchObject({
        ok: true,
        result: { sessionId: "sess_a", status: "ready" },
      });

      const invocationStore = new SparkInvocationStore(db);
      const activeInvocation = invocationStore.submit({
        sessionId: "sess_a",
        prompt: "active turn",
        now: "2099-07-15T00:00:00.000Z",
      });
      const activeSession = await request("session_get_active", "session.get", {
        sessionId: "sess_a",
      });
      expect(activeSession).toMatchObject({
        ok: true,
        result: {
          sessionId: "sess_a",
          status: "running",
          updatedAt: "2099-07-15T00:00:00.000Z",
        },
      });
      expect(
        await request("session_list_active", "session.list", { workspaceId: "ws_a" }),
      ).toMatchObject({ ok: true, result: [{ sessionId: "sess_a", status: "running" }] });
      invocationStore.claimNext("test-worker", "2099-07-15T00:00:01.000Z");
      invocationStore.complete(activeInvocation.invocationId, {
        status: "succeeded",
        now: "2099-07-15T00:00:02.000Z",
      });
      const settledSession = await request("session_get_settled", "session.get", {
        sessionId: "sess_a",
      });
      expect(settledSession).toMatchObject({
        ok: true,
        result: {
          sessionId: "sess_a",
          status: "ready",
          updatedAt: "2099-07-15T00:00:02.000Z",
        },
      });
      expect(
        await request("session_list_settled", "session.list", { workspaceId: "ws_a" }),
      ).toMatchObject({ ok: true, result: [{ sessionId: "sess_a", status: "ready" }] });

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
      expect(
        await request("session_get_archived", "session.get", { sessionId: "sess_a" }),
      ).toMatchObject({ ok: true, result: { sessionId: "sess_a", status: "archived" } });

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
        result: { invocationId: expect.stringMatching(/^inv_/u), status: "queued" },
      });
      const globalInvocation = new SparkInvocationStore(db).require(
        (globalTurn as { result: { invocationId: string } }).result.invocationId,
      );
      expect(globalInvocation.task).toMatchObject({ sessionId: "sess_global", cwd: daemonCwd });
      expect(globalInvocation.task).not.toHaveProperty("workspaceId");

      const workspaceTurn = await request("turn_workspace", "turn.submit", {
        sessionId: "sess_workspace",
        prompt: "workspace work",
      });
      expect(workspaceTurn).toMatchObject({
        ok: true,
        result: { invocationId: expect.stringMatching(/^inv_/u), status: "queued" },
      });
      expect(
        new SparkInvocationStore(db).require(
          (workspaceTurn as { result: { invocationId: string } }).result.invocationId,
        ).task,
      ).toMatchObject({
        sessionId: "sess_workspace",
        cwd: workspace.localPath,
        workspaceId: workspace.id,
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

  it("delivers durable user notifications and skips already delivered targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-notification-"));
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath);
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
    const sparkHome = join(root, ".spark");
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonId: "notification-test",
      daemonCwd: root,
      resolveWorkspaceCwd: (workspaceId) =>
        workspaceId === "ws_delivery" ? workspacePath : undefined,
    });
    const mailStore = new SparkSessionMailStore({ sparkHome });
    const status = notificationChannelStatus("ws_delivery", [
      { id: "info-main", type: "infoflow" },
      { id: "qq-main", type: "qqbot" },
    ]);
    const notify = vi.fn(
      async (workspaceId: string, input: ChannelNotifyInput): Promise<ChannelNotifyResult> => {
        if (!input.adapter || !input.recipient) throw new Error("missing delivery target");
        return {
          action: "send",
          adapter: input.adapter,
          recipient: input.recipient,
          text: input.text ?? "",
        };
      },
    );
    const channelIngress = {
      status: vi.fn(() => status),
      configure: vi.fn(async () => status),
      reload: vi.fn(async () => status),
      notify,
    } satisfies Pick<DaemonChannelIngressRuntime, "status" | "configure" | "reload" | "notify">;

    try {
      await sessionRegistry.create({
        sessionId: "sess_delivery",
        scope: { kind: "workspace", workspaceId: "ws_delivery" },
        workspaceId: "ws_delivery",
      });
      await sessionRegistry.bind({
        sessionId: "sess_delivery",
        externalKey: "infoflow:group:group-1",
      });
      await sessionRegistry.bind({
        sessionId: "sess_delivery",
        externalKey: "qqbot:c2c:user-1",
      });
      const sent = await mailStore.send({
        toSessionId: "sess_delivery",
        fromSessionId: "sess_sender",
        kind: "notification",
        visibility: "user",
        delivery: "channel",
        deliveryTargets: [
          { adapter: "infoflow", externalKey: "infoflow:group:group-1" },
          { adapter: "qqbot", externalKey: "qqbot:c2c:user-1" },
        ],
        body: "Deployment complete",
        source: "tool",
      });
      const request = async (id: string) =>
        await handleLocalRpcLine(
          JSON.stringify({
            id,
            method: "session.notification.deliver",
            params: { sessionId: "sess_delivery", messageId: sent.message.id },
          }),
          paths,
          db,
          undefined,
          { sessionRegistry, mailStore, channelIngress },
        );

      const delivered = await request("deliver_notification");
      expect(delivered).toMatchObject({
        id: "deliver_notification",
        ok: true,
        result: {
          deliveries: [
            {
              adapter: "infoflow",
              externalKey: "infoflow:group:group-1",
              status: "delivered",
              attemptCount: 1,
              receipt: { adapter: "info-main", recipient: "group:group-1" },
            },
            {
              adapter: "qqbot",
              externalKey: "qqbot:c2c:user-1",
              status: "delivered",
              attemptCount: 1,
              receipt: { adapter: "qq-main", recipient: "c2c:user-1" },
            },
          ],
        },
      });
      expect(notify.mock.calls).toEqual([
        [
          "ws_delivery",
          {
            action: "send",
            adapter: "info-main",
            recipient: "group:group-1",
            text: "Deployment complete",
          },
        ],
        [
          "ws_delivery",
          {
            action: "send",
            adapter: "qq-main",
            recipient: "c2c:user-1",
            text: "Deployment complete",
          },
        ],
      ]);

      const repeated = await request("deliver_notification_again");
      expect(repeated).toMatchObject({
        ok: true,
        result: {
          deliveries: [
            { status: "delivered", attemptCount: 1 },
            { status: "delivered", attemptCount: 1 },
          ],
        },
      });
      expect(notify).toHaveBeenCalledTimes(2);
      expect(await mailStore.get("sess_delivery", sent.message.id)).toMatchObject({
        deliveries: [
          { status: "delivered", attemptCount: 1, lastError: null },
          { status: "delivered", attemptCount: 1, lastError: null },
        ],
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps failed notification receipts retryable and rejects internal mail before notify", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-notification-retry-"));
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath);
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
    const sparkHome = join(root, ".spark");
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonId: "notification-retry-test",
      daemonCwd: root,
      resolveWorkspaceCwd: (workspaceId) =>
        workspaceId === "ws_retry" ? workspacePath : undefined,
    });
    const mailStore = new SparkSessionMailStore({ sparkHome });
    const status = notificationChannelStatus("ws_retry", [{ id: "info-main", type: "infoflow" }]);
    let attempt = 0;
    const notify = vi.fn(
      async (_workspaceId: string, input: ChannelNotifyInput): Promise<ChannelNotifyResult> => {
        attempt += 1;
        if (attempt === 1) throw new Error("channel temporarily unavailable");
        if (!input.adapter || !input.recipient) throw new Error("missing delivery target");
        return {
          action: "send",
          adapter: input.adapter,
          recipient: input.recipient,
          text: input.text ?? "",
        };
      },
    );
    const channelIngress = {
      status: vi.fn(() => status),
      configure: vi.fn(async () => status),
      reload: vi.fn(async () => status),
      notify,
    } satisfies Pick<DaemonChannelIngressRuntime, "status" | "configure" | "reload" | "notify">;

    try {
      await sessionRegistry.create({
        sessionId: "sess_retry",
        scope: { kind: "workspace", workspaceId: "ws_retry" },
        workspaceId: "ws_retry",
      });
      await sessionRegistry.bind({
        sessionId: "sess_retry",
        externalKey: "infoflow:user:user-1",
      });
      const sent = await mailStore.send({
        toSessionId: "sess_retry",
        fromSessionId: "sess_sender",
        kind: "notification",
        visibility: "user",
        delivery: "channel",
        deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:user-1" }],
        body: "Please review",
        source: "tool",
      });
      const request = async (id: string, messageId: string) =>
        await handleLocalRpcLine(
          JSON.stringify({
            id,
            method: "session.notification.deliver",
            params: { sessionId: "sess_retry", messageId },
          }),
          paths,
          db,
          undefined,
          { sessionRegistry, mailStore, channelIngress },
        );

      const failed = await request("deliver_failed", sent.message.id);
      expect(failed).toMatchObject({
        ok: true,
        result: {
          deliveries: [
            {
              adapter: "infoflow",
              externalKey: "infoflow:user:user-1",
              status: "failed",
              attemptCount: 1,
              error: "channel temporarily unavailable",
            },
          ],
        },
      });
      expect(await mailStore.get("sess_retry", sent.message.id)).toMatchObject({
        deliveries: [
          {
            status: "failed",
            attemptCount: 1,
            lastError: "channel temporarily unavailable",
          },
        ],
      });

      const retried = await request("deliver_retried", sent.message.id);
      expect(retried).toMatchObject({
        ok: true,
        result: {
          deliveries: [
            {
              status: "delivered",
              attemptCount: 2,
              receipt: { adapter: "info-main", recipient: "user-1" },
            },
          ],
        },
      });
      expect(JSON.stringify(retried)).not.toContain("channel temporarily unavailable");
      expect(notify).toHaveBeenCalledTimes(2);

      const internal = await mailStore.send({
        toSessionId: "sess_retry",
        fromSessionId: "sess_sender",
        kind: "notification",
        visibility: "internal",
        delivery: "channel",
        deliveryTargets: [{ adapter: "infoflow", externalKey: "infoflow:user:user-1" }],
        body: "Internal only",
        source: "tool",
      });
      const rejected = await request("deliver_internal", internal.message.id);
      expect(rejected).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("not user-visible") },
      });
      expect(notify).toHaveBeenCalledTimes(2);
      expect(await mailStore.get("sess_retry", internal.message.id)).toMatchObject({
        deliveries: [{ status: "pending", attemptCount: 0 }],
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
        {
          sessionRegistry,
          mailStore: {
            list: async (_sessionId, options) => {
              expect(_sessionId).toBe("sess_view");
              expect(options).toEqual({ includeAcked: true });
              return Array.from({ length: 51 }, (_, index) => ({
                id: `mail:${index}`,
                toSessionId: "sess_view",
                fromSessionId: `sess_sender_${index}`,
                kind: index % 2 === 0 ? ("request" as const) : ("notification" as const),
                visibility: "user" as const,
                delivery: "mailbox" as const,
                deliveries: [],
                intent: "review.pull-request",
                payload: { secret: `not-for-cockpit-${index}` },
                correlationId: `corr:${index}`,
                replyToMessageId: null,
                idempotencyKey: `secret-idempotency-${index}`,
                subject: index === 50 ? "Newest request" : null,
                body: `Message ${index}`,
                createdAt: `2026-07-14T03:${String(index).padStart(2, "0")}:00.000Z`,
                readAt: index === 50 ? null : "2026-07-14T04:00:00.000Z",
                ackedAt: index === 0 ? "2026-07-14T05:00:00.000Z" : null,
                source: "tool" as const,
              }));
            },
          },
        },
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
      const emptyResult = (empty as { result: { mailbox: Array<Record<string, unknown>> } }).result;
      expect(emptyResult.mailbox).toHaveLength(50);
      expect(emptyResult.mailbox[0]).toEqual({
        id: "mail:1",
        fromSessionId: "sess_sender_1",
        kind: "notification",
        intent: "review.pull-request",
        subject: null,
        body: "Message 1",
        createdAt: "2026-07-14T03:01:00.000Z",
        readAt: "2026-07-14T04:00:00.000Z",
        ackedAt: null,
      });
      expect(emptyResult.mailbox.at(-1)).toMatchObject({
        id: "mail:50",
        subject: "Newest request",
      });
      expect(JSON.stringify(emptyResult.mailbox)).not.toContain("not-for-cockpit");
      expect(JSON.stringify(emptyResult.mailbox)).not.toContain("secret-idempotency");

      await sessionRegistry.recordTurnQueued("sess_view");
      const store = new SparkInvocationStore(db);
      const queued = store.submit({
        sessionId: "sess_view",
        prompt: "Queued follow-up",
        task: { type: "session.run", sessionId: "sess_view", prompt: "Queued follow-up" },
      });
      const pending = await request("snapshot_pending");
      expect(pending).toMatchObject({
        ok: true,
        result: {
          status: "running",
          messages: [
            {
              id: `invocation:${queued.invocationId}`,
              role: "user",
              text: "Queued follow-up",
              status: "done",
              metadata: { source: "daemon.invocation", invocationId: queued.invocationId },
            },
          ],
        },
      });
      store.claimNext("test-worker");
      store.complete(queued.invocationId, { status: "succeeded" });
      const settled = await request("snapshot_pending_settled");
      expect(settled).toMatchObject({
        ok: true,
        result: {
          status: "idle",
          messages: [],
          metadata: { registryStatus: "ready" },
        },
      });

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
        result: { invocationId: expect.stringMatching(/^inv_/u), status: "queued" },
      });
      expect(
        new SparkInvocationStore(db).require(
          (submitted as { result: { invocationId: string } }).result.invocationId,
        ).task,
      ).toMatchObject({ model: "baidu-oneapi/ernie-4.5" });
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
    const onStopRequested = vi.fn();

    try {
      const response = await handleLocalRpcLine(
        JSON.stringify({ id: "local_test", method: "daemon.stop" }),
        paths,
        db,
        onStop,
        { onStopRequested },
      );
      expect(response).toMatchObject({
        id: "local_test",
        ok: true,
        result: {
          stopping: true,
          observedAt: expect.any(String),
        },
      });
      expect(onStopRequested).toHaveBeenCalledOnce();
      expect(onStop).not.toHaveBeenCalled();
      await delay(10);

      expect(onStop).toHaveBeenCalledOnce();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("acknowledges an idempotent drain restart and exposes lifecycle status", async () => {
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
    const lifecycle = new SparkDaemonLifecycle({
      instanceId: "instance-1",
      generation: "generation-1",
    });

    try {
      const restart = await handleLocalRpcLine(
        JSON.stringify({ id: "restart_test", method: "daemon.restart" }),
        paths,
        db,
        undefined,
        {
          onRestart: () =>
            lifecycle.requestRestart("2026-07-15T00:00:00.000Z", "restart-1", {
              instanceId: "target-instance-1",
              generation: "target-generation-1",
            }),
          getLifecycle: () => lifecycle.snapshot(),
        },
      );
      expect(restart).toEqual({
        id: "restart_test",
        ok: true,
        result: {
          accepted: true,
          state: "draining",
          restartId: "restart-1",
          processInstanceId: "instance-1",
          processGeneration: "generation-1",
          targetInstanceId: "target-instance-1",
          targetGeneration: "target-generation-1",
          requestedAt: "2026-07-15T00:00:00.000Z",
        },
      });

      const status = await handleLocalRpcLine(
        JSON.stringify({ id: "restart_status", method: "daemon.status" }),
        paths,
        db,
        undefined,
        { getLifecycle: () => lifecycle.snapshot() },
      );
      expect(status).toMatchObject({
        id: "restart_status",
        ok: true,
        result: {
          lifecycle: {
            state: "draining",
            phase: "draining-active-work",
            restartId: "restart-1",
            targetInstanceId: "target-instance-1",
            targetGeneration: "target-generation-1",
            restartRequestedAt: "2026-07-15T00:00:00.000Z",
          },
        },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes the restart acknowledgement before the zero-active socket closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-restart-"));
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
    const lifecycle = new SparkDaemonLifecycle({
      instanceId: "instance-1",
      generation: "generation-1",
    });
    const server = await startLocalRpcServer({
      paths,
      sparkHome: join(root, ".spark"),
      db,
      onRestart: () =>
        lifecycle.requestRestart("2026-07-15T00:00:00.000Z", "restart-1", {
          instanceId: "target-instance-1",
          generation: "target-generation-1",
        }),
      getLifecycle: () => lifecycle.snapshot(),
    });
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    lifecycle.restartSignal.addEventListener(
      "abort",
      () => {
        void server.close().then(resolveClosed, rejectClosed);
      },
      { once: true },
    );

    try {
      await expect(requestDaemonRestart(paths)).resolves.toEqual({
        accepted: true,
        state: "draining",
        restartId: "restart-1",
        processInstanceId: "instance-1",
        processGeneration: "generation-1",
        targetInstanceId: "target-instance-1",
        targetGeneration: "target-generation-1",
        requestedAt: "2026-07-15T00:00:00.000Z",
      });
      await closed;
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for an in-flight handler after forcing its socket closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-in-flight-"));
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
    const lifecycle = new SparkDaemonLifecycle({
      instanceId: "instance-in-flight",
      generation: "generation-in-flight",
    });
    let markHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    let releaseHandler!: () => void;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const server = await startLocalRpcServer({
      paths,
      sparkHome: join(root, ".spark"),
      db,
      forceCloseTimeoutMs: 10,
      onRestart: async () => {
        markHandlerStarted();
        await handlerBlocked;
        return lifecycle.requestRestart("2026-07-15T00:00:00.000Z", "restart-in-flight", {
          instanceId: "target-instance-in-flight",
          generation: "target-generation-in-flight",
        });
      },
    });
    const socket = createConnection(server.socketPath);
    socket.on("error", () => {
      // Forced transport close is expected while the handler remains blocked.
    });
    let handlerReleased = false;

    try {
      await once(socket, "connect");
      const socketClosed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      socket.write(`${JSON.stringify({ id: "restart_slow", method: "daemon.restart" })}\n`);
      await handlerStarted;

      let closeResolved = false;
      const closePromise = server.close().then(() => {
        closeResolved = true;
      });
      await socketClosed;
      await delay(0);
      expect(closeResolved).toBe(false);

      handlerReleased = true;
      releaseHandler();
      await closePromise;
      expect(closeResolved).toBe(true);
    } finally {
      if (!handlerReleased) releaseHandler();
      socket.destroy();
      await server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes idle accepted sockets instead of wedging daemon handoff", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-rpc-idle-"));
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
    const server = await startLocalRpcServer({ paths, sparkHome: join(root, ".spark"), db });
    const socket = createConnection(server.socketPath);

    try {
      await once(socket, "connect");
      const socketClosed = once(socket, "close");
      await server.close();
      await socketClosed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function notificationChannelStatus(
  workspaceId: string,
  adapters: Array<{ id: string; type: "feishu" | "infoflow" | "qqbot" }>,
): DaemonChannelIngressStatus {
  return {
    plane: "daemon",
    resource: "channel",
    workspaceId,
    configPath: `/tmp/${workspaceId}/channels/config.json`,
    available: true,
    configured: true,
    ingressEnabled: true,
    state: "running",
    adapters: adapters.map((adapter) => ({
      ...adapter,
      running: true,
      state: "connected" as const,
    })),
    routes: [],
    observedAt: "2026-07-15T00:00:00.000Z",
    text: `channels workspace=${workspaceId} running`,
  };
}
