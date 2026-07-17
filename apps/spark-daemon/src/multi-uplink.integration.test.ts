import { Buffer } from "node:buffer";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { createSparkDaemonUplinkControl, startSparkDaemon } from "./daemon.js";
import { upsertSparkDaemonServerProfile } from "./server-profiles.js";
import { openSparkDaemonDatabase } from "./store/schema.js";
import { registerWorkspace } from "./store/workspaces.js";

interface CapturedRuntimeFrame {
  type: string;
  runtimeId?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  payload?: {
    runtimeId?: string;
    reasonCode?: string;
    workspaceBindings?: Array<{ bindingId: string }>;
  };
}

interface TestCockpit {
  serverUrl: string;
  webSocketUrl: string;
  frames: CapturedRuntimeFrame[];
  authorizationHeaders: Array<string | undefined>;
  hello: ReturnType<typeof deferred<CapturedRuntimeFrame>>;
  heartbeat: ReturnType<typeof deferred<CapturedRuntimeFrame>>;
  commandReject: ReturnType<typeof deferred<CapturedRuntimeFrame>>;
  socket(): WebSocket;
  close(): Promise<void>;
}

describe("Spark daemon multi-Cockpit uplinks", () => {
  it("connects each server profile independently and keeps the other uplink alive", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-multi-uplink-"));
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "daemon.toml"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    const shutdown = new AbortController();
    const cockpitA = await startTestCockpit();
    const cockpitB = await startTestCockpit();
    let running: Promise<void> | undefined;

    try {
      const workspacePathA = join(root, "workspace-a");
      const workspacePathB = join(root, "workspace-b");
      mkdirSync(workspacePathA, { recursive: true });
      mkdirSync(workspacePathB, { recursive: true });

      const workspaceA = registerWorkspace(db, {
        serverUrl: cockpitA.serverUrl,
        serverWorkspaceId: "ws_11111111111141111111111111111111",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        localWorkspaceKey: "workspace-a",
        displayName: "Workspace A",
        localPath: workspacePathA,
      });
      const workspaceB = registerWorkspace(db, {
        serverUrl: cockpitB.serverUrl,
        serverWorkspaceId: "ws_22222222222242222222222222222222",
        serverBindingId: "rtwb_22222222222242222222222222222222",
        localWorkspaceKey: "workspace-b",
        displayName: "Workspace B",
        localPath: workspacePathB,
      });

      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: cockpitA.serverUrl,
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeToken: "runtime-token-a",
        webSocketUrl: cockpitA.webSocketUrl,
      });
      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: cockpitB.serverUrl,
        runtimeId: "rt_22222222222242222222222222222222",
        runtimeToken: "runtime-token-b",
        webSocketUrl: cockpitB.webSocketUrl,
      });

      running = startSparkDaemon({
        paths,
        sparkHome: join(root, "spark-home"),
        db,
        config: {
          installationId: "install-multi-uplink-test",
          displayName: "Multi-uplink test daemon",
          // A process may have started from a legacy tuple before this origin
          // was re-registered. The persisted per-server profile must win.
          serverUrl: cockpitA.serverUrl,
          runtimeId: "rt_99999999999949999999999999999999",
          runtimeToken: "stale-runtime-token-a",
          webSocketUrl: cockpitA.webSocketUrl,
        },
        signal: shutdown.signal,
        runScheduler: false,
        serverReconnectDelayMs: 60_000,
      });

      const [helloA, helloB] = await Promise.all([cockpitA.hello.promise, cockpitB.hello.promise]);
      await Promise.all([cockpitA.heartbeat.promise, cockpitB.heartbeat.promise]);

      expect(helloA.payload).toMatchObject({
        runtimeId: "rt_11111111111141111111111111111111",
        workspaceBindings: [{ bindingId: workspaceA.id }],
      });
      expect(helloA.payload?.workspaceBindings).toHaveLength(1);
      expect(helloB.payload).toMatchObject({
        runtimeId: "rt_22222222222242222222222222222222",
        workspaceBindings: [{ bindingId: workspaceB.id }],
      });
      expect(helloB.payload?.workspaceBindings).toHaveLength(1);
      expect(cockpitA.authorizationHeaders).toEqual(["Bearer runtime-token-a"]);
      expect(cockpitB.authorizationHeaders).toEqual(["Bearer runtime-token-b"]);

      const socketA = cockpitA.socket();
      const socketB = cockpitB.socket();
      const socketAClosed = once(socketA, "close");
      socketA.terminate();
      await socketAClosed;
      expect(socketB.readyState).toBe(WebSocket.OPEN);

      socketB.send(
        JSON.stringify({
          protocolVersion: runtimeProtocolVersion,
          messageId: createId("msg"),
          type: "server.command",
          sentAt: new Date().toISOString(),
          runtimeId: "rt_22222222222242222222222222222222",
          workspaceBindingId: workspaceB.id,
          workspaceId: "ws_99999999999949999999999999999999",
          projectId: "proj_22222222222242222222222222222222",
          commandId: createId("cmd"),
          payload: {
            kind: "task.start.request",
            title: "Probe surviving uplink",
            payload: { prompt: "This route mismatch must not execute." },
          },
        }),
      );

      await expect(cockpitB.commandReject.promise).resolves.toMatchObject({
        type: "runtime.command.reject",
        runtimeId: "rt_22222222222242222222222222222222",
        workspaceBindingId: workspaceB.id,
        payload: { reasonCode: "WORKSPACE_ROUTE_MISMATCH" },
      });
      expect(cockpitB.socket()).toBe(socketB);
      expect(socketB.readyState).toBe(WebSocket.OPEN);
    } finally {
      shutdown.abort();
      await running?.catch(() => undefined);
      await Promise.all([cockpitA.close(), cockpitB.close()]);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconfigures only the targeted Cockpit after its workspace routes change", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-targeted-uplink-reconfigure-"));
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "daemon.toml"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    const shutdown = new AbortController();
    const uplinkControl = createSparkDaemonUplinkControl();
    const cockpitA = await startTestCockpit();
    const cockpitB = await startTestCockpit();
    let running: Promise<void> | undefined;

    try {
      const workspacePathA1 = join(root, "workspace-a-1");
      const workspacePathA2 = join(root, "workspace-a-2");
      const workspacePathB = join(root, "workspace-b");
      mkdirSync(workspacePathA1, { recursive: true });
      mkdirSync(workspacePathA2, { recursive: true });
      mkdirSync(workspacePathB, { recursive: true });

      const workspaceA1 = registerWorkspace(db, {
        serverUrl: cockpitA.serverUrl,
        serverWorkspaceId: "ws_11111111111141111111111111111111",
        serverBindingId: "rtwb_11111111111141111111111111111111",
        localWorkspaceKey: "workspace-a-1",
        displayName: "Workspace A1",
        localPath: workspacePathA1,
      });
      const workspaceB = registerWorkspace(db, {
        serverUrl: cockpitB.serverUrl,
        serverWorkspaceId: "ws_22222222222242222222222222222222",
        serverBindingId: "rtwb_22222222222242222222222222222222",
        localWorkspaceKey: "workspace-b",
        displayName: "Workspace B",
        localPath: workspacePathB,
      });

      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: cockpitA.serverUrl,
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeToken: "runtime-token-a",
        webSocketUrl: cockpitA.webSocketUrl,
      });
      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: cockpitB.serverUrl,
        runtimeId: "rt_22222222222242222222222222222222",
        runtimeToken: "runtime-token-b",
        webSocketUrl: cockpitB.webSocketUrl,
      });

      running = startSparkDaemon({
        paths,
        sparkHome: join(root, "spark-home"),
        db,
        config: {
          installationId: "install-targeted-uplink-reconfigure-test",
          displayName: "Targeted uplink reconfigure test daemon",
        },
        signal: shutdown.signal,
        uplinkControl,
        runScheduler: false,
        serverReconnectDelayMs: 60_000,
      });

      await Promise.all([cockpitA.hello.promise, cockpitB.hello.promise]);
      await Promise.all([cockpitA.heartbeat.promise, cockpitB.heartbeat.promise]);

      const socketABefore = cockpitA.socket();
      const socketBBefore = cockpitB.socket();
      expect(cockpitA.authorizationHeaders).toHaveLength(1);
      expect(cockpitB.authorizationHeaders).toHaveLength(1);

      const workspaceA2 = registerWorkspace(db, {
        serverUrl: cockpitA.serverUrl,
        serverWorkspaceId: "ws_33333333333343333333333333333333",
        serverBindingId: "rtwb_33333333333343333333333333333333",
        localWorkspaceKey: "workspace-a-2",
        displayName: "Workspace A2",
        localPath: workspacePathA2,
      });
      uplinkControl.requestReconfigure(cockpitA.serverUrl);

      await waitUntil(() => cockpitA.authorizationHeaders.length === 2);
      await waitUntil(() => runtimeHelloFrames(cockpitA).length === 2);

      const reconfiguredHelloA = runtimeHelloFrames(cockpitA).at(-1);
      expect(
        reconfiguredHelloA?.payload?.workspaceBindings?.map(({ bindingId }) => bindingId),
      ).toEqual(expect.arrayContaining([workspaceA1.id, workspaceA2.id]));
      expect(reconfiguredHelloA?.payload?.workspaceBindings).toHaveLength(2);
      expect(cockpitA.socket()).not.toBe(socketABefore);
      expect(cockpitA.socket().readyState).toBe(WebSocket.OPEN);

      expect(cockpitB.authorizationHeaders).toHaveLength(1);
      expect(runtimeHelloFrames(cockpitB)).toHaveLength(1);
      expect(cockpitB.socket()).toBe(socketBBefore);
      expect(socketBBefore.readyState).toBe(WebSocket.OPEN);

      socketBBefore.send(
        JSON.stringify({
          protocolVersion: runtimeProtocolVersion,
          messageId: createId("msg"),
          type: "server.command",
          sentAt: new Date().toISOString(),
          runtimeId: "rt_22222222222242222222222222222222",
          workspaceBindingId: workspaceB.id,
          workspaceId: "ws_99999999999949999999999999999999",
          projectId: "proj_22222222222242222222222222222222",
          commandId: createId("cmd"),
          payload: {
            kind: "task.start.request",
            title: "Probe unaffected uplink",
            payload: { prompt: "This route mismatch must not execute." },
          },
        }),
      );

      await expect(cockpitB.commandReject.promise).resolves.toMatchObject({
        type: "runtime.command.reject",
        runtimeId: "rt_22222222222242222222222222222222",
        workspaceBindingId: workspaceB.id,
        payload: { reasonCode: "WORKSPACE_ROUTE_MISMATCH" },
      });
      expect(cockpitB.authorizationHeaders).toHaveLength(1);
      expect(cockpitB.socket()).toBe(socketBBefore);
      expect(socketBBefore.readyState).toBe(WebSocket.OPEN);
    } finally {
      shutdown.abort();
      await running?.catch(() => undefined);
      await Promise.all([cockpitA.close(), cockpitB.close()]);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function runtimeHelloFrames(cockpit: TestCockpit): CapturedRuntimeFrame[] {
  return cockpit.frames.filter((frame) => frame.type === "runtime.hello");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startTestCockpit(): Promise<TestCockpit> {
  const server = new WebSocketServer({ port: 0 });
  const frames: CapturedRuntimeFrame[] = [];
  const authorizationHeaders: Array<string | undefined> = [];
  const hello = deferred<CapturedRuntimeFrame>();
  const heartbeat = deferred<CapturedRuntimeFrame>();
  const commandReject = deferred<CapturedRuntimeFrame>();
  let connectedSocket: WebSocket | undefined;

  server.on("connection", (socket, request) => {
    connectedSocket = socket;
    authorizationHeaders.push(request.headers.authorization);
    socket.on("message", (data: RawData) => {
      const frame = JSON.parse(rawDataToString(data)) as CapturedRuntimeFrame;
      frames.push(frame);
      if (frame.type === "runtime.hello") {
        socket.send(
          JSON.stringify({
            protocolVersion: runtimeProtocolVersion,
            messageId: createId("msg"),
            type: "server.hello_ack",
            sentAt: new Date().toISOString(),
            payload: {
              runtimeSessionId: createId("rtsn"),
              acceptedFeatures: ["ws-control-v1"],
              heartbeatIntervalMs: 15_000,
              serverTime: new Date().toISOString(),
            },
          }),
        );
        hello.resolve(frame);
      } else if (frame.type === "runtime.heartbeat") {
        heartbeat.resolve(frame);
      } else if (frame.type === "runtime.command.reject") {
        commandReject.resolve(frame);
      }
    });
  });

  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected test Cockpit to listen on a TCP port");
  }
  const port = (address as AddressInfo).port;

  return {
    serverUrl: `http://127.0.0.1:${port}/`,
    webSocketUrl: `ws://127.0.0.1:${port}/runtime`,
    frames,
    authorizationHeaders,
    hello,
    heartbeat,
    commandReject,
    socket() {
      if (!connectedSocket) {
        throw new Error("test Cockpit has no active runtime connection");
      }
      return connectedSocket;
    },
    async close() {
      for (const client of server.clients) {
        client.terminate();
      }
      if (server.address() === null) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return "";
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
