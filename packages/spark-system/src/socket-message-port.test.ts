import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { RPCLink } from "@orpc/client/message-port";
import { sparkLocalRpcOrpcContract } from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  createUnixSocketMessagePortPair,
  type UnixSocketMessagePortPair,
} from "./socket-message-port.ts";

describe("Unix socket MessagePort adapter", () => {
  const fixtures: UnixSocketMessagePortPair[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) await fixture.close();
    }
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function openPair(): Promise<UnixSocketMessagePortPair> {
    const dir = mkdtempSync(join(tmpdir(), "spark-socket-port-"));
    dirs.push(dir);
    const pair = await createUnixSocketMessagePortPair(join(dir, "orpc.sock"));
    fixtures.push(pair);
    return pair;
  }

  it("delivers postMessage payloads bidirectionally over a Unix socket", async () => {
    const pair = await openPair();
    const fromServer = new Promise<unknown>((resolve) => {
      pair.client.on("message", (event) => resolve(event.data));
    });
    const fromClient = new Promise<unknown>((resolve) => {
      pair.server.on("message", (event) => resolve(event.data));
    });

    pair.server.postMessage({ hello: "client" });
    pair.client.postMessage({ hello: "server" });

    await expect(fromServer).resolves.toEqual({ hello: "client" });
    await expect(fromClient).resolves.toEqual({ hello: "server" });
  });

  it("emits close when either side closes", async () => {
    const pair = await openPair();
    const closed = new Promise<void>((resolve) => {
      pair.client.on("close", () => resolve());
    });
    pair.server.close();
    await closed;
  });

  it("runs oRPC contract procedures over the socket MessagePort pair", async () => {
    const pair = await openPair();
    const observedAt = "2026-07-21T13:00:00.000Z";

    const os = implement(sparkLocalRpcOrpcContract);
    const router = os.router({
      daemon: {
        status: os.daemon.status.handler(async () => ({
          lifecycle: { state: "running" as const },
          observedAt,
        })),
        stop: os.daemon.stop.handler(async () => ({
          stopping: true as const,
          observedAt,
        })),
      },
      workspace: {
        list: os.workspace.list.handler(async () => ({
          workspaces: [{ id: "ws_1", localPath: "/tmp/spark" }],
          observedAt,
        })),
      },
      uplink: {
        status: os.uplink.status.handler(async () => ({
          origins: [{ serverUrl: "https://example.test", preferred: true }],
        })),
      },
      model: {
        catalog: os.model.catalog.handler(async () => ({
          providers: [],
          diagnostics: [],
        })),
      },
    });

    const handler = new RPCHandler(router);
    handler.upgrade(pair.server);

    const link = new RPCLink({ port: pair.client });
    const client: RouterClient<typeof router> = createORPCClient(link);

    await expect(client.daemon.status({})).resolves.toEqual({
      lifecycle: { state: "running" },
      observedAt,
    });
    await expect(client.workspace.list({})).resolves.toEqual({
      workspaces: [{ id: "ws_1", localPath: "/tmp/spark" }],
      observedAt,
    });
    await expect(client.uplink.status({})).resolves.toEqual({
      origins: [{ serverUrl: "https://example.test", preferred: true }],
    });
    await expect(client.model.catalog({})).resolves.toEqual({
      providers: [],
      diagnostics: [],
    });
    await expect(client.daemon.stop({})).resolves.toEqual({
      stopping: true,
      observedAt,
    });
  });
});
