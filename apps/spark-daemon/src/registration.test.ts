import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig, writeSparkDaemonConfig } from "./config.js";
import {
  ensureSparkDaemonRegistrationForWorkspace,
  verifySparkDaemonWorkspaceConnection,
} from "./registration.js";

describe("Spark daemon workspace registration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes an expiring runtime token before consuming an additional workspace grant", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-registration-"));
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
    writeSparkDaemonConfig(paths, {
      installationId: "install-test",
      displayName: "Test daemon",
      serverUrl: "http://127.0.0.1:5173",
      runtimeId: "rt_11111111111141111111111111111111",
      runtimeToken: "spark_rt_old_token_0000000000000000000000000000000",
      runtimeTokenExpiresAt: "2026-05-25T00:01:00.000Z",
      refreshToken: "spark_rt_refresh_old_000000000000000000000000000",
      refreshTokenExpiresAt: "2026-06-24T00:00:00.000Z",
      webSocketUrl:
        "ws://127.0.0.1:5173/api/v1/runtime/runtimes/rt_11111111111141111111111111111111/ws",
    });
    const fetchFn = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith("/token/refresh")) {
        return new Response(
          JSON.stringify({
            runtimeId: "rt_11111111111141111111111111111111",
            runtimeToken: "spark_rt_new_token_0000000000000000000000000000000",
            runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
            refreshToken: "spark_rt_refresh_new_000000000000000000000000000",
            refreshTokenExpiresAt: "2026-06-24T00:30:00.000Z",
            refreshedAt: "2026-05-25T00:30:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      expect(init?.headers).toMatchObject({
        authorization: "Bearer spark_rt_new_token_0000000000000000000000000000000",
      });
      return new Response(
        JSON.stringify({
          runtimeId: "rt_11111111111141111111111111111111",
          registeredAt: "2026-05-25T00:30:01.000Z",
          workspaceBinding: {
            workspaceId: "ws_22222222222241112222222222222222",
            bindingId: "rtwb_33333333333341113333333333333333",
            localWorkspaceKey: "spore",
            displayName: "spore",
            status: "indexing",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchFn);

    try {
      const registered = await ensureSparkDaemonRegistrationForWorkspace(paths, {
        serverUrl: "http://127.0.0.1:5173",
        registrationToken: "spark_wsreg_second",
        workspaceRegistration: {
          localWorkspaceKey: "spore",
          displayName: "spore",
        },
      });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(registered.workspaceBinding).toMatchObject({
        bindingId: "rtwb_33333333333341113333333333333333",
        status: "indexing",
      });
      expect(readSparkDaemonConfig(paths)).toMatchObject({
        runtimeToken: "spark_rt_new_token_0000000000000000000000000000000",
        refreshToken: "spark_rt_refresh_new_000000000000000000000000000",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("confirms the server WebSocket with runtime.hello before local commit", async () => {
    const received: unknown[] = [];
    const fakeSocket = new FakeRegistrationSocket((data) => {
      received.push(JSON.parse(data) as unknown);
      fakeSocket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            protocolVersion: runtimeProtocolVersion,
            messageId: createId("msg"),
            type: "server.hello_ack",
            sentAt: "2026-05-26T00:00:00.000Z",
            payload: {
              runtimeSessionId: "rtsn_44444444444441114444444444444444",
              acceptedFeatures: [],
              heartbeatIntervalMs: 15_000,
              serverTime: "2026-05-26T00:00:00.000Z",
            },
          }),
        ),
      );
    });
    const createWebSocket = vi.fn((url: string, options: { headers: Record<string, string> }) => {
      expect(url).toBe("ws://127.0.0.1:5173/runtime/ws");
      expect(options.headers.Authorization).toBe(
        "Bearer spark_rt_token_00000000000000000000000000000000",
      );
      return fakeSocket;
    });

    const verification = verifySparkDaemonWorkspaceConnection({
      config: {
        installationId: "install-test",
        displayName: "Test daemon",
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeToken: "spark_rt_token_00000000000000000000000000000000",
        webSocketUrl: "ws://127.0.0.1:5173/runtime/ws",
      },
      workspaceBinding: {
        workspaceId: "ws_22222222222241112222222222222222",
        bindingId: "rtwb_33333333333341113333333333333333",
        localWorkspaceKey: "spore",
        displayName: "spore",
        status: "indexing",
      },
      timeoutMs: 1_000,
      createWebSocket,
    });
    fakeSocket.emit("open");
    await verification;

    expect(createWebSocket).toHaveBeenCalledOnce();
    expect(received[0]).toMatchObject({
      type: "runtime.hello",
      payload: {
        runtimeId: "rt_11111111111141111111111111111111",
        workspaceBindings: [
          {
            bindingId: "rtwb_33333333333341113333333333333333",
            localWorkspaceKey: "spore",
            displayName: "spore",
            status: "indexing",
          },
        ],
      },
    });
  });
});

type FakeRegistrationEvent = "open" | "message" | "error" | "close";

class FakeRegistrationSocket {
  private listeners = new Map<FakeRegistrationEvent, Array<(...args: never[]) => void>>();
  private readonly onSend: (data: string) => void;

  constructor(onSend: (data: string) => void) {
    this.onSend = onSend;
  }

  on(event: "open", listener: () => void): FakeRegistrationSocket;
  on(event: "message", listener: (data: Buffer) => void): FakeRegistrationSocket;
  on(event: "error", listener: (error: Error) => void): FakeRegistrationSocket;
  on(event: "close", listener: () => void): FakeRegistrationSocket;
  on(event: FakeRegistrationEvent, listener: (...args: never[]) => void): FakeRegistrationSocket {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  send(data: string): void {
    this.onSend(data);
  }

  close(): void {}

  emit(event: "open"): void;
  emit(event: "message", data: Buffer): void;
  emit(event: "error", error: Error): void;
  emit(event: "close"): void;
  emit(event: FakeRegistrationEvent, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}
