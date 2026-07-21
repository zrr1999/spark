import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  CueClient,
  CueError,
  __resetSparkCueClientForTests,
  cueOperationId,
  isRetryableCueTransportError,
  type SparkCueHostApi,
  registerSparkCueTools,
  resolveCueTransport,
} from "../index.ts";

type CueFrame = Record<string, unknown>;
type RegisteredSparkCueTool = Parameters<SparkCueHostApi["registerTool"]>[0];
type SparkCueEventHandler = (event?: unknown, ctx?: unknown) => unknown;

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function withTempPath(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spark-cue-resolver-"));
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

class SynchronousCueStream extends EventEmitter {
  #closed = false;

  write(frame: Buffer): boolean {
    const length = frame.readUInt32BE(0);
    const request = JSON.parse(frame.subarray(4, 4 + length).toString("utf8")) as CueFrame;
    const payload = requestPayload(request);
    if ("ListJobs" in payload) {
      this.emit(
        "data",
        encodeFrame({
          type: "response",
          id: request.id,
          payload: {
            Ok: {
              JobList: [wireJob({ id: "J-sync" })],
            },
          },
        }),
      );
    }
    return true;
  }

  destroy(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    if (error) this.emit("error", error);
    this.emit("close");
  }
}

class RecordingCueStream extends EventEmitter {
  readonly requests: CueFrame[] = [];
  readonly respondSynchronously: boolean;
  #closed = false;

  constructor(respondSynchronously: boolean) {
    super();
    this.respondSynchronously = respondSynchronously;
  }

  write(frame: Buffer): boolean {
    const length = frame.readUInt32BE(0);
    const request = JSON.parse(frame.subarray(4, 4 + length).toString("utf8")) as CueFrame;
    this.requests.push(request);
    if (!this.respondSynchronously) return true;
    const payload = requestPayload(request);
    const ok = "ListJobs" in payload ? { JobList: [] } : { Ack: {} };
    this.emit("data", encodeFrame({ type: "response", id: request.id, payload: { Ok: ok } }));
    return true;
  }

  destroy(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    if (error) this.emit("error", error);
    this.emit("close");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startCueServer(
  handler: (message: CueFrame, socket: Socket) => void,
  capabilities = [
    "session-handshake-required",
    "script-item-created",
    "cancel-execution",
    "operation-idempotency",
    "script-info-recovery",
  ],
  instanceId: string | ((connection: number) => string) = "00000000-0000-4000-8000-000000000001",
  pong: { generation_id?: string; ready?: boolean } = {},
): Promise<{
  socketPath: string;
  requests: CueFrame[];
  handshakes: CueFrame[];
  connectionCount: () => number;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "spark-cue-protocol-"));
  const socketPath = join(dir, "cued.sock");
  const requests: CueFrame[] = [];
  const handshakes: CueFrame[] = [];
  let connectionCount = 0;
  const server = net.createServer((socket) => {
    connectionCount += 1;
    const connection = connectionCount;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) break;
        const body = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        const message = JSON.parse(body.toString("utf8")) as CueFrame;
        const payload = requestPayload(message);
        if ("Handshake" in payload) {
          handshakes.push(message);
          sendFrame(socket, {
            type: "response",
            id: message.id as number,
            payload: { Ok: { Ack: {} } },
          });
          continue;
        }
        if ("Ping" in payload) {
          sendFrame(socket, {
            type: "response",
            id: message.id as number,
            payload: {
              Ok: {
                Pong: {
                  version: "9.9.9",
                  protocol_version: 2,
                  capabilities,
                  instance_id:
                    typeof instanceId === "function" ? instanceId(connection) : instanceId,
                  ...(pong.generation_id ? { generation_id: pong.generation_id } : {}),
                  ...(pong.ready !== undefined ? { ready: pong.ready } : {}),
                },
              },
            },
          });
          continue;
        }
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
    handshakes,
    connectionCount: () => connectionCount,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { force: true, recursive: true });
    },
  };
}

async function withCueServer(
  handler: (message: CueFrame, socket: Socket) => void,
  run: (client: CueClient, requests: CueFrame[], handshakes: CueFrame[]) => Promise<void>,
): Promise<void> {
  const server = await startCueServer(handler);
  const client = await CueClient.connect(server.socketPath);
  try {
    await run(client, server.requests, server.handshakes);
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

function wireJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "J1",
    status: "Done",
    pipeline: "true",
    exit_code: 0,
    start_scope: null,
    end_scope: null,
    open_hint: "stream",
    chain_id: null,
    chain_index: null,
    chain_total: null,
    ...overrides,
  };
}

function wireJobCreated(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: "J1",
    start_scope: null,
    open_hint: "stream",
    chain_id: null,
    chain_index: null,
    chain_total: null,
    warnings: [],
    ...overrides,
  };
}

function wireChainJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 0,
    pipeline: "true",
    status: "Pending",
    job_id: null,
    start_scope: null,
    end_scope: null,
    open_hint: null,
    ...overrides,
  };
}

function registerCueToolsForProtocolTest(
  eventHandlers?: Map<string, SparkCueEventHandler[]>,
): Map<string, RegisteredSparkCueTool> {
  const tools = new Map<string, RegisteredSparkCueTool>();
  registerSparkCueTools({
    registerTool: (config) => tools.set(config.name, config),
    on: eventHandlers
      ? (event, handler) => {
          const handlers = eventHandlers.get(event) ?? [];
          handlers.push(handler);
          eventHandlers.set(event, handlers);
        }
      : undefined,
  });
  return tools;
}

async function emitCueEvent(
  eventHandlers: Map<string, SparkCueEventHandler[]>,
  event: string,
  ctx?: unknown,
): Promise<void> {
  for (const handler of eventHandlers.get(event) ?? []) await handler({}, ctx);
}

function toolParameterProperties(
  tool: RegisteredSparkCueTool | undefined,
): Record<string, unknown> {
  assert.ok(tool, "expected tool to be registered");
  const parameters = tool.parameters as { properties?: Record<string, unknown> };
  assert.ok(parameters.properties, "expected object parameter schema");
  return parameters.properties;
}

test("cue exec family tools currently skip requiresApproval (temporary local override)", () => {
  const tools = registerCueToolsForProtocolTest();
  for (const name of [
    "cue_exec",
    "cue_run",
    "cue_script",
    "script_run",
    "script_eval",
    "cue_jobs",
    "cue_schedule",
  ]) {
    assert.equal(
      tools.get(name)?.requiresApproval,
      undefined,
      `${name} should not require approval`,
    );
    assert.equal(tools.get(name)?.policy?.effect, "external_write", name);
    assert.equal(tools.get(name)?.effect, "external_write", `${name} legacy effect mirror`);
    assert.equal(tools.get(name)?.executionMode, "sequential", `${name} execution mode`);
    assert.equal(tools.get(name)?.policy?.approval, "none", `${name} approval policy`);
  }
  assert.equal(tools.get("cue_resources")?.requiresApproval, undefined);
  assert.equal(tools.get("cue_history")?.requiresApproval, undefined);
  assert.equal(tools.get("cue_scope")?.requiresApproval, undefined);
  for (const name of ["cue_resources", "cue_history"]) {
    assert.equal(tools.get(name)?.effect, "read", name);
    assert.equal(tools.get(name)?.executionMode, "parallel", name);
    assert.equal(tools.get(name)?.policy?.approval, "none", name);
  }
  assert.equal(tools.get("cue_scope")?.effect, "external_write");
  assert.equal(tools.get("cue_scope")?.executionMode, "sequential");
});

test("spark-cue session_start removes bash only from the current active subset", async () => {
  const eventHandlers = new Map<string, SparkCueEventHandler[]>();
  let activeTools = ["bash", "cue_history", "third_party_read"];
  const registeredTools: string[] = [];
  registerSparkCueTools({
    registerTool: (config) => registeredTools.push(config.name),
    on: (event, handler) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = [...names];
    },
  });

  assert.equal(registeredTools.includes("cue_exec"), true);
  assert.equal(activeTools.includes("cue_exec"), false, "cue_exec starts inactive in this fixture");
  await emitCueEvent(eventHandlers, "session_start");
  assert.deepEqual(activeTools, ["cue_history", "third_party_read"]);
});

test("CueClient registers pending responses before a synchronous stream write", async () => {
  const client = new CueClient(new SynchronousCueStream());
  try {
    const jobs = await client.listJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.id, "J-sync");
    assert.equal(jobs[0]?.exit_code, 0);
  } finally {
    client.close();
    await client.closed;
  }
});

test("cue operation ids are deterministic, bounded, and isolate step/session identity", () => {
  const base = { sessionId: "session-a", toolCallId: "tool-42", kind: "cue_exec/submit" };
  const id = cueOperationId(base);
  assert.equal(cueOperationId({ ...base }), id);
  assert.notEqual(cueOperationId({ ...base, kind: "cue_exec/cancel" }), id);
  assert.notEqual(cueOperationId({ ...base, sessionId: "session-b" }), id);
  assert.ok(Buffer.byteLength(id, "utf8") <= 128);
  assert.ok(Buffer.byteLength(cueOperationId({ ...base, toolCallId: "x".repeat(20_000) })) <= 128);
});

test("CueClient emits operation_id only for explicitly keyed daemon-global side effects", async () => {
  const stream = new RecordingCueStream(true);
  const client = new CueClient(stream);
  const operation = { sessionId: "s", toolCallId: "t", kind: "eval" };
  try {
    await client.eval("true", "Job", { operation });
    await client.listJobs();
    assert.equal(stream.requests[0]?.operation_id, cueOperationId(operation));
    assert.equal(Object.hasOwn(stream.requests[1]!, "operation_id"), false);
  } finally {
    client.close();
    await client.closed;
  }
});

test("CueClient bounds unclaimed synchronous responses instead of leaking pending entries", async () => {
  const stream = new RecordingCueStream(true);
  const client = new CueClient(stream);
  try {
    await client.eval("true");
    assert.equal(CueClient.__pendingRequestCountForTests(client), 1);
    await delay(150);
    assert.equal(CueClient.__pendingRequestCountForTests(client), 0);
  } finally {
    client.close();
    await client.closed;
  }
});

test("CueClient request ids wrap without reusing occupied ids", async () => {
  const stream = new RecordingCueStream(false);
  const client = new CueClient(stream);
  try {
    CueClient.__setNextRequestIdForTests(client, 0xffff_ffff);
    await client.eval("one");
    await client.eval("two");
    CueClient.__setNextRequestIdForTests(client, 0xffff_ffff);
    await client.eval("three");
    assert.deepEqual(
      stream.requests.map((request) => request.id),
      [0xffff_ffff, 1, 2],
    );
  } finally {
    client.close();
    await client.closed;
  }
});

test("CueClient fails closed at the bounded pending-request cap", async () => {
  const client = new CueClient(new RecordingCueStream(false));
  try {
    for (let index = 0; index < 1_024; index += 1) await client.eval(`job-${index}`);
    await assert.rejects(
      client.eval("overflow"),
      (error) => error instanceof CueError && error.code === "CLIENT_REQUEST_LIMIT",
    );
  } finally {
    client.close();
    await client.closed;
  }
});

test("CueClient.connect sends session Handshake before protocol Ping", async () => {
  const server = await startCueServer(() => undefined);
  const client = await CueClient.connect(server.socketPath, {
    sessionId: "test-session",
    cwd: "/workspace/project",
    env: { PATH: "/bin", EMPTY: undefined },
  });
  try {
    assert.equal(server.handshakes.length, 1);
    const handshake = requestPayload(server.handshakes[0]!);
    assert.deepEqual(handshake.Handshake, {
      session_id: "test-session",
      cwd: "/workspace/project",
      env: { PATH: "/bin" },
      refresh: false,
    });

    await client.handshake({
      sessionId: "test-session",
      cwd: "/workspace/project-node26",
      env: { PATH: "/node26/bin" },
      refresh: true,
    });
    assert.equal(server.handshakes.length, 2);
    const refresh = requestPayload(server.handshakes[1]!);
    assert.deepEqual(refresh.Handshake, {
      session_id: "test-session",
      cwd: "/workspace/project-node26",
      env: { PATH: "/node26/bin" },
      refresh: true,
    });
  } finally {
    client.close();
    await server.close();
  }
});

test("CueClient.connect rejects daemons without required Pong protocol fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cue-old-protocol-"));
  const socketPath = join(dir, "cued.sock");
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
        const payload = requestPayload(message);
        if ("Handshake" in payload) {
          sendFrame(socket, {
            type: "response",
            id: message.id as number,
            payload: { Ok: { Ack: {} } },
          });
        }
        if ("Ping" in payload) {
          sendFrame(socket, {
            type: "response",
            id: message.id as number,
            payload: { Ok: { Pong: { version: "0.1.0" } } },
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
    await assert.rejects(
      CueClient.connect(socketPath, { sessionId: "old-daemon", cwd: "/tmp" }),
      (error) =>
        error instanceof CueError &&
        error.code === "UNSUPPORTED_PROTOCOL" &&
        error.message.includes("protocol_version") &&
        error.message.includes("upgrade/restart cued"),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { force: true, recursive: true });
  }
});

test("CueClient.connect treats Pong ready=false as a retryable startup race", async () => {
  const server = await startCueServer(
    () => undefined,
    undefined,
    "00000000-0000-4000-8000-000000000001",
    {
      generation_id: "00000000-0000-4000-8000-000000000002",
      ready: false,
    },
  );
  try {
    await assert.rejects(
      CueClient.connect(server.socketPath, { sessionId: "starting-daemon", cwd: "/tmp" }),
      (error) =>
        isRetryableCueTransportError(error) &&
        error.message.includes("daemon is still starting") &&
        error.message.includes("retry"),
    );
  } finally {
    await server.close();
  }
});

test("CueClient.connect rejects v2 daemons without cancel-execution", async () => {
  const server = await startCueServer(
    () => undefined,
    ["session-handshake-required", "script-item-created"],
  );
  try {
    await assert.rejects(
      CueClient.connect(server.socketPath, { sessionId: "stale-v2", cwd: "/tmp" }),
      (error) =>
        error instanceof CueError &&
        error.code === "UNSUPPORTED_PROTOCOL" &&
        error.message.includes("cancel-execution") &&
        error.message.includes("upgrade/restart cued"),
    );
  } finally {
    await server.close();
  }
});

test("CueClient.connect fails closed without operation-idempotency", async () => {
  const server = await startCueServer(
    () => undefined,
    ["session-handshake-required", "script-item-created", "cancel-execution"],
  );
  try {
    await assert.rejects(
      CueClient.connect(server.socketPath, { sessionId: "no-idempotency", cwd: "/tmp" }),
      (error) =>
        error instanceof CueError &&
        error.code === "UNSUPPORTED_PROTOCOL" &&
        error.message.includes("operation-idempotency"),
    );
  } finally {
    await server.close();
  }
});

test("CueClient.connect fails closed without script-info-recovery", async () => {
  const server = await startCueServer(
    () => undefined,
    [
      "session-handshake-required",
      "script-item-created",
      "cancel-execution",
      "operation-idempotency",
    ],
  );
  try {
    await assert.rejects(
      CueClient.connect(server.socketPath, { sessionId: "no-script-recovery", cwd: "/tmp" }),
      (error) =>
        error instanceof CueError &&
        error.code === "UNSUPPORTED_PROTOCOL" &&
        error.message.includes("script-info-recovery"),
    );
  } finally {
    await server.close();
  }
});

test("CueClient rejects malformed and unknown response variants and closes the connection", async () => {
  const fixtures: Array<{
    name: string;
    response: (id: number) => CueFrame;
    message: RegExp;
  }> = [
    {
      name: "non-u32 response id",
      response: () => ({
        type: "response",
        id: "1",
        payload: { Ok: { JobList: [] } },
      }),
      message: /response envelope\.id/,
    },
    {
      name: "unknown success variant",
      response: (id) => ({
        type: "response",
        id,
        payload: { Ok: { ChainStarted: { chain_id: "CH1" } } },
      }),
      message: /unknown protocol variant ChainStarted/,
    },
    {
      name: "multiple success variants",
      response: (id) => ({
        type: "response",
        id,
        payload: { Ok: { Ack: {}, JobList: [] } },
      }),
      message: /exactly one protocol variant/,
    },
    {
      name: "unknown job status",
      response: (id) => ({
        type: "response",
        id,
        payload: {
          Ok: {
            JobList: [wireJob({ status: "Quantum" })],
          },
        },
      }),
      message: /unknown job status/,
    },
    {
      name: "unknown open hint",
      response: (id) => ({
        type: "response",
        id,
        payload: {
          Ok: {
            JobList: [wireJob({ open_hint: "window" })],
          },
        },
      }),
      message: /expected one of stream, fg/,
    },
  ];

  for (const fixture of fixtures) {
    const server = await startCueServer((message, socket) => {
      if ("ListJobs" in requestPayload(message)) {
        sendFrame(socket, fixture.response(message.id as number));
      }
    });
    const client = await CueClient.connect(server.socketPath);
    try {
      await assert.rejects(
        client.listJobs(),
        (error) => error instanceof Error && fixture.message.test(error.message),
        fixture.name,
      );
      await client.closed;
      assert.equal(client.isClosed, true, fixture.name);
    } finally {
      client.close();
      await server.close();
    }
  }
});

test("CueClient rejects unknown event variants and missing ScriptCreated source", async () => {
  const unknownEventServer = await startCueServer((message, socket) => {
    if ("ListJobs" in requestPayload(message)) {
      sendFrame(socket, { type: "event", payload: { DaemonReady: {} } });
    }
  });
  const unknownEventClient = await CueClient.connect(unknownEventServer.socketPath);
  try {
    await assert.rejects(
      unknownEventClient.listJobs(),
      (error) =>
        error instanceof Error && error.message.includes("unknown protocol variant DaemonReady"),
    );
    await unknownEventClient.closed;
  } finally {
    unknownEventClient.close();
    await unknownEventServer.close();
  }

  const missingSourceServer = await startCueServer((message, socket) => {
    const id = message.id as number;
    const payload = requestPayload(message);
    if ("Subscribe" in payload) {
      sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
    } else if ("RunScript" in payload) {
      sendFrame(socket, {
        type: "response",
        id,
        payload: {
          Ok: {
            ScriptCreated: {
              script_id: "R-missing-source",
              items: [],
              submit_error: null,
            },
          },
        },
      });
    }
  });
  const missingSourceClient = await CueClient.connect(missingSourceServer.socketPath);
  try {
    await assert.rejects(
      missingSourceClient.runScript({ path: "build.cue", input: "" }),
      (error) => error instanceof Error && error.message.includes("ScriptCreated.source"),
    );
    await missingSourceClient.closed;
  } finally {
    missingSourceClient.close();
    await missingSourceServer.close();
  }
});

test("CueClient supports canonical foreground, completion, highlight, cron, and fg payloads", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("FgAttach" in payload) {
        sendFrame(socket, { type: "response", id, payload: { Ok: { FgAttached: { id: "J1" } } } });
      } else if ("FgInput" in payload || "FgResize" in payload || "FgDetach" in payload) {
        sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
      } else if ("Complete" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              CompletionList: {
                items: [
                  { label: ":run", insert_text: ":run", kind: "Command", detail: "Run a job" },
                ],
              },
            },
          },
        });
      } else if ("Highlight" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: { HighlightResult: { spans: [{ start: 0, end: 4, kind: "CommandName" }] } },
          },
        });
        sendFrame(socket, {
          type: "event",
          payload: { CronTriggered: { cron_id: "C1", job_id: "J2" } },
        });
        sendFrame(socket, { type: "event", payload: { CronRemoved: { cron_id: "C1" } } });
        sendFrame(socket, { type: "event", payload: { FgOutput: { data: "b2s=" } } });
        sendFrame(socket, {
          type: "event",
          payload: { FgExited: { id: "J1", reason: "completed" } },
        });
      }
    },
    async (client, requests) => {
      const cronEvents: CueFrame[] = [];
      const fgEvents: CueFrame[] = [];
      client.onEvent("crons", (event) => cronEvents.push(event as CueFrame));
      client.onEvent("fg", (event) => fgEvents.push(event as CueFrame));

      assert.equal(await client.fgAttach("J1"), "J1");
      await client.fgInput("ok");
      await client.fgResize(120, 40);
      await client.fgDetach();
      assert.deepEqual(await client.complete(":ru", 3), [
        { label: ":run", insert_text: ":run", kind: "Command", detail: "Run a job" },
      ]);
      assert.deepEqual(await client.highlight(":run"), [{ start: 0, end: 4, kind: "CommandName" }]);
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(requests.map(requestPayload), [
        { FgAttach: { id: "J1" } },
        { FgInput: { data: "b2s=" } },
        { FgResize: { cols: 120, rows: 40 } },
        { FgDetach: {} },
        { Complete: { input: ":ru", cursor: 3 } },
        { Highlight: { input: ":run" } },
      ]);
      assert.equal(cronEvents.length, 2);
      assert.equal(fgEvents.length, 2);
    },
  );
});

test("CueClient.stopJob preserves typed IPC errors without Eval fallback", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("KillJob" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: { Err: { code: "NOT_FOUND", message: "job J404 not found" } },
        });
        return;
      }
      if ("RemoveCron" in payload || "CancelExecution" in payload) {
        sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
      }
    },
    async (client, requests) => {
      await assert.rejects(
        client.stopJob("J404"),
        (error) => error instanceof CueError && error.code === "NOT_FOUND",
      );
      await client.stopJob("C1");
      await client.stopJob("CH1");

      assert.deepEqual(requests.map(requestPayload), [
        { KillJob: { id: "J404" } },
        { RemoveCron: { id: "C1" } },
        { CancelExecution: { id: "CH1" } },
      ]);
    },
  );
});

test("CueClient.runJob abort cancels the daemon execution before rejecting", async () => {
  let cancelled = false;
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload || "Unsubscribe" in payload) {
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
                job_id: "J1",
                start_scope: null,
                open_hint: "stream",
                chain_id: null,
                chain_index: null,
                chain_total: null,
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
                  id: "J1",
                  status: cancelled ? { Cancelled: "User" } : "Running",
                  pipeline: "sleep 30",
                  exit_code: cancelled ? -1 : null,
                  start_scope: null,
                  end_scope: null,
                  open_hint: "stream",
                  chain_id: null,
                  chain_index: null,
                  chain_total: null,
                },
              ],
            },
          },
        });
        return;
      }
      if ("CancelExecution" in payload) {
        cancelled = true;
        setTimeout(
          () => sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } }),
          20,
        );
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
                stdout: { data: "", truncated: false },
                stderr: { data: "", truncated: false },
                stderr_pty_merged: false,
              },
            },
          },
        });
      }
    },
    async (client, requests) => {
      const controller = new AbortController();
      const running = client.runJob("sleep 30", { timeout: 2, signal: controller.signal });
      setTimeout(() => controller.abort(new Error("test abort")), 30);
      await assert.rejects(
        running,
        (error) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(cancelled, true);
      assert.ok(
        requests.some(
          (request) =>
            "CancelExecution" in requestPayload(request) &&
            (requestPayload(request).CancelExecution as { id?: string }).id === "J1",
        ),
      );
      assert.ok(requests.some((request) => "Unsubscribe" in requestPayload(request)));

      cancelled = false;
      const timedOut = await client.runJob("sleep 30", { timeout: 0.01 });
      assert.equal(timedOut.timedOut, true);
      assert.equal(timedOut.status, "Cancelled");
      assert.equal(cancelled, true);
    },
  );
});

test("CueClient.runScript abort cancels the authoritative script id", async () => {
  let cancelTarget: string | undefined;
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload || "Unsubscribe" in payload) {
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
                source: { kind: "inline" },
                items: [
                  {
                    index: 0,
                    source: "sleep 30",
                    result: {
                      kind: "job",
                      job_id: "J1",
                      start_scope: null,
                      open_hint: "stream",
                    },
                  },
                ],
                submit_error: null,
              },
            },
          },
        });
        return;
      }
      if ("CancelExecution" in payload) {
        cancelTarget = (payload.CancelExecution as { id: string }).id;
        setTimeout(
          () => sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } }),
          20,
        );
      }
    },
    async (client, requests) => {
      const controller = new AbortController();
      const running = client.runScript({
        path: "<inline>",
        input: "sleep 30\necho skipped",
        timeout: 2,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(new Error("script abort")), 30);
      await assert.rejects(
        running,
        (error) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(cancelTarget, "R1");
      assert.ok(requests.some((request) => "Unsubscribe" in requestPayload(request)));
    },
  );
});

test("CueClient.listJobs preserves typed IPC failures and rejects invalid success payloads", async () => {
  let listCalls = 0;
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if (!("ListJobs" in payload)) return;
      listCalls += 1;
      sendFrame(
        socket,
        listCalls === 1
          ? {
              type: "response",
              id,
              payload: { Err: { code: "INTERNAL", message: "job store unavailable" } },
            }
          : { type: "response", id, payload: { Ok: { Ack: {} } } },
      );
    },
    async (client, requests) => {
      await assert.rejects(
        client.listJobs(),
        (error) => error instanceof CueError && error.code === "INTERNAL",
      );
      await assert.rejects(
        client.listJobs(),
        (error) => error instanceof CueError && error.code === "UNEXPECTED_RESPONSE",
      );

      assert.deepEqual(requests.map(requestPayload), [
        { ListJobs: { limit: null } },
        { ListJobs: { limit: null } },
      ]);
    },
  );
});

test("CueClient.listCrons uses typed statuses and preserves protocol failures", async () => {
  let listCalls = 0;
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if (!("ListCrons" in payload)) return;
      listCalls += 1;
      const responsePayload =
        listCalls === 1
          ? {
              Ok: {
                CronListPage: {
                  crons: [{ id: "C1", schedule: "in 1m", command: "false", status: "failed" }],
                  page: { total: 1, shown: 1, limit: 1, truncated: false },
                },
              },
            }
          : listCalls === 2
            ? { Err: { code: "INTERNAL", message: "cron store unavailable" } }
            : { Ok: { Ack: {} } };
      sendFrame(socket, { type: "response", id, payload: responsePayload });
    },
    async (client, requests) => {
      assert.deepEqual(await client.listCrons(1), [
        { id: "C1", schedule: "in 1m", command: "false", status: "failed" },
      ]);
      await assert.rejects(
        client.listCrons(),
        (error) => error instanceof CueError && error.code === "INTERNAL",
      );
      await assert.rejects(
        client.listCrons(),
        (error) => error instanceof CueError && error.code === "UNEXPECTED_RESPONSE",
      );

      assert.deepEqual(requests.map(requestPayload), [
        { ListCrons: { limit: 1 } },
        { ListCrons: { limit: null } },
        { ListCrons: { limit: null } },
      ]);
    },
  );
});

test("CueClient.listScopes uses typed scope records and preserves protocol failures", async () => {
  let listCalls = 0;
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if (!("ListScopes" in payload)) return;
      listCalls += 1;
      const responsePayload =
        listCalls === 1
          ? {
              Ok: {
                ScopeListPage: {
                  scopes: [{ hash: "S@one", parent: null, cwd: "/work", env_count: 3 }],
                  page: { total: 1, shown: 1, limit: 1, truncated: false },
                },
              },
            }
          : listCalls === 2
            ? { Err: { code: "INTERNAL", message: "scope store unavailable" } }
            : { Ok: { Ack: {} } };
      sendFrame(socket, { type: "response", id, payload: responsePayload });
    },
    async (client, requests) => {
      assert.deepEqual(await client.listScopes(1), [
        { hash: "S@one", parent: null, cwd: "/work", env_count: 3 },
      ]);
      await assert.rejects(
        client.listScopes(),
        (error) => error instanceof CueError && error.code === "INTERNAL",
      );
      await assert.rejects(
        client.listScopes(),
        (error) => error instanceof CueError && error.code === "UNEXPECTED_RESPONSE",
      );

      assert.deepEqual(requests.map(requestPayload), [
        { ListScopes: { limit: 1 } },
        { ListScopes: { limit: null } },
        { ListScopes: { limit: null } },
      ]);
    },
  );
});

test("CueClient state text queries preserve typed failures without Eval fallback", async () => {
  const showCalls = { env: 0, config: 0 };
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      const key = "ShowEnv" in payload ? "env" : "ShowConfig" in payload ? "config" : null;
      if (!key) return;
      showCalls[key] += 1;
      sendFrame(
        socket,
        showCalls[key] === 1
          ? {
              type: "response",
              id,
              payload: { Err: { code: "INTERNAL", message: "state store unavailable" } },
            }
          : { type: "response", id, payload: { Ok: { Ack: {} } } },
      );
    },
    async (client, requests) => {
      for (const show of [() => client.showEnv(), () => client.showConfig()]) {
        await assert.rejects(
          show(),
          (error) => error instanceof CueError && error.code === "INTERNAL",
        );
        await assert.rejects(
          show(),
          (error) => error instanceof CueError && error.code === "UNEXPECTED_RESPONSE",
        );
      }
      assert.deepEqual(requests.map(requestPayload), [
        { ShowEnv: { tail_bytes: null } },
        { ShowEnv: { tail_bytes: null } },
        { ShowConfig: { tail_bytes: null } },
        { ShowConfig: { tail_bytes: null } },
      ]);
    },
  );
});

test("spark-cue local IPC initialization failures are not masked by daemon auto-start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cue-init-fail-"));
  const socketPath = join(dir, "cued.sock");
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
        const payload = requestPayload(message);
        if ("Handshake" in payload) {
          sendFrame(socket, {
            type: "response",
            id: message.id as number,
            payload: { Ok: { Ack: {} } },
          });
          continue;
        }
        if ("Ping" in payload) socket.destroy();
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await withTempPath(
      {
        "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"local","transport":"unix","socket_path":"${socketPath}"}'\n`,
        cued: `#!/bin/sh\necho unexpected-autostart >&2\nexit 1\n`,
      },
      async () => {
        const tools = registerCueToolsForProtocolTest();
        const execTool = tools.get("cue_exec");
        assert.ok(execTool);
        await assert.rejects(
          execTool.execute(
            "init-fail",
            { command: "echo never-runs", background: true },
            new AbortController().signal,
            () => undefined,
            { cwd: "/work" },
          ),
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            return (
              error instanceof CueError &&
              error.code === "UNSUPPORTED_PROTOCOL" &&
              message.includes("IPC initialization failed") &&
              message.includes("connection closed") &&
              !message.includes("Auto-start failed") &&
              !message.includes("unexpected-autostart")
            );
          },
        );
      },
    );
  } finally {
    __resetSparkCueClientForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { force: true, recursive: true });
  }
});

function singleJobCueServer(label: string) {
  return (message: CueFrame, socket: Socket) => {
    const id = message.id as number;
    const payload = requestPayload(message);
    if ("Subscribe" in payload || "Unsubscribe" in payload) {
      sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
      return;
    }
    if ("Eval" in payload) {
      sendFrame(socket, {
        type: "response",
        id,
        payload: {
          Ok: {
            JobCreated: wireJobCreated({ job_id: `J-${label}`, open_hint: "fg" }),
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
              wireJob({
                id: `J-${label}`,
                status: "Running",
                pipeline: label,
                exit_code: null,
                open_hint: "fg",
              }),
            ],
          },
        },
      });
    }
  };
}

async function withResolvedCueServer(socketPath: string, run: () => Promise<void>): Promise<void> {
  await withTempPath(
    {
      "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"local","transport":"unix","socket_path":"${socketPath}"}'\n`,
    },
    run,
  );
}

test("spark-cue keeps replaying disconnected Eval with one operation id", async () => {
  const evalRequests: CueFrame[] = [];
  const updates: string[] = [];
  const server = await startCueServer((message, socket) => {
    const id = message.id as number;
    const payload = requestPayload(message);
    if ("Subscribe" in payload || "Unsubscribe" in payload) {
      sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
      return;
    }
    if ("Eval" in payload) {
      evalRequests.push(message);
      if (evalRequests.length <= 3) {
        socket.destroy();
        return;
      }
      sendFrame(socket, {
        type: "response",
        id,
        payload: { Ok: { JobCreated: wireJobCreated({ job_id: "J-replayed" }) } },
      });
      return;
    }
    if ("ListJobs" in payload) {
      sendFrame(socket, {
        type: "response",
        id,
        payload: { Ok: { JobList: [wireJob({ id: "J-replayed", status: "Running" })] } },
      });
    }
  });
  try {
    await withResolvedCueServer(server.socketPath, async () => {
      const execTool = registerCueToolsForProtocolTest().get("cue_exec");
      assert.ok(execTool);
      const result = await execTool.execute(
        "stable-tool-call",
        { command: "sleep 1", background: true },
        new AbortController().signal,
        (update) => updates.push(update.content[0]?.text ?? ""),
        { cwd: "/work", sessionId: "logical-session" },
      );
      assert.equal(result.details?.jobId, "J-replayed");
    });
    assert.equal(evalRequests.length, 4);
    assert.equal(new Set(evalRequests.map((request) => request.operation_id)).size, 1);
    assert.equal(typeof evalRequests[0]?.operation_id, "string");
    assert.equal(server.connectionCount(), 4);
    assert.equal(updates.length, 3);
    assert.ok(updates.every((update) => update.includes("retrying attempt")));
    assert.ok(updates.every((update) => !update.includes("sleep 1")));
  } finally {
    __resetSparkCueClientForTests();
    await server.close();
  }
});

test("spark-cue stops replay immediately when the tool signal is aborted", async () => {
  const evalRequests: CueFrame[] = [];
  const server = await startCueServer((message, socket) => {
    const id = message.id as number;
    const payload = requestPayload(message);
    if ("Subscribe" in payload || "Unsubscribe" in payload) {
      sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
      return;
    }
    if ("Eval" in payload) {
      evalRequests.push(message);
      socket.destroy();
    }
  });
  try {
    await withResolvedCueServer(server.socketPath, async () => {
      const execTool = registerCueToolsForProtocolTest().get("cue_exec");
      assert.ok(execTool);
      const controller = new AbortController();
      const reason = new Error("stop retrying");
      await assert.rejects(
        execTool.execute(
          "abort-replay",
          { command: "sleep 1", background: true },
          controller.signal,
          () => controller.abort(reason),
          { cwd: "/work", sessionId: "abort-replay-session" },
        ),
        (error) => error === reason,
      );
    });
    assert.equal(evalRequests.length, 1);
  } finally {
    __resetSparkCueClientForTests();
    await server.close();
  }
});

test("spark-cue stops replay when the foreground deadline expires", async () => {
  let warmed = false;
  const deadlineEvalRequests: CueFrame[] = [];
  const server = await startCueServer((message, socket) => {
    const id = message.id as number;
    const payload = requestPayload(message);
    if ("Subscribe" in payload || "Unsubscribe" in payload) {
      sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
      return;
    }
    if ("Eval" in payload) {
      if (!warmed) {
        warmed = true;
        sendFrame(socket, {
          type: "response",
          id,
          payload: { Ok: { JobCreated: wireJobCreated({ job_id: "J-deadline-warm" }) } },
        });
        return;
      }
      deadlineEvalRequests.push(message);
      return;
    }
    if ("ListJobs" in payload) {
      sendFrame(socket, {
        type: "response",
        id,
        payload: {
          Ok: {
            JobList: [
              wireJob({
                id: "J-deadline-warm",
                status: "Running",
                pipeline: "sleep 1",
                exit_code: null,
              }),
            ],
          },
        },
      });
    }
  });
  try {
    await withResolvedCueServer(server.socketPath, async () => {
      const execTool = registerCueToolsForProtocolTest().get("cue_exec");
      assert.ok(execTool);
      await execTool.execute(
        "deadline-warm",
        { command: "sleep 1", background: true },
        new AbortController().signal,
        () => undefined,
        { cwd: "/work", sessionId: "deadline-replay-session" },
      );
      await assert.rejects(
        execTool.execute(
          "deadline-replay",
          { command: "sleep 1", timeout: 0.25 },
          new AbortController().signal,
          () => undefined,
          { cwd: "/work", sessionId: "deadline-replay-session" },
        ),
        (error) => error instanceof CueError && error.code === "IDEMPOTENT_RETRY_DEADLINE_EXCEEDED",
      );
    });
    assert.equal(deadlineEvalRequests.length, 1);
  } finally {
    __resetSparkCueClientForTests();
    await server.close();
  }
});

test("spark-cue same-key replays a malformed post-execution response once", async () => {
  let executionCount = 0;
  const evalRequests: CueFrame[] = [];
  const server = await startCueServer((message, socket) => {
    const id = message.id as number;
    const payload = requestPayload(message);
    if ("Subscribe" in payload || "Unsubscribe" in payload) {
      sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
      return;
    }
    if ("Eval" in payload) {
      evalRequests.push(message);
      if (executionCount === 0) {
        executionCount += 1;
        sendFrame(socket, {
          type: "response",
          id,
          payload: { Ok: { UnknownAfterExecution: {} } },
        });
        return;
      }
      sendFrame(socket, {
        type: "response",
        id,
        payload: { Ok: { JobCreated: wireJobCreated({ job_id: "J-malformed" }) } },
      });
      return;
    }
    if ("ListJobs" in payload) {
      sendFrame(socket, {
        type: "response",
        id,
        payload: { Ok: { JobList: [wireJob({ id: "J-malformed", status: "Running" })] } },
      });
    }
  });
  try {
    await withResolvedCueServer(server.socketPath, async () => {
      const execTool = registerCueToolsForProtocolTest().get("cue_exec");
      assert.ok(execTool);
      const result = await execTool.execute(
        "malformed-tool-call",
        { command: "sleep 1", background: true },
        new AbortController().signal,
        () => undefined,
        { cwd: "/work", sessionId: "malformed-session" },
      );
      assert.equal(result.details?.jobId, "J-malformed");
    });
    assert.equal(executionCount, 1);
    assert.equal(evalRequests.length, 2);
    assert.equal(evalRequests[0]?.operation_id, evalRequests[1]?.operation_id);
  } finally {
    __resetSparkCueClientForTests();
    await server.close();
  }
});

test("spark-cue refuses replay after the daemon instance changes", async () => {
  const evalRequests: CueFrame[] = [];
  const server = await startCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload) {
        sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
        return;
      }
      if ("Eval" in payload) {
        evalRequests.push(message);
        socket.destroy();
      }
    },
    undefined,
    (connection) =>
      connection === 1
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
  );
  try {
    await withResolvedCueServer(server.socketPath, async () => {
      const execTool = registerCueToolsForProtocolTest().get("cue_exec");
      assert.ok(execTool);
      await assert.rejects(
        execTool.execute(
          "daemon-change",
          { command: "sleep 1", background: true },
          new AbortController().signal,
          () => undefined,
          { cwd: "/work", sessionId: "daemon-change-session" },
        ),
        (error) => error instanceof CueError && error.code === "IDEMPOTENT_DAEMON_CHANGED",
      );
    });
    assert.equal(evalRequests.length, 1, "changed daemon must not receive a replayed side effect");
  } finally {
    __resetSparkCueClientForTests();
    await server.close();
  }
});

test("resolveCueTransport uses cue-client target resolver JSON", async () => {
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

test("resolveCueTransport falls back to cue client namespace", async () => {
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

test("resolveCueTransport finds uv-installed cue-client outside a service PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "spark-cue-user-bin-"));
  const restrictedBin = join(home, "system-bin");
  const userBin = join(home, ".local", "bin");
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalUvToolBinDir = process.env.UV_TOOL_BIN_DIR;
  try {
    await mkdir(restrictedBin, { recursive: true });
    await mkdir(userBin, { recursive: true });
    await writeExecutable(
      join(userBin, "cue-client"),
      `#!/bin/sh\nprintf '%s\\n' '{"schema_version":1,"profile_name":"user-bin","transport":"unix","socket_path":"/tmp/user-bin.sock"}'\n`,
    );
    process.env.HOME = home;
    process.env.PATH = restrictedBin;
    delete process.env.UV_TOOL_BIN_DIR;

    const resolved = await resolveCueTransport();

    assert.equal(resolved.profile_name, "user-bin");
    assert.equal(resolved.transport, "unix");
    assert.equal(resolved.socket_path, "/tmp/user-bin.sock");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalUvToolBinDir === undefined) delete process.env.UV_TOOL_BIN_DIR;
    else process.env.UV_TOOL_BIN_DIR = originalUvToolBinDir;
    await rm(home, { force: true, recursive: true });
  }
});

test("spark-cue tools reconnect when the resolved transport profile changes", async () => {
  const first = await startCueServer(singleJobCueServer("first"));
  const second = await startCueServer(singleJobCueServer("second"));
  const selector = await mkdtemp(join(tmpdir(), "spark-cue-target-selector-"));
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
    __resetSparkCueClientForTests();
    await first.close();
    await second.close();
    await rm(selector, { force: true, recursive: true });
  }
});

test("spark-cue client registry coalesces concurrent calls and isolates sessions", async () => {
  const server = await startCueServer(singleJobCueServer("session"));
  try {
    await withTempPath(
      {
        "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"local","transport":"unix","socket_path":"${server.socketPath}"}'\n`,
      },
      async () => {
        const eventHandlers = new Map<string, SparkCueEventHandler[]>();
        const tools = registerCueToolsForProtocolTest(eventHandlers);
        const execTool = tools.get("cue_exec");
        assert.ok(execTool);
        const execute = (toolCallId: string, sessionId: string) =>
          execTool.execute(
            toolCallId,
            { command: `echo ${toolCallId}`, background: true },
            new AbortController().signal,
            () => undefined,
            {
              cwd: "/work",
              sessionId,
              env: {
                PATH: "/usr/bin",
                OPENAI_API_KEY: "do-not-forward",
                DATABASE_URL: "postgres://do-not-forward",
                DB_PASS: "db-do-not-forward",
                SSH_PASSPHRASE: "ssh-do-not-forward",
                OAUTH_CODE: "oauth-do-not-forward",
                COMPASS_MODE: "safe",
              },
            },
          );

        await Promise.all([
          execute("one-a", "session-one"),
          execute("one-b", "session-one"),
          execute("two-a", "session-two"),
          execute("two-b", "session-two"),
        ]);
        assert.deepEqual(
          server.handshakes
            .map(
              (handshake) =>
                (requestPayload(handshake).Handshake as { session_id?: string }).session_id,
            )
            .sort((a, b) => String(a).localeCompare(String(b))),
          ["session-one", "session-two"],
        );
        for (const handshake of server.handshakes) {
          const env = (requestPayload(handshake).Handshake as { env?: Record<string, string> }).env;
          assert.equal(env?.PATH, "/usr/bin");
          assert.equal(env?.OPENAI_API_KEY, undefined);
          assert.equal(env?.DATABASE_URL, undefined);
          assert.equal(env?.DB_PASS, undefined);
          assert.equal(env?.SSH_PASSPHRASE, undefined);
          assert.equal(env?.OAUTH_CODE, undefined);
          assert.equal(env?.COMPASS_MODE, "safe");
        }

        await execute("one-reuse", "session-one");
        await execute("two-reuse", "session-two");
        assert.equal(server.handshakes.length, 2);

        await emitCueEvent(eventHandlers, "session_shutdown", {
          cwd: "/work",
          sessionId: "session-one",
        });
        await execute("two-survives", "session-two");
        assert.equal(server.handshakes.length, 2);
        await execute("one-reconnects", "session-one");
        const sessionIds = server.handshakes.map(
          (handshake) =>
            (requestPayload(handshake).Handshake as { session_id?: string }).session_id,
        );
        assert.deepEqual(
          sessionIds.sort((a, b) => String(a).localeCompare(String(b))),
          ["session-one", "session-one", "session-two"],
        );
      },
    );
  } finally {
    __resetSparkCueClientForTests();
    await server.close();
  }
});

test("spark-cue shared clients stay open until every extension owner releases them", async () => {
  const server = await startCueServer(singleJobCueServer("owner"));
  try {
    await withTempPath(
      {
        "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"local","transport":"unix","socket_path":"${server.socketPath}"}'\n`,
      },
      async () => {
        const firstEvents = new Map<string, SparkCueEventHandler[]>();
        const secondEvents = new Map<string, SparkCueEventHandler[]>();
        const firstTool = registerCueToolsForProtocolTest(firstEvents).get("cue_exec");
        const secondTool = registerCueToolsForProtocolTest(secondEvents).get("cue_exec");
        assert.ok(firstTool);
        assert.ok(secondTool);
        const ctx = { cwd: "/work", sessionId: "shared-session" };
        const execute = (tool: RegisteredSparkCueTool, toolCallId: string) =>
          tool.execute(
            toolCallId,
            { command: `echo ${toolCallId}`, background: true },
            new AbortController().signal,
            () => undefined,
            ctx,
          );

        await Promise.all([execute(firstTool, "first"), execute(secondTool, "second")]);
        assert.equal(server.handshakes.length, 1);

        await emitCueEvent(firstEvents, "session_shutdown", ctx);
        await execute(secondTool, "second-survives");
        assert.equal(server.handshakes.length, 1);

        await emitCueEvent(secondEvents, "session_shutdown", ctx);
        await execute(firstTool, "first-reconnects");
        assert.equal(server.handshakes.length, 2);
      },
    );
  } finally {
    __resetSparkCueClientForTests();
    await server.close();
  }
});

test("implicit CueClient.connect supports ssh resolver profiles through gateway stdio", async () => {
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
        payload: { Ok: { Pong: { version: "9.9.9", protocol_version: 2, capabilities: ["session-handshake-required", "script-item-created", "cancel-execution", "operation-idempotency", "script-info-recovery"], instance_id: "00000000-0000-4000-8000-000000000001" } } },
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

test("implicit CueClient.connect fails ssh profiles without local daemon autostart", async () => {
  await withTempPath(
    {
      "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"remote","transport":"ssh","destination":"devbox","gateway_command":"cued gateway --stdio","start_command":"cued start"}'\n`,
      ssh: `#!/bin/sh\necho 'remote cued socket missing' >&2\nexit 42\n`,
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
          error.message.includes("Remote daemon startup is explicit") &&
          (error.message.includes("remote cued socket missing") ||
            error.message.includes("UNSUPPORTED_PROTOCOL")),
      );
    },
  );
});

test("ssh connection errors keep bounded trailing stderr diagnostics", async () => {
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

test("local cued auto-start failure reports command, socket, output, and recovery", async () => {
  const socketPath = join(tmpdir(), `spark-cue-missing-${process.pid}.sock`);
  await withTempPath(
    {
      "cue-client": `#!/bin/sh\nprintf '%s\n' '{"schema_version":1,"profile_name":"local","transport":"unix","socket_path":"${socketPath}"}'\n`,
      cued: `#!/bin/sh
echo daemon-start-stdout
echo daemon-start-stderr >&2
exit 1
`,
    },
    async () => {
      const tools = registerCueToolsForProtocolTest();
      const execTool = tools.get("cue_exec");
      assert.ok(execTool);
      await assert.rejects(
        execTool.execute(
          "autostart-fail",
          { command: "ls -la", background: true },
          new AbortController().signal,
          () => undefined,
          { cwd: "/work" },
        ),
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          return (
            error instanceof CueError &&
            error.code === "DAEMON_UNREACHABLE" &&
            message.includes("Initial connection failure:") &&
            message.includes("cued start exited with code 1") &&
            message.includes(`Attempted: cued start --socket ${socketPath}`) &&
            message.includes(`Socket: ${socketPath}`) &&
            message.includes("Config directory:") &&
            message.includes("stderr:\ndaemon-start-stderr") &&
            message.includes("stdout:\ndaemon-start-stdout") &&
            message.includes("Recovery: run")
          );
        },
      );
    },
  );
});

test("cue RunScript request matches the current strict daemon schema", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload || "Unsubscribe" in payload) {
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
                items: [
                  {
                    index: 0,
                    source: "echo ok",
                    result: {
                      kind: "job",
                      job_id: "J1",
                      start_scope: null,
                      open_hint: "stream",
                    },
                  },
                ],
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
        return;
      }
      if ("ScriptInfo" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              ScriptInfo: {
                script_id: "R1",
                status: "done",
                items: [
                  {
                    index: 0,
                    source: "echo ok",
                    result: {
                      kind: "job",
                      job_id: "J1",
                      start_scope: null,
                      open_hint: "stream",
                    },
                  },
                ],
                exit_code: 0,
                failed_item_index: null,
                submit_error: null,
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
              JobListPage: {
                jobs: [wireJob({ id: "J1", pipeline: "echo ok" })],
                page: { total: 1, shown: 1, limit: null, truncated: false },
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
                stderr: { data: "warn\n", truncated: false },
                stderr_pty_merged: false,
              },
            },
          },
        });
      }
    },
    async (client, requests) => {
      const result = await client.runScript({
        path: "build.cue",
        input: ":run echo ok",
        scope: "S@legacy",
      } as Parameters<CueClient["runScript"]>[0]);

      assert.equal(result.scriptId, "R1");
      assert.equal(result.items[0]?.stdout, "ok\n");
      assert.equal(result.items[0]?.stderr, "warn\n");
      assert.equal(result.items[0]?.exitCode, 0);
      assert.deepEqual(
        requests.map(requestPayload).filter((payload) => "JobOutput" in payload),
        [{ JobOutput: { id: "J1", stdout_bytes: null, stderr_bytes: null } }],
      );
      const scriptPayload = requestPayload(requests[1]!);
      assert.deepEqual(scriptPayload.RunScript, { path: "build.cue", input: ":run echo ok" });
      assert.equal(
        "mode" in (scriptPayload.RunScript as Record<string, unknown>),
        false,
        "RunScript must not send removed mode",
      );
      assert.equal(
        "scope" in (scriptPayload.RunScript as Record<string, unknown>),
        false,
        "RunScript must not send removed scope",
      );
    },
  );
});

test("cue RunScript trusts script item events and excludes other clients' jobs", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload || "Unsubscribe" in payload) {
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
                source: { kind: "file", path: "two-items.cue" },
                items: [
                  {
                    index: 0,
                    source: "echo first",
                    result: {
                      kind: "job",
                      job_id: "J1",
                      start_scope: null,
                      open_hint: "stream",
                    },
                  },
                ],
                submit_error: null,
              },
            },
          },
        });
        sendFrame(socket, {
          type: "event",
          payload: {
            JobCreated: {
              job_id: "J2",
              pipeline: "echo outsider",
              start_scope: null,
              open_hint: "stream",
              chain_id: null,
              chain_index: null,
              chain_total: null,
            },
          },
        });
        sendFrame(socket, {
          type: "event",
          payload: {
            ScriptItemCreated: {
              script_id: "R1",
              item: {
                index: 1,
                source: "echo second",
                result: {
                  kind: "job",
                  job_id: "J3",
                  start_scope: null,
                  open_hint: "stream",
                },
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
        return;
      }
      if ("ScriptInfo" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              ScriptInfo: {
                script_id: "R1",
                status: "done",
                items: [
                  {
                    index: 0,
                    source: "echo first",
                    result: {
                      kind: "job",
                      job_id: "J1",
                      start_scope: null,
                      open_hint: "stream",
                    },
                  },
                  {
                    index: 1,
                    source: "echo second",
                    result: {
                      kind: "job",
                      job_id: "J3",
                      start_scope: null,
                      open_hint: "stream",
                    },
                  },
                ],
                exit_code: 0,
                failed_item_index: null,
                submit_error: null,
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
              JobListPage: {
                jobs: [
                  wireJob({ id: "J1", pipeline: "echo first" }),
                  wireJob({ id: "J2", pipeline: "echo outsider" }),
                  wireJob({ id: "J3", pipeline: "echo second" }),
                ],
                page: { total: 3, shown: 3, limit: null, truncated: false },
              },
            },
          },
        });
        return;
      }
      if ("JobOutput" in payload) {
        const jobId = (payload.JobOutput as { id: string }).id;
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              JobOutput: {
                id: jobId,
                stdout: { data: `${jobId}\n`, truncated: false },
                stderr: { data: "", truncated: false },
                stderr_pty_merged: false,
              },
            },
          },
        });
      }
    },
    async (client, requests) => {
      const result = await client.runScript({
        path: "two-items.cue",
        input: "echo first\necho second",
      });

      assert.deepEqual(
        result.items.map((item) => ({ index: item.index, jobIds: item.jobIds })),
        [
          { index: 0, jobIds: ["J1"] },
          { index: 1, jobIds: ["J3"] },
        ],
      );
      assert.deepEqual(
        requests
          .map(requestPayload)
          .filter((request) => "JobOutput" in request)
          .map((request) => (request.JobOutput as { id: string }).id),
        ["J1", "J3"],
      );
    },
  );
});

test("cue RunScript propagates job status store failures", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload || "Unsubscribe" in payload) {
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
                script_id: "R-status-error",
                source: { kind: "inline" },
                items: [
                  {
                    index: 0,
                    source: "true",
                    result: {
                      kind: "job",
                      job_id: "J1",
                      start_scope: null,
                      open_hint: "stream",
                    },
                  },
                ],
                submit_error: null,
              },
            },
          },
        });
        sendFrame(socket, {
          type: "event",
          payload: {
            ScriptFinished: {
              script_id: "R-status-error",
              status: "done",
              exit_code: 0,
              failed_item_index: null,
            },
          },
        });
        return;
      }
      if ("ScriptInfo" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              ScriptInfo: {
                script_id: "R-status-error",
                status: "done",
                items: [
                  {
                    index: 0,
                    source: "true",
                    result: {
                      kind: "job",
                      job_id: "J1",
                      start_scope: null,
                      open_hint: "stream",
                    },
                  },
                ],
                exit_code: 0,
                failed_item_index: null,
                submit_error: null,
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
          payload: { Err: { code: "INTERNAL", message: "job store unavailable" } },
        });
      }
    },
    async (client, requests) => {
      await assert.rejects(
        client.runScript({ path: "<inline>", input: "true" }),
        (error) => error instanceof CueError && error.code === "INTERNAL",
      );
      assert.equal(
        requests.map(requestPayload).filter((payload) => "JobOutput" in payload).length,
        0,
      );
    },
  );
});

test("spark-cue script tool schemas do not expose RunScript scope", () => {
  const tools = registerCueToolsForProtocolTest();
  for (const name of ["cue_run", "cue_script", "script_run", "script_eval"]) {
    const properties = toolParameterProperties(tools.get(name));
    assert.equal("scope" in properties, false, `${name} must not expose scope`);
  }
});

test("cue_scope mutates session env, PATH, and cwd", async () => {
  const evals: string[] = [];
  let currentCwd = "/work";
  let currentPath = "/usr/bin";
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("ShowEnv" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              EvalText: {
                text: `cwd=${currentCwd}\nPATH=${currentPath}\nOPENAI_API_KEY=do-not-expose\nDB_PASS=db-do-not-expose\nSSH_PASSPHRASE=ssh-do-not-expose\nOAUTH_CODE=oauth-do-not-expose\nCOMPASS_MODE=safe\n`,
              },
            },
          },
        });
        return;
      }
      if ("Eval" in payload) {
        const input = (payload.Eval as { input: string }).input;
        evals.push(input);
        if (input.startsWith(":env set PATH=")) currentPath = input.slice(":env set PATH=".length);
        if (input.startsWith(":cd ")) currentCwd = input.slice(":cd ".length);
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              ScopeCreated: {
                hash: "S@scope",
                summary: `scope updated by ${input}`,
              },
            },
          },
        });
      }
    },
    async (client, _requests, handshakes) => {
      const tools = registerCueToolsForProtocolTest();
      const scopeTool = tools.get("cue_scope");
      assert.ok(scopeTool);
      const rendered = scopeTool
        .renderCall?.({ action: "path_prepend", path: "/node26/bin" }, {}, {})
        .render(120)
        .join("\n");
      assert.match(rendered ?? "", /action=path_prepend/);
      assert.match(rendered ?? "", /path=\/node26\/bin/);
      const initialSessionId = (requestPayload(handshakes[0]!).Handshake as { session_id: string })
        .session_id;
      const ctx = {
        cwd: "/work",
        cueClient: client,
        sessionId: initialSessionId,
        env: { PATH: "/node26/bin:/usr/bin", NODE_VERSION: "26" },
      };
      const envSet = await scopeTool.execute(
        "env-set",
        { action: "env_set", key: "FOO", value: "bar" },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      const envUnset = await scopeTool.execute(
        "env-unset",
        { action: "env_unset", key: "FOO" },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      await scopeTool.execute(
        "path-prepend",
        { action: "path_prepend", path: "/node26/bin" },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      const cd = await scopeTool.execute(
        "cd",
        { action: "cd", path: "/tmp" },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      const refresh = await scopeTool.execute(
        "refresh",
        { action: "refresh", tail_bytes: 80 },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      const status = await scopeTool.execute(
        "status",
        { action: "status", tail_bytes: 80 },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      const env = await scopeTool.execute(
        "env",
        { action: "env", tail_bytes: 200 },
        new AbortController().signal,
        () => undefined,
        ctx,
      );

      assert.deepEqual(evals, [
        ":env set FOO=bar",
        ":env unset FOO",
        ":env set PATH=/node26/bin:/usr/bin",
        ":cd /tmp",
      ]);
      assert.match(envSet.content[0]?.text ?? "", /Set FOO/);
      assert.match(envUnset.content[0]?.text ?? "", /Unset FOO/);
      assert.match(cd.content[0]?.text ?? "", /Changed cue session cwd/);
      assert.match(refresh.content[0]?.text ?? "", /Refreshed cue session/);
      const refreshHandshake = requestPayload(handshakes.at(-1)!);
      assert.deepEqual(refreshHandshake.Handshake, {
        session_id: initialSessionId,
        cwd: "/work",
        env: { PATH: "/node26/bin:/usr/bin", NODE_VERSION: "26" },
        refresh: true,
      });
      assert.match(status.content[0]?.text ?? "", /cwd=\/tmp/);
      assert.match(status.content[0]?.text ?? "", /PATH=\/node26\/bin:\/usr\/bin/);
      assert.match(env.content[0]?.text ?? "", /OPENAI_API_KEY=<redacted>/);
      assert.match(env.content[0]?.text ?? "", /DB_PASS=<redacted>/);
      assert.match(env.content[0]?.text ?? "", /SSH_PASSPHRASE=<redacted>/);
      assert.match(env.content[0]?.text ?? "", /OAUTH_CODE=<redacted>/);
      assert.match(env.content[0]?.text ?? "", /COMPASS_MODE=safe/);
      assert.doesNotMatch(env.content[0]?.text ?? "", /do-not-expose/);
    },
  );
});

test("cue eval encodes resource needs as run mode params", async () => {
  await withCueServer(
    () => undefined,
    async (client, requests) => {
      await client.eval("echo ok", "Job", {
        cwd: "/tmp/work dir",
        needs: { gpu: 1, gpu_mem: "24GiB" },
        pty: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const payload = requestPayload(requests[0]!);
      assert.deepEqual(payload.Eval, {
        input: ':run(pty=false,cwd="/tmp/work dir",need.gpu=1,need.gpu_mem=24GiB) echo ok',
        mode: "Job",
      });
    },
  );
});

test("cue runJob resolves serial chains after a failed leaf skips later leaves", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload || "Unsubscribe" in payload) {
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
                    wireChainJob({ index: 0, status: "Running", job_id: "J1" }),
                    wireChainJob({ index: 1, pipeline: "false" }),
                    wireChainJob({ index: 2, pipeline: "echo skipped" }),
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
                    wireChainJob({ index: 0, status: "Done", job_id: "J1" }),
                    wireChainJob({ index: 1, pipeline: "false", status: "Failed", job_id: "J2" }),
                    wireChainJob({
                      index: 2,
                      pipeline: "echo skipped",
                      status: { Cancelled: "ChainAborted" },
                    }),
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
                stdout: {
                  data: jobOutput.id === "J1" ? "first out\n" : "",
                  truncated: false,
                },
                stderr: {
                  data: jobOutput.id === "J2" ? "second err\n" : "",
                  truncated: false,
                },
                stderr_pty_merged: false,
              },
            },
          },
        });
      }
    },
    async (client, requests) => {
      const result = await client.runJob("true -> false -> echo skipped", { timeout: 2 });

      assert.equal(result.timedOut, false);
      assert.equal(result.status, "Failed");
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "first out");
      assert.equal(result.stderr, "second err");
      assert.deepEqual(
        requests.map(requestPayload).filter((payload) => "JobOutput" in payload),
        [
          { JobOutput: { id: "J1", stdout_bytes: 4 * 1024 * 1024, stderr_bytes: 4 * 1024 * 1024 } },
          { JobOutput: { id: "J2", stdout_bytes: 4 * 1024 * 1024, stderr_bytes: 4 * 1024 * 1024 } },
        ],
      );
    },
  );
});

test("cue typed job output treats daemon no-output responses as empty", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("JobOutput" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: { Err: { code: "NOT_FOUND", message: "no output found for J1" } },
        });
      }
    },
    async (client, requests) => {
      assert.deepEqual(await client.jobOutput("J1", 1024), {
        stdout: "",
        stderr: "",
        stdoutEncoding: "utf8",
        stderrEncoding: "utf8",
        truncated: false,
        stderrTruncated: false,
      });
      assert.deepEqual(await client.jobError("J1", 1024), {
        stderr: "",
        encoding: "utf8",
        truncated: false,
      });
      assert.deepEqual(requests.map(requestPayload), [
        { JobOutput: { id: "J1", stdout_bytes: 1024, stderr_bytes: 1024 } },
        { JobOutput: { id: "J1", stdout_bytes: null, stderr_bytes: 1024 } },
      ]);
    },
  );
});

test("cue preserves structured cancellation reasons across lists, chains, and events", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload) {
        sendFrame(socket, { type: "response", id, payload: { Ok: { Ack: {} } } });
        sendFrame(socket, {
          type: "event",
          payload: {
            JobStateChanged: {
              job_id: "J-event",
              old_state: "Running",
              new_state: { Cancelled: "Timeout" },
              end_scope: null,
              chain_id: null,
              chain_index: null,
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
              JobListPage: {
                jobs: [
                  wireJob({
                    id: "J-user",
                    status: { Cancelled: "User" },
                    pipeline: "sleep 10",
                    exit_code: -1,
                  }),
                ],
                page: { total: 1, shown: 1, limit: null, truncated: false },
              },
            },
          },
        });
        return;
      }
      if ("Eval" in payload) {
        sendFrame(socket, {
          type: "response",
          id,
          payload: {
            Ok: {
              ChainCreated: {
                chain_id: "CH-cancelled",
                job_ids: [],
                warnings: [],
                chain: {
                  id: "CH-cancelled",
                  pipeline: "false -> echo skipped",
                  total_jobs: 2,
                  jobs: [
                    wireChainJob({
                      index: 0,
                      pipeline: "false",
                      status: "Failed",
                      job_id: "J-failed",
                    }),
                    wireChainJob({
                      index: 1,
                      pipeline: "echo skipped",
                      status: { Cancelled: "ChainAborted" },
                    }),
                  ],
                },
              },
            },
          },
        });
      }
    },
    async (client) => {
      const event = new Promise<import("./cue-client.ts").JobStateChangedEvent>((resolve) => {
        client.onEvent("jobs", (payload) => {
          if ("JobStateChanged" in payload) resolve(payload.JobStateChanged);
        });
      });
      await client.subscribe(["jobs"]);
      assert.deepEqual(await event, {
        job_id: "J-event",
        old_state: "Running",
        new_state: "Cancelled",
        cancelReason: "Timeout",
        end_scope: null,
        chain_id: null,
        chain_index: null,
      });

      const jobs = await client.listJobs();
      assert.equal(jobs[0]?.status, "Cancelled");
      assert.equal(jobs[0]?.cancelReason, "User");

      const started = await client.startJob("false -> echo skipped");
      assert.equal(started.chain?.jobs[1]?.status, "Cancelled");
      assert.equal(started.chain?.jobs[1]?.cancelReason, "ChainAborted");
    },
  );
});

test("cue foreground fallback requests 4 MiB and returns a complete fast 2 MiB output", async () => {
  const output = "x".repeat(2 * 1024 * 1024);
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if ("Subscribe" in payload || "Unsubscribe" in payload) {
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
                job_id: "J-fast",
                start_scope: null,
                open_hint: "stream",
                chain_id: null,
                chain_index: null,
                chain_total: null,
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
              JobListPage: {
                jobs: [
                  wireJob({
                    id: "J-fast",
                    pipeline: "emit 2MiB",
                  }),
                ],
                page: { total: 1, shown: 1, limit: null, truncated: false },
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
                id: "J-fast",
                stdout: { data: output, truncated: false, encoding: "utf8" },
                stderr: { data: "", truncated: false, encoding: "utf8" },
                stderr_pty_merged: false,
              },
            },
          },
        });
      }
    },
    async (client, requests) => {
      const result = await client.runJob("emit 2MiB");
      assert.equal(result.stdout.length, output.length);
      assert.equal(result.stdoutTruncated, false);
      assert.equal(result.stdoutEncoding, "utf8");
      assert.deepEqual(
        requests.map(requestPayload).find((payload) => "JobOutput" in payload)?.JobOutput,
        { id: "J-fast", stdout_bytes: 4 * 1024 * 1024, stderr_bytes: 4 * 1024 * 1024 },
      );
    },
  );
});

test("cue typed job output preserves failures and rejects invalid success payloads", async () => {
  let outputCalls = 0;
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if (!("JobOutput" in payload)) return;
      outputCalls += 1;
      sendFrame(
        socket,
        outputCalls === 1
          ? {
              type: "response",
              id,
              payload: { Err: { code: "INTERNAL", message: "output store unavailable" } },
            }
          : { type: "response", id, payload: { Ok: { Ack: {} } } },
      );
    },
    async (client, requests) => {
      await assert.rejects(
        client.jobOutput("J1"),
        (error) => error instanceof CueError && error.code === "INTERNAL",
      );
      await assert.rejects(
        client.jobError("J1"),
        (error) => error instanceof CueError && error.code === "UNEXPECTED_RESPONSE",
      );
      assert.deepEqual(requests.map(requestPayload), [
        { JobOutput: { id: "J1", stdout_bytes: null, stderr_bytes: null } },
        { JobOutput: { id: "J1", stdout_bytes: null, stderr_bytes: null } },
      ]);
    },
  );
});

test("cue typed job output preserves authoritative base64 for non-UTF-8 bytes", async () => {
  await withCueServer(
    (message, socket) => {
      const id = message.id as number;
      const payload = requestPayload(message);
      if (!("JobOutput" in payload)) return;
      sendFrame(socket, {
        type: "response",
        id,
        payload: {
          Ok: {
            JobOutput: {
              id: "J-binary",
              stdout: {
                data: "�bin",
                truncated: false,
                encoding: "base64",
                base64: "/2Jpbg==",
              },
              stderr: { data: "", truncated: false, encoding: "utf8" },
              stderr_pty_merged: false,
            },
          },
        },
      });
    },
    async (client) => {
      const output = await client.jobOutput("J-binary");
      assert.equal(output.stdout, "�bin");
      assert.equal(output.stdoutEncoding, "base64");
      assert.equal(output.stdoutBase64, "/2Jpbg==");
      assert.deepEqual(
        Buffer.from(output.stdoutBase64!, "base64"),
        Buffer.from([0xff, 0x62, 0x69, 0x6e]),
      );
      assert.equal(output.truncated, false);
    },
  );
});

test("cue typed list, output, and log responses are parsed", async () => {
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
      const jobs = await client.listJobs(1);
      assert.deepEqual(
        requestPayload(requests[0]!).ListJobs,
        { limit: 1 },
        "listJobs should use typed ListJobs",
      );
      assert.equal(jobs[0]?.id, "J1");
      assert.equal(jobs[0]?.pending_reason, "license: busy");

      const output = await client.jobOutput("J1", 1024);
      assert.deepEqual(requestPayload(requests[1]!).JobOutput, {
        id: "J1",
        stdout_bytes: 1024,
        stderr_bytes: 1024,
      });
      assert.deepEqual(output, {
        stdout: "ok\n",
        stderr: "warn\n",
        stdoutEncoding: "utf8",
        stderrEncoding: "utf8",
        truncated: false,
        stderrTruncated: true,
      });

      const log = await client.showLog("J1", 10, 2048);
      assert.deepEqual(requestPayload(requests[2]!).ShowLog, {
        id: "J1",
        limit: 10,
        tail_bytes: 2048,
      });
      assert.equal(log, "recent log\n");

      const stderr = await client.jobError("J1", 512);
      assert.deepEqual(requestPayload(requests[3]!).JobOutput, {
        id: "J1",
        stdout_bytes: null,
        stderr_bytes: 512,
      });
      assert.deepEqual(stderr, { stderr: "warn\n", encoding: "utf8", truncated: true });
    },
  );
});
