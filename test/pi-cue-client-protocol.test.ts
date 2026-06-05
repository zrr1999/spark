import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CueClient } from "../packages/pi-cue/src/index.ts";

type CueFrame = Record<string, unknown>;

function encodeFrame(message: CueFrame): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function sendFrame(socket: Socket, message: CueFrame): void {
  socket.write(encodeFrame(message));
}

async function withCueServer(
  handler: (message: CueFrame, socket: Socket) => void,
  run: (client: CueClient, requests: CueFrame[]) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cue-protocol-"));
  const socketPath = join(dir, "cued.sock");
  const requests: CueFrame[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) break;
        const body = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        const message = JSON.parse(body.toString("utf8")) as CueFrame;
        requests.push(message);
        handler(message, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const client = await CueClient.connect(socketPath);
  try {
    await run(client, requests);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { force: true, recursive: true });
  }
}

function requestPayload(message: CueFrame): Record<string, unknown> {
  assert.equal(message.type, "request");
  assert.equal(typeof message.id, "number");
  const payload = message.payload;
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
  return payload as Record<string, unknown>;
}

void test("cue RunScript request matches the current strict daemon schema", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload) {
        sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
        return;
      }
      if ("RunScript" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              ScriptCreated: {
                script_id: "R1",
                source: { kind: "file", path: "build.cue" },
                items: [],
                submit_error: null,
              },
            },
          },
        });
        sendFrame(socket, {
          type: "event",
          payload: {
            ScriptFinished: {
              script_id: "R1",
              status: "done",
              exit_code: 0,
              failed_item_index: null,
            },
          },
        });
      }
    },
    async (client, requests) => {
      const result = await client.runScript({ path: "build.cue", input: ":run echo ok" });

      assert.equal(result.scriptId, "R1");
      const scriptPayload = requestPayload(requests[1]!);
      assert.deepEqual(scriptPayload.RunScript, { path: "build.cue", input: ":run echo ok" });
      assert.equal(
        "mode" in (scriptPayload.RunScript as Record<string, unknown>),
        false,
        "RunScript must not send deprecated mode",
      );
    },
  );
});

void test("cue typed list and output responses are parsed", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("ListJobs" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              JobListPage: {
                jobs: [
                  {
                    id: "J1",
                    status: "Done",
                    pipeline: "echo ok",
                    exit_code: 0,
                    start_scope: null,
                    end_scope: null,
                    open_hint: "stream",
                    chain_id: null,
                    chain_index: null,
                    chain_total: null,
                  },
                ],
                page: { total: 1, shown: 1, limit: 1, truncated: false },
              },
            },
          },
        });
        return;
      }
      if ("JobOutput" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              JobOutput: {
                id: "J1",
                stdout: { data: "ok\n", truncated: false },
                stderr: { data: "warn\n", truncated: true },
                stderr_pty_merged: false,
              },
            },
          },
        });
      }
    },
    async (client, requests) => {
      const jobs = await client.listJobs(1);
      assert.deepEqual(
        requestPayload(requests[0]!).ListJobs,
        { limit: 1 },
        "listJobs should use typed ListJobs",
      );
      assert.equal(jobs[0]?.id, "J1");

      const output = await client.jobOutput("J1", 1024);
      assert.deepEqual(requestPayload(requests[1]!).JobOutput, {
        id: "J1",
        stdout_bytes: 1024,
        stderr_bytes: 1024,
      });
      assert.deepEqual(output, { stdout: "ok\n", stderr: "warn\n", truncated: false });
    },
  );
});
