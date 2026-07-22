import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { oc } from "@orpc/contract";
import type { RouterClient } from "@orpc/server";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { RPCLink } from "@orpc/client/message-port";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import {
  createUnixSocketMessagePortPair,
  type UnixSocketMessagePortPair,
} from "./socket-message-port.ts";

const probeContract = {
  ping: oc
    .route({ method: "GET", path: "/ping" })
    .input(z.object({}).default({}))
    .output(z.object({ pong: z.literal(true) })),
} as const;

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

  it("runs oRPC procedures over the socket MessagePort pair", async () => {
    const pair = await openPair();
    const os = implement(probeContract);
    const router = os.router({
      ping: os.ping.handler(async () => ({ pong: true as const })),
    });

    const handler = new RPCHandler(router);
    handler.upgrade(pair.server);

    const link = new RPCLink({ port: pair.client });
    const client: RouterClient<typeof router> = createORPCClient(link);

    await expect(client.ping({})).resolves.toEqual({ pong: true });
  });
});
