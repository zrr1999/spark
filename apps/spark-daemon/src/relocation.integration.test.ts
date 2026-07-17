import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type RawData } from "ws";
import { expect, test } from "vitest";

import {
  createId,
  runtimeProtocolVersion,
  type RuntimeRegistrationRequest,
} from "@zendev-lab/spark-protocol";
import {
  createCockpitSnapshot,
  ensureCockpitInstanceId,
  migrate,
  openDatabase,
  openMemoryDatabase,
} from "@zendev-lab/spark-db";
import {
  createRuntimeEnrollmentToken,
  preflightRuntimeRelocation,
  registerRuntime,
} from "@zendev-lab/spark-coordination/runtime-registration";
import {
  attachRuntimeWebSocket,
  authenticateRuntimeToken,
} from "@zendev-lab/spark-coordination/runtime-ws";
import { resolveSparkPaths } from "@zendev-lab/spark-system";

import { createSparkDaemonUplinkControl, startSparkDaemon } from "./daemon.ts";
import type { DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import { writeSparkDaemonConfig } from "./config.ts";
import { relocateSparkDaemonCockpit } from "./relocation.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import {
  ensureLocalWorkspace,
  registerWorkspace,
  sparkDaemonServerStatusSummaries,
} from "./store/workspaces.ts";

const instanceId = "cockpit_11111111111111111111111111111111";
const installationId = "install-live-relocation";

interface CockpitHarness {
  db: DatabaseSync;
  server: ReturnType<typeof createHttpsServer>;
  wss: WebSocketServer;
  origin: string;
  frames: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

test("live daemon relocates between snapshot-restored HTTPS/WSS Cockpits without restarting", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-live-relocation-"));
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const sourceDb = openMemoryDatabase();
  let targetDb: DatabaseSync | undefined;
  let daemonDb: DatabaseSync | undefined;
  let source: CockpitHarness | undefined;
  let target: CockpitHarness | undefined;
  let daemonRun: Promise<void> | undefined;
  const shutdown = new AbortController();
  const releaseInvocation = deferred<void>();
  const invocationStarted = deferred<void>();
  try {
    migrate(sourceDb);
    ensureCockpitInstanceId(sourceDb, { instanceId });
    const enrollment = createRuntimeEnrollmentToken(sourceDb, {
      label: "Live relocation fixture",
      createdAt: new Date().toISOString(),
    });
    const registered = registerRuntime(
      sourceDb,
      {
        installationId,
        displayName: "Live relocation daemon",
        runtimeVersion: "0.1.0-test",
        supportedFeatures: ["reconcile-v1", "command-routing-v1"],
        labels: { acceptance: "relocation" },
        workspaceRegistration: {
          localWorkspaceKey: "source-owned",
          localPath: join(root, "source-owned"),
          displayName: "Source owned",
        },
      } satisfies RuntimeRegistrationRequest,
      enrollment.refreshToken,
    );
    if (!registered.workspaceBinding) throw new Error("fixture workspace binding is missing");

    const snapshotPath = join(root, "snapshot");
    await createCockpitSnapshot({ sourceDb, destination: snapshotPath });
    targetDb = openDatabase({ path: join(snapshotPath, "cockpit.sqlite") });
    const tls = createTestCertificate(root);
    source = await startCockpit(sourceDb, tls, false);
    target = await startCockpit(targetDb, tls, true);

    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "daemon-data"),
        configFile: join(root, "daemon-config", "daemon.toml"),
        cacheDir: join(root, "daemon-cache"),
        stateDir: join(root, "daemon-state"),
        runtimeDir: join(root, "daemon-runtime"),
      },
    });
    daemonDb = openSparkDaemonDatabase(paths);
    await Promise.all([
      mkdir(join(root, "source-owned"), { recursive: true }),
      mkdir(join(root, "local-only"), { recursive: true }),
      mkdir(join(root, "third-origin"), { recursive: true }),
    ]);
    const sourceWorkspace = registerWorkspace(daemonDb, {
      serverUrl: source.origin,
      localPath: join(root, "source-owned"),
      serverBindingId: registered.workspaceBinding.bindingId,
      serverWorkspaceId: workspaceIdForBinding(sourceDb, registered.workspaceBinding.bindingId),
      localWorkspaceKey: "source-owned",
      displayName: "Source owned",
      workspaceName: "Source owned",
      workspaceSlug: "source-owned",
    });
    const localWorkspace = ensureLocalWorkspace(daemonDb, {
      localPath: join(root, "local-only"),
      localWorkspaceKey: "local-only",
    });
    const thirdWorkspace = registerWorkspace(daemonDb, {
      serverUrl: "https://third.example.test/",
      localPath: join(root, "third-origin"),
      serverBindingId: "rtwb_33333333333333333333333333333333",
      serverWorkspaceId: "ws_33333333333333333333333333333333",
      localWorkspaceKey: "third-origin",
      displayName: "Third origin",
      workspaceName: "Third origin",
      workspaceSlug: "third-origin",
    });
    writeSparkDaemonConfig(paths, {
      installationId,
      displayName: "Live relocation daemon",
      serverUrl: source.origin,
      runtimeId: registered.runtimeId,
      runtimeToken: registered.runtimeToken,
      runtimeTokenExpiresAt: registered.runtimeTokenExpiresAt,
      refreshToken: registered.refreshToken,
      refreshTokenExpiresAt: registered.refreshTokenExpiresAt,
      webSocketUrl: `${source.origin.replace(/^https:/u, "wss:")}runtime`,
    });

    const uplinkControl = createSparkDaemonUplinkControl();
    daemonRun = startSparkDaemon({
      paths,
      db: daemonDb,
      config: {
        installationId,
        displayName: "Live relocation daemon",
        serverUrl: source.origin,
        runtimeId: registered.runtimeId,
        runtimeToken: registered.runtimeToken,
        runtimeTokenExpiresAt: registered.runtimeTokenExpiresAt,
        refreshToken: registered.refreshToken,
        refreshTokenExpiresAt: registered.refreshTokenExpiresAt,
        webSocketUrl: `${source.origin.replace(/^https:/u, "wss:")}runtime`,
      },
      signal: shutdown.signal,
      uplinkControl,
      channelIngress: inertChannelIngress(),
      schedulerPollIntervalMs: 5,
      serverReconnectDelayMs: 5,
      executeInvocation: async () => {
        invocationStarted.resolve(undefined);
        await releaseInvocation.promise;
        return { text: "completed across Cockpit relocation" };
      },
    });

    await waitForFrame(source.frames, "runtime.heartbeat");
    await waitForFrame(source.frames, "runtime.reconcile.report");
    const daemonPidBefore = Number(readFileSync(paths.pidFile, "utf8").trim());
    const store = new SparkInvocationStore(daemonDb);
    const invocation = store.submit({
      workspaceBindingId: sourceWorkspace.id,
      sessionId: "relocation-live-session",
      prompt: "stay active during Cockpit relocation",
      task: {
        type: "session.run",
        sessionId: "relocation-live-session",
        prompt: "stay active during Cockpit relocation",
      },
    });
    await invocationStarted.promise;

    const failureEvidence: Array<Record<string, unknown>> = [];
    for (const scenario of [
      "instance-mismatch",
      "runtime-missing",
      "token-rejected",
      "runtime-mismatch",
      "target-unreachable",
      "local-transaction-fault",
    ] as const) {
      const before = localStateDigest(paths.configFile, daemonDb);
      let reconfigureCount = 0;
      await expect(
        relocateSparkDaemonCockpit(
          paths,
          daemonDb,
          { fromServerUrl: source.origin, toServerUrl: target.origin },
          {
            fetchFn: relocationFailureFetch(scenario, {
              sourceOrigin: source.origin,
              targetOrigin: target.origin,
              runtimeId: registered.runtimeId,
            }),
            ...(scenario === "local-transaction-fault"
              ? {
                  beforeCommit: () => {
                    throw new Error("injected live transaction fault");
                  },
                }
              : {}),
            onUplinkReconfigure: () => {
              reconfigureCount += 1;
            },
          },
        ),
      ).rejects.toThrow();
      const after = localStateDigest(paths.configFile, daemonDb);
      expect(after).toBe(before);
      expect(reconfigureCount).toBe(0);
      expect(source.wss.clients.size).toBe(1);
      expect(sourceServerConnected(daemonDb, source.origin)).toBe(true);
      failureEvidence.push({
        scenario,
        localStateBefore: before,
        localStateAfter: after,
        sourceHeartbeatCount: frameCount(source.frames, "runtime.heartbeat"),
        sourceClientCount: source.wss.clients.size,
        sourceConnected: true,
      });
    }
    daemonDb
      .prepare(
        `INSERT INTO daemon_servers
          (id, server_url, first_registered_at, protocol_version)
         VALUES ('rnsv_collision', ?, ?, ?)`,
      )
      .run(target.origin, new Date().toISOString(), runtimeProtocolVersion);
    const collisionDigest = localStateDigest(paths.configFile, daemonDb);
    await expect(
      relocateSparkDaemonCockpit(
        paths,
        daemonDb,
        { fromServerUrl: source.origin, toServerUrl: target.origin },
        { fetchFn: (() => Promise.reject(new Error("network must not run"))) as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "RELOCATION_TARGET_COLLISION" });
    const collisionAfter = localStateDigest(paths.configFile, daemonDb);
    expect(collisionAfter).toBe(collisionDigest);
    expect(source.wss.clients.size).toBe(1);
    expect(sourceServerConnected(daemonDb, source.origin)).toBe(true);
    failureEvidence.push({
      scenario: "target-collision",
      localStateBefore: collisionDigest,
      localStateAfter: collisionAfter,
      sourceHeartbeatCount: frameCount(source.frames, "runtime.heartbeat"),
      sourceClientCount: source.wss.clients.size,
      sourceConnected: true,
    });
    daemonDb.prepare("DELETE FROM daemon_servers WHERE id = 'rnsv_collision'").run();
    expect(failureEvidence).toHaveLength(7);
    console.log(`SPARK_RELOCATION_FAILURE_EVIDENCE ${JSON.stringify(failureEvidence)}`);

    const sourceHeartbeatCountBefore = frameCount(source.frames, "runtime.heartbeat");
    const relocation = await relocateSparkDaemonCockpit(
      paths,
      daemonDb,
      { fromServerUrl: source.origin, toServerUrl: target.origin },
      { onUplinkReconfigure: () => uplinkControl.requestReconfigure() },
    );
    await waitForFrame(target.frames, "runtime.heartbeat");
    await waitForFrame(target.frames, "runtime.reconcile.report");
    const daemonPidAfter = Number(readFileSync(paths.pidFile, "utf8").trim());

    expect(daemonPidBefore).toBe(process.pid);
    expect(daemonPidAfter).toBe(daemonPidBefore);
    expect(relocation).toMatchObject({
      instanceId,
      installationId,
      runtimeId: registered.runtimeId,
      fromServerUrl: source.origin,
      toServerUrl: target.origin,
      workspaceBindingIds: [sourceWorkspace.id],
      workspaceCount: 1,
    });
    expect(frameCount(source.frames, "runtime.hello")).toBe(1);
    expect(frameCount(source.frames, "runtime.reconcile.report")).toBeGreaterThanOrEqual(1);
    expect(frameCount(target.frames, "runtime.hello")).toBe(1);
    expect(frameCount(target.frames, "runtime.reconcile.report")).toBeGreaterThanOrEqual(1);
    expect(frameBindingIds(source.frames)).toEqual(new Set([sourceWorkspace.id]));
    expect(frameBindingIds(target.frames)).toEqual(new Set([sourceWorkspace.id]));
    expect(frameBindingIds(source.frames)).not.toContain(localWorkspace.id);
    expect(frameBindingIds(source.frames)).not.toContain(thirdWorkspace.id);
    expect(frameBindingIds(target.frames)).not.toContain(localWorkspace.id);
    expect(frameBindingIds(target.frames)).not.toContain(thirdWorkspace.id);

    releaseInvocation.resolve(undefined);
    await waitForInvocationStatus(target.frames, invocation.invocationId, "succeeded");
    await waitUntil(() => store.require(invocation.invocationId).status === "succeeded");
    expect(store.require(invocation.invocationId)).toMatchObject({
      status: "succeeded",
      result: { text: "completed across Cockpit relocation" },
    });
    expect(hasInvocationStatus(source.frames, invocation.invocationId, "succeeded")).toBe(false);
    await waitUntil(() => source!.wss.clients.size === 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frameCount(source.frames, "runtime.heartbeat")).toBe(sourceHeartbeatCountBefore);
    expect(frameCount(target.frames, "runtime.heartbeat")).toBeGreaterThanOrEqual(1);
    expect(target.wss.clients.size).toBe(1);
    expect(existsSync(join(paths.runtimeDir, "daemon.sock"))).toBe(false);
    expect(
      targetDb
        .prepare("SELECT installation_id AS installationId FROM runtime_connections WHERE id = ?")
        .get(registered.runtimeId),
    ).toEqual({ installationId });
    expect(
      targetDb
        .prepare("SELECT id FROM runtime_workspace_bindings WHERE id = ?")
        .get(sourceWorkspace.id),
    ).toEqual({ id: sourceWorkspace.id });
    expect(sparkDaemonServerStatusSummaries(daemonDb)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: target.origin, wsConnected: true, workspaceCount: 1 }),
        expect.objectContaining({
          url: "https://third.example.test/",
          wsConnected: false,
          workspaceCount: 1,
        }),
      ]),
    );
    console.log(
      `SPARK_RELOCATION_SUCCESS_EVIDENCE ${JSON.stringify({
        sourceInstanceId: ensureCockpitInstanceId(sourceDb),
        targetInstanceId: ensureCockpitInstanceId(targetDb),
        installationId,
        runtimeId: registered.runtimeId,
        bindingId: sourceWorkspace.id,
        daemonPidBefore,
        daemonPidAfter,
        invocationId: invocation.invocationId,
        invocationStatus: store.require(invocation.invocationId).status,
        sourceHeartbeatCount: frameCount(source.frames, "runtime.heartbeat"),
        targetHeartbeatCount: frameCount(target.frames, "runtime.heartbeat"),
        sourceClientCount: source.wss.clients.size,
        targetClientCount: target.wss.clients.size,
        sourceBindingIds: [...frameBindingIds(source.frames)],
        targetBindingIds: [...frameBindingIds(target.frames)],
        localBindingId: localWorkspace.id,
        thirdOriginBindingId: thirdWorkspace.id,
        daemonSocketUsed: existsSync(join(paths.runtimeDir, "daemon.sock")),
      })}`,
    );
  } finally {
    shutdown.abort();
    releaseInvocation.resolve(undefined);
    await daemonRun?.catch(() => undefined);
    await source?.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
    daemonDb?.close();
    targetDb?.close();
    sourceDb.close();
    if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
    await rm(root, { recursive: true, force: true });
  }
});

async function startCockpit(
  db: DatabaseSync,
  tls: { key: Buffer; cert: Buffer },
  acceptsPreflight: boolean,
): Promise<CockpitHarness> {
  const frames: Array<Record<string, unknown>> = [];
  let origin = "";
  const server = createHttpsServer(tls, (request, response) => {
    void handleCockpitRequest(db, origin, acceptsPreflight, request, response);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const runtimeId = runtimeIdFromDb(db);
    const tokenId = authenticateRuntimeToken(db, runtimeId, request.headers.authorization);
    if (!tokenId || request.url !== "/runtime") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (data: RawData) => {
        const parsed = JSON.parse(rawDataText(data)) as Record<string, unknown>;
        frames.push(parsed);
      });
      attachRuntimeWebSocket(ws, {
        db,
        runtimeId,
        secureTransport: true,
        remoteAddress: request.socket.remoteAddress,
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    db,
    server,
    wss,
    origin,
    frames,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  };
}

async function handleCockpitRequest(
  db: DatabaseSync,
  origin: string,
  acceptsPreflight: boolean,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET" && request.url === "/api/v1/runtime/relocation/metadata") {
    sendJson(response, 200, {
      instanceId: ensureCockpitInstanceId(db),
      protocolVersion: runtimeProtocolVersion,
    });
    return;
  }
  if (request.method === "POST" && request.url === "/api/v1/runtime/relocation/preflight") {
    if (!acceptsPreflight) {
      sendJson(response, 409, {
        error: { code: "relocation_source_only", message: "source only" },
      });
      return;
    }
    try {
      const input = JSON.parse(await requestBody(request)) as {
        sourceInstanceId?: string;
        runtimeId: string;
        installationId: string;
        refreshToken: string;
      };
      if (input.sourceInstanceId !== ensureCockpitInstanceId(db)) {
        sendJson(response, 409, {
          error: { code: "relocation_instance_mismatch", message: "instance mismatch" },
        });
        return;
      }
      const refreshed = preflightRuntimeRelocation(db, input);
      sendJson(response, 200, {
        instanceId: ensureCockpitInstanceId(db),
        ...refreshed,
        webSocketUrl: `${origin.replace(/^https:/u, "wss:")}runtime`,
      });
    } catch (error) {
      const reasonCode =
        error && typeof error === "object" && "reasonCode" in error
          ? String(error.reasonCode)
          : "relocation_preflight_failed";
      sendJson(response, reasonCode === "REFRESH_TOKEN_INVALID" ? 401 : 409, {
        error: {
          code: reasonCode.toLowerCase(),
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return;
  }
  sendJson(response, 404, { error: { code: "not_found", message: "not found" } });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function relocationFailureFetch(
  scenario:
    | "instance-mismatch"
    | "runtime-missing"
    | "token-rejected"
    | "runtime-mismatch"
    | "target-unreachable"
    | "local-transaction-fault",
  context: { sourceOrigin: string; targetOrigin: string; runtimeId: string },
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (scenario === "target-unreachable" && url.origin === new URL(context.targetOrigin).origin) {
      throw new Error("injected target unreachable");
    }
    if (url.pathname.endsWith("/relocation/metadata")) {
      return Response.json({
        instanceId:
          scenario === "instance-mismatch" && url.origin === new URL(context.targetOrigin).origin
            ? "cockpit_22222222222222222222222222222222"
            : instanceId,
        protocolVersion: runtimeProtocolVersion,
      });
    }
    if (url.pathname.endsWith("/relocation/preflight")) {
      if (scenario === "runtime-missing" || scenario === "token-rejected") {
        return Response.json(
          {
            error: {
              code:
                scenario === "runtime-missing"
                  ? "relocation_runtime_not_found"
                  : "refresh_token_invalid",
              message: `injected ${scenario}`,
            },
          },
          { status: scenario === "token-rejected" ? 401 : 409 },
        );
      }
      const runtimeId =
        scenario === "runtime-mismatch" ? "rt_22222222222222222222222222222222" : context.runtimeId;
      const nonce = randomUUID().replaceAll("-", "");
      return Response.json({
        instanceId,
        runtimeId,
        runtimeToken: `runtime-token-failure-${nonce}`,
        runtimeTokenExpiresAt: "2099-07-15T01:00:00.000Z",
        refreshToken: `refresh-token-failure-${nonce}`,
        refreshTokenExpiresAt: "2099-08-15T00:00:00.000Z",
        refreshedAt: "2026-07-15T00:00:00.000Z",
        webSocketUrl: `${context.targetOrigin.replace(/^https:/u, "wss:")}runtime`,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function localStateDigest(configFile: string, db: DatabaseSync): string {
  const tables = [
    "workspaces",
    "daemon_servers",
    "daemon_server_credentials",
    "daemon_workspaces",
    "daemon_relocation_audit",
  ];
  return createHash("sha256")
    .update(
      JSON.stringify(
        {
          config: readFileSync(configFile, "utf8"),
          tables: tables.map((table) => ({
            table,
            rows: db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
          })),
        },
        (_key, value) => (typeof value === "bigint" ? Number(value) : value),
      ),
    )
    .digest("hex");
}

function sourceServerConnected(db: DatabaseSync, serverUrl: string): boolean {
  const row = db
    .prepare(
      `SELECT last_connected_at AS lastConnectedAt,
              last_disconnect_reason AS lastDisconnectReason
       FROM daemon_servers
       WHERE server_url = ?`,
    )
    .get(serverUrl) as
    | { lastConnectedAt: string | null; lastDisconnectReason: string | null }
    | undefined;
  return Boolean(row?.lastConnectedAt && !row.lastDisconnectReason);
}

function runtimeIdFromDb(db: DatabaseSync): string {
  const row = db.prepare("SELECT id FROM runtime_connections ORDER BY created_at LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!row) throw new Error("fixture runtime is missing");
  return row.id;
}

function workspaceIdForBinding(db: DatabaseSync, bindingId: string): string {
  const row = db
    .prepare(
      `SELECT workspace_id AS workspaceId
       FROM workspace_owner_bindings
       WHERE runtime_workspace_binding_id = ? AND ended_at IS NULL`,
    )
    .get(bindingId) as { workspaceId: string | null } | undefined;
  if (!row?.workspaceId) throw new Error("fixture workspace owner is missing");
  return row.workspaceId;
}

function inertChannelIngress(): DaemonChannelIngressRuntime {
  const unsupported = async () => {
    throw new Error("inert channel fixture does not support this operation");
  };
  return {
    start: async () => [],
    stop: async () => {},
    status: () => {
      throw new Error("inert channel fixture has no workspace status");
    },
    configure: unsupported,
    reload: unsupported,
    notify: unsupported,
    openReplyStream: async () => undefined,
    sendReply: unsupported,
    sendAsk: unsupported,
    ackInteraction: unsupported,
    listWorkspaceIds: async () => [],
  } as unknown as DaemonChannelIngressRuntime;
}

function frameCount(frames: Array<Record<string, unknown>>, type: string): number {
  return frames.filter((frame) => frame.type === type).length;
}

function frameBindingIds(frames: Array<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const frame of frames) {
    if (typeof frame.workspaceBindingId === "string") ids.add(frame.workspaceBindingId);
    const payload = recordValue(frame.payload);
    const bindings = payload?.workspaceBindings;
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      const record = recordValue(binding);
      if (typeof record?.bindingId === "string") ids.add(record.bindingId);
    }
  }
  return ids;
}

async function waitForFrame(frames: Array<Record<string, unknown>>, type: string): Promise<void> {
  await waitUntil(() => frames.some((frame) => frame.type === type));
}

async function waitForInvocationStatus(
  frames: Array<Record<string, unknown>>,
  invocationId: string,
  status: string,
): Promise<void> {
  await waitUntil(() => hasInvocationStatus(frames, invocationId, status));
}

function hasInvocationStatus(
  frames: Array<Record<string, unknown>>,
  invocationId: string,
  status: string,
): boolean {
  return frames.some((frame) => {
    if (frame.type !== "invocation.updated") return false;
    const payload = recordValue(frame.payload);
    return payload?.runtimeInvocationId === invocationId && payload.status === status;
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for relocation acceptance state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rawDataText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function createTestCertificate(root: string): { key: Buffer; cert: Buffer } {
  const keyPath = join(root, "tls.key");
  const certPath = join(root, "tls.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
