import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CueClient, CueError, resolveCueTransport } from "../packages/pi-cue/src/index.ts";

type CueFrame = Record<string, unknown>;

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function withTempPath(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cue-resolver-"));
  const originalPath = process.env.PATH;
  try {
    for (const [name, body] of Object.entries(files)) {
      await writeExecutable(join(dir, name), body);
    }
    process.env.PATH = originalPath ? `${dir}:${originalPath}` : dir;
    await run(dir);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(dir, { force: true, recursive: true });
  }
}

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

void test("resolveCueTransport uses cue-client target resolver JSON", async () => {
  await withTempPath(
    {
      "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"local","transport":"unix","socket_path":"/tmp/custom-cued.sock"}'\n`,
    },
    async () => {
      const resolved = await resolveCueTransport();
      assert.deepEqual(resolved, {
        schema_version: 1,
        profile_name: "local",
        transport: "unix",
        socket_path: "/tmp/custom-cued.sock",
      });
    },
  );
});

void test("resolveCueTransport falls back to cue client namespace", async () => {
  await withTempPath(
    {
      "cue-client": `#!/bin/sh\necho cue-client unavailable >&2\nexit 127\n`,
      cue: `#!/bin/sh\nif [ "$1 $2 $3 $4" = "client target resolve --json" ]; then\n  printf '%s\n' '{"schema_version":1,"profile_name":"fallback","transport":"unix","socket_path":"/tmp/fallback.sock"}'\n  exit 0\nfi\necho unexpected args: "$@" >&2\nexit 2\n`,
    },
    async () => {
      const resolved = await resolveCueTransport();
      assert.equal(resolved.transport, "unix");
      assert.equal(resolved.profile_name, "fallback");
      assert.equal(resolved.socket_path, "/tmp/fallback.sock");
    },
  );
});

void test("implicit CueClient.connect rejects ssh resolver profiles without autostart", async () => {
  await withTempPath(
    {
      "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"remote","transport":"ssh","destination":"devbox","gateway_command":"cued gateway --stdio","start_command":"cued start"}'\n`,
    },
    async () => {
      await assert.rejects(
        CueClient.connect(),
        (error) =>
          error instanceof CueError &&
          error.code === "UNSUPPORTED_TRANSPORT" &&
          error.message.includes("remote") &&
          error.message.includes("devbox"),
      );
    },
  );
});

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
