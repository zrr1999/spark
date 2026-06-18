import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CueClient,
  CueError,
  __resetPiCueClientForTests,
  type PiCueExtensionApi,
  registerPiCueTools,
  resolveCueTransport,
} from "../packages/pi-cue/src/index.ts";

type CueFrame = Record<string, unknown>;
type RegisteredPiCueTool = Parameters<PiCueExtensionApi["registerTool"]>[0];

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

async function startCueServer(
  handler: (message: CueFrame, socket: Socket) => void,
): Promise<{ socketPath: string; requests: CueFrame[]; close: () => Promise<void> }> {
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
  return {
    socketPath,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { force: true, recursive: true });
    },
  };
}

function handleHandshake(message: CueFrame, socket: Socket): boolean {
  const id = message.id as number;
  const payload = requestPayload(message);
  if ("Handshake" in payload) {
    sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
    return true;
  }
  return false;
}

function findPayload(requests: CueFrame[], key: string): Record<string, unknown> {
  const request = requests.find((candidate) => key in requestPayload(candidate));
  assert.ok(request, `expected ${key} request`);
  return requestPayload(request);
}

async function withCueServer(
  handler: (message: CueFrame, socket: Socket) => void,
  run: (client: CueClient, requests: CueFrame[]) => Promise<void>,
): Promise<void> {
  const server = await startCueServer((message, socket) => {
    if (handleHandshake(message, socket)) return;
    handler(message, socket);
  });
  const client = await CueClient.connect(server.socketPath);
  try {
    await run(client, server.requests);
  } finally {
    client.close();
    await server.close();
  }
}

function requestPayload(message: CueFrame): Record<string, unknown> {
  assert.equal(message.type, "request");
  assert.equal(typeof message.id, "number");
  const payload = message.payload;
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
  return payload as Record<string, unknown>;
}

function registerCueToolsForProtocolTest(): Map<string, RegisteredPiCueTool> {
  const tools = new Map<string, RegisteredPiCueTool>();
  registerPiCueTools({
    registerTool: (config) => tools.set(config.name, config),
  });
  return tools;
}

function singleJobCueServer(label: string) {
  return (message: CueFrame, socket: Socket) => {
    if (handleHandshake(message, socket)) return;
    const id = message.id as number;
    const payload = requestPayload(message);
    if ("Subscribe" in payload) {
      sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
      return;
    }
    if ("Eval" in payload) {
      sendFrame(socket, {
        type: "response",
        id,
        payload: {
          Ok: {
            JobCreated: {
              job_id: `J-${label}`,
              open_hint: "fg",
              warnings: [],
            },
          },
        },
      });
      return;
    }
    if ("ListJobs" in payload) {
      sendFrame(socket, {
        type: "response",
        id,
        payload: {
          Ok: {
            JobList: [
              {
                id: `J-${label}`,
                status: "Running",
                pipeline: label,
                open_hint: "fg",
              },
            ],
          },
        },
      });
    }
  };
}

void test("CueClient.connect sends session handshake before normal requests", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Ping" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: { Ok: { Pong: { version: "9.9.9" } } },
        });
      }
    },
    async (client, requests) => {
      const firstPayload = requestPayload(requests[0]!);
      assert.ok("Handshake" in firstPayload, "first client request must bind a cue session");
      const handshake = firstPayload.Handshake as Record<string, unknown>;
      assert.equal(typeof handshake.session_id, "string");
      assert.equal(typeof handshake.cwd, "string");
      assert.ok(handshake.env && typeof handshake.env === "object");

      assert.equal(await client.pingForVersion(), "9.9.9");
    },
  );
});

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

void test("pi-cue tools reconnect when the resolved transport profile changes", async () => {
  const first = await startCueServer(singleJobCueServer("first"));
  const second = await startCueServer(singleJobCueServer("second"));
  const selector = await mkdtemp(join(tmpdir(), "pi-cue-target-selector-"));
  const selectorFile = join(selector, "target");
  try {
    await writeFile(selectorFile, "first", "utf8");
    await withTempPath(
      {
        "cue-client": `#!/bin/sh
case "$(cat "$PI_CUE_TARGET_SELECTOR")" in
  first) printf '%s\n' '{"schema_version":1,"profile_name":"first","transport":"unix","socket_path":"${first.socketPath}"}' ;;
  second) printf '%s\n' '{"schema_version":1,"profile_name":"second","transport":"unix","socket_path":"${second.socketPath}"}' ;;
  *) echo unknown target >&2; exit 2 ;;
esac
`,
      },
      async () => {
        const originalSelector = process.env.PI_CUE_TARGET_SELECTOR;
        process.env.PI_CUE_TARGET_SELECTOR = selectorFile;
        try {
          const tools = registerCueToolsForProtocolTest();
          const execTool = tools.get("cue_exec");
          assert.ok(execTool);
          await execTool.execute(
            "first-call",
            { command: "echo first", background: true },
            new AbortController().signal,
            () => undefined,
            { cwd: "/work" },
          );
          await writeFile(selectorFile, "second", "utf8");
          await execTool.execute(
            "second-call",
            { command: "echo second", background: true },
            new AbortController().signal,
            () => undefined,
            { cwd: "/work" },
          );
          assert.ok(
            first.requests.some((request) => JSON.stringify(request).includes("echo first")),
          );
          assert.equal(
            first.requests.some((request) => JSON.stringify(request).includes("echo second")),
            false,
          );
          assert.ok(
            second.requests.some((request) => JSON.stringify(request).includes("echo second")),
          );
        } finally {
          if (originalSelector === undefined) delete process.env.PI_CUE_TARGET_SELECTOR;
          else process.env.PI_CUE_TARGET_SELECTOR = originalSelector;
        }
      },
    );
  } finally {
    __resetPiCueClientForTests();
    await first.close();
    await second.close();
    await rm(selector, { force: true, recursive: true });
  }
});

void test("implicit CueClient.connect supports ssh resolver profiles through gateway stdio", async () => {
  await withTempPath(
    {
      "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"remote","transport":"ssh","destination":"devbox","gateway_command":"cued gateway --stdio","start_command":"cued start"}'\n`,
      ssh: `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.SSH_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
let buffer = Buffer.alloc(0);
function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32BE(0);
    if (buffer.length < 4 + len) return;
    const message = JSON.parse(buffer.subarray(4, 4 + len).toString("utf8"));
    buffer = buffer.subarray(4 + len);
    if (message.payload && message.payload.Handshake) {
      process.stdout.write(frame({
        type: "response",
        id: message.id,
        payload: { Ok: { Ack: {} } },
      }));
    }
    if (message.payload && message.payload.Ping) {
      process.stdout.write(frame({
        type: "response",
        id: message.id,
        payload: { Ok: { Pong: { version: "9.9.9" } } },
      }));
    }
  }
});
`,
    },
    async (dir) => {
      const argsPath = join(dir, "ssh-args.json");
      const originalArgsFile = process.env.SSH_ARGS_FILE;
      process.env.SSH_ARGS_FILE = argsPath;
      try {
        const client = await CueClient.connect();
        assert.equal(await client.pingForVersion(), "9.9.9");
        client.close();
        assert.deepEqual(JSON.parse(await readFile(argsPath, "utf8")), [
          "devbox",
          "cued gateway --stdio",
        ]);
      } finally {
        if (originalArgsFile === undefined) delete process.env.SSH_ARGS_FILE;
        else process.env.SSH_ARGS_FILE = originalArgsFile;
      }
    },
  );
});

void test("implicit CueClient.connect fails ssh profiles without local daemon autostart", async () => {
  await withTempPath(
    {
      "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"remote","transport":"ssh","destination":"devbox","gateway_command":"cued gateway --stdio","start_command":"cued start"}'\n`,
      ssh: `#!/bin/sh\nsleep 0.05\necho 'remote cued socket missing' >&2\nexit 42\n`,
    },
    async () => {
      await assert.rejects(
        CueClient.connect(),
        (error) =>
          error instanceof CueError &&
          error.code === "DAEMON_UNREACHABLE" &&
          error.message.includes("remote") &&
          error.message.includes("devbox") &&
          error.message.includes("cued start") &&
          error.message.includes("remote cued socket missing"),
      );
    },
  );
});

void test("ssh connection errors keep bounded trailing stderr diagnostics", async () => {
  await withTempPath(
    {
      "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"remote","transport":"ssh","destination":"devbox","gateway_command":"cued gateway --stdio","start_command":"cued start"}'\n`,
      ssh: `#!/usr/bin/env node
process.stderr.write(
  "old-prefix-" + "x".repeat(70 * 1024) + "tail-diagnostic: remote gateway failed",
  () => process.exit(42),
);
`,
    },
    async () => {
      await assert.rejects(
        CueClient.connect(),
        (error) =>
          error instanceof CueError &&
          error.code === "DAEMON_UNREACHABLE" &&
          !error.message.includes("old-prefix") &&
          error.message.includes("tail-diagnostic: remote gateway failed") &&
          // Runtime keeps a 64 KiB stderr tail and wraps it with fixed SSH profile guidance.
          error.message.length < 68 * 1024,
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
      const scriptPayload = findPayload(requests, "RunScript");
      assert.deepEqual(scriptPayload.RunScript, { path: "build.cue", input: ":run echo ok" });
      assert.equal(
        "mode" in (scriptPayload.RunScript as Record<string, unknown>),
        false,
        "RunScript must not send deprecated mode",
      );
    },
  );
});

void test("cue eval encodes resource needs as run mode params", async () => {
  await withCueServer(
    () => undefined,
    async (client, requests) => {
      await client.eval("echo ok", "Job", {
        cwd: "/tmp/work dir",
        needs: { gpu: 1, gpu_mem: "24GiB" },
        pty: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const payload = findPayload(requests, "Eval");
      assert.deepEqual(payload.Eval, {
        input: ':run(pty=false,cwd="/tmp/work dir",need.gpu=1,need.gpu_mem=24GiB) echo ok',
        mode: "Job",
      });
    },
  );
});

void test("cue runJob resolves serial chains after a failed leaf skips later leaves", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload) {
        sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
        return;
      }
      if ("Eval" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              ChainCreated: {
                chain_id: "CH1",
                job_ids: ["J1"],
                warnings: [],
                chain: {
                  id: "CH1",
                  pipeline: "true -> false -> echo skipped",
                  total_jobs: 3,
                  jobs: [
                    { index: 0, pipeline: "true", status: "Running", job_id: "J1" },
                    { index: 1, pipeline: "false", status: "Pending" },
                    { index: 2, pipeline: "echo skipped", status: "Pending" },
                  ],
                },
              },
            },
          },
        });
        setTimeout(() => {
          sendFrame(socket, {
            type: "event",
            payload: {
              ChainProgress: {
                chain: {
                  id: "CH1",
                  pipeline: "true -> false -> echo skipped",
                  total_jobs: 3,
                  jobs: [
                    { index: 0, pipeline: "true", status: "Done", job_id: "J1" },
                    { index: 1, pipeline: "false", status: "Failed", job_id: "J2" },
                    {
                      index: 2,
                      pipeline: "echo skipped",
                      status: { Cancelled: "ChainAborted" },
                    },
                  ],
                },
              },
            },
          });
          sendFrame(socket, {
            type: "event",
            payload: {
              JobStateChanged: {
                job_id: "J1",
                old_state: "Running",
                new_state: "Done",
                end_scope: null,
                chain_id: "CH1",
                chain_index: 0,
              },
            },
          });
          sendFrame(socket, {
            type: "event",
            payload: {
              JobStateChanged: {
                job_id: "J2",
                old_state: "Running",
                new_state: "Failed",
                end_scope: null,
                chain_id: "CH1",
                chain_index: 1,
              },
            },
          });
        }, 10);
        return;
      }
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
                    pipeline: "true",
                    exit_code: 0,
                    start_scope: null,
                    end_scope: null,
                    open_hint: "stream",
                    chain_id: "CH1",
                    chain_index: 0,
                    chain_total: 3,
                  },
                  {
                    id: "J2",
                    status: "Failed",
                    pipeline: "false",
                    exit_code: 1,
                    start_scope: null,
                    end_scope: null,
                    open_hint: "stream",
                    chain_id: "CH1",
                    chain_index: 1,
                    chain_total: 3,
                  },
                ],
                page: { total: 2, shown: 2, limit: null, truncated: false },
              },
            },
          },
        });
        return;
      }
      if ("JobOutput" in payload) {
        const jobOutput = payload.JobOutput as { id: string };
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              JobOutput: {
                id: jobOutput.id,
                stdout: { data: "", truncated: false },
                stderr: { data: "", truncated: false },
                stderr_pty_merged: false,
              },
            },
          },
        });
      }
    },
    async (client) => {
      const result = await client.runJob("true -> false -> echo skipped", { timeout: 2 });

      assert.equal(result.timedOut, false);
      assert.equal(result.status, "Failed");
      assert.equal(result.exitCode, 1);
    },
  );
});

void test("cue job output treats daemon no-output responses as empty output", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("JobOutput" in payload || "Eval" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: { Err: { code: "NOT_FOUND", message: "no output found for J1" } },
        });
      }
    },
    async (client) => {
      assert.deepEqual(await client.jobOutput("J1", 1024), {
        stdout: "",
        stderr: "",
        truncated: false,
      });
      assert.deepEqual(await client.jobError("J1", 1024), {
        stderr: "",
        truncated: false,
      });
    },
  );
});

void test("cue typed list, output, and log responses are parsed", async () => {
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
                    pending_reason: "license: busy",
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
        return;
      }
      if ("ShowLog" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: { Ok: { TextOutput: { text: "recent log\n", truncated: false } } },
        });
      }
    },
    async (client, requests) => {
      const typedRequests = () =>
        requests.filter((request) => !("Handshake" in requestPayload(request)));

      const jobs = await client.listJobs(1);
      assert.deepEqual(
        requestPayload(typedRequests()[0]!).ListJobs,
        { limit: 1 },
        "listJobs should use typed ListJobs",
      );
      assert.equal(jobs[0]?.id, "J1");
      assert.equal(jobs[0]?.pending_reason, "license: busy");

      const output = await client.jobOutput("J1", 1024);
      assert.deepEqual(requestPayload(typedRequests()[1]!).JobOutput, {
        id: "J1",
        stdout_bytes: 1024,
        stderr_bytes: 1024,
      });
      assert.deepEqual(output, { stdout: "ok\n", stderr: "warn\n", truncated: false });

      const log = await client.showLog("J1", 10, 2048);
      assert.deepEqual(requestPayload(typedRequests()[2]!).ShowLog, {
        id: "J1",
        limit: 10,
        tail_bytes: 2048,
      });
      assert.equal(log, "recent log\n");

      const stderr = await client.jobError("J1", 512);
      assert.deepEqual(requestPayload(typedRequests()[3]!).JobOutput, {
        id: "J1",
        stdout_bytes: null,
        stderr_bytes: 512,
      });
      assert.deepEqual(stderr, { stderr: "warn\n", truncated: true });
    },
  );
});
