import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { CueClient } from "../packages/spark-cue/src/index.ts";

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function send(socket: Socket, id: number, ok: unknown): void {
  socket.write(encodeFrame({ type: "response", id, payload: { Ok: ok } }));
}

test("CueClient accepts a compatible v2 Pong without instance_id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cue-instance-id-"));
  const socketPath = join(dir, "cued.sock");
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) break;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as {
          id: number;
          payload: Record<string, unknown>;
        };
        buffer = buffer.subarray(4 + length);
        if ("Handshake" in request.payload) {
          send(socket, request.id, { Ack: {} });
        } else if ("Ping" in request.payload) {
          send(socket, request.id, {
            Pong: {
              version: "0.1.0",
              protocol_version: 2,
              capabilities: [
                "session-handshake-required",
                "script-item-created",
                "cancel-execution",
                "operation-idempotency",
                "script-info-recovery",
              ],
            },
          });
        }
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const client = await CueClient.connect(socketPath, {
      sessionId: "compat-session",
      cwd: dir,
    });
    assert.equal(client.daemonInstanceId, null);
    assert.equal(await client.pingForVersion(), "0.1.0");
    client.close();
    await client.closed;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { force: true, recursive: true });
  }
});
