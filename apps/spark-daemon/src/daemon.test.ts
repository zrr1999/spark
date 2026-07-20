import { Buffer } from "node:buffer";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  SPARK_PROTOCOL_VERSION,
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  createDaemonHumanWait,
  handleCommand,
  handleServerMessage,
  startSparkDaemon,
  type MessageContext,
  type ServerSocket,
} from "./daemon.js";
import { SparkDaemonInvocationRegistry, SparkDaemonLifecycle } from "./core/index.ts";
import { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import type { DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";
import type { CancelSparkInvocationFn, RunSparkCommandFn } from "./spark/bridge.js";
import { SparkInvocationStore } from "./store/invocations.ts";
import { openSparkDaemonDatabase } from "./store/schema.js";
import {
  addWorkspace,
  attachWorkspaceClient,
  getWorkspaceById,
  registerWorkspace,
  sparkDaemonServerStatusSummaries,
  stopWorkspace,
} from "./store/workspaces.js";
import { writeSparkDaemonConfig, type SparkDaemonConfig } from "./config.js";
import { completeSparkDaemonRestartSuccessor } from "./service.ts";

type BridgeInput = Parameters<RunSparkCommandFn>[0];

function webSocketDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return "";
}

interface TestHarness {
  paths: ReturnType<typeof resolveSparkPaths>;
  sparkHome: string;
  db: ReturnType<typeof openSparkDaemonDatabase>;
  workspace: ReturnType<typeof addWorkspace>;
  cleanup(): void;
}

function makeHarness(): TestHarness {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-daemon-"));
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const db = openSparkDaemonDatabase(paths);
  const sparkHome = join(root, "spark-home");
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const workspace = registerWorkspace(db, {
    serverUrl: "https://cockpit.example.test/",
    serverWorkspaceId: "ws_22222222222222222222222222222222",
    serverBindingId: "rtwb_11111111111111111111111111111111",
    localWorkspaceKey: "local-default",
    displayName: "Local default",
    workspaceName: "Local default",
    workspaceSlug: "local-default",
    localPath: workspacePath,
  });
  return {
    paths,
    sparkHome,
    db,
    workspace,
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

class CapturingSocket implements ServerSocket {
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

function emitFakeSparkSuccess(input: BridgeInput, chunks: string[]) {
  emitFakeSparkLifecycle(input, { status: "succeeded", chunks });
}

function emitFakeSparkFailure(input: BridgeInput, message: string) {
  emitFakeSparkLifecycle(input, { status: "failed", chunks: [], errorMessage: message });
}

function emitFakeSparkLifecycle(
  input: BridgeInput,
  options: { status: "succeeded" | "failed"; chunks: string[]; errorMessage?: string },
) {
  const invocationId = createId("inv");
  (input as { __fakeInvocationId?: string }).__fakeInvocationId = invocationId;
  const taskRuntimeId = `task-${invocationId}`;
  const artifactId = createId("art");
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  const prompt = input.command.payload.payload?.prompt;
  input.db
    .prepare(
      `INSERT INTO invocations
        (id, command_id, workspace_binding_id, status, prompt, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    )
    .run(
      invocationId,
      input.command.commandId ?? null,
      input.workspace.id,
      typeof prompt === "string" ? prompt : "",
      startedAt,
      startedAt,
    );
  input.emit({ type: "runtime.command.ack", payload: { accepted: true, invocationId } });
  input.emit({
    type: "invocation.updated",
    payload: {
      runtimeInvocationId: invocationId,
      taskRuntimeId,
      agentName: "spark-runtime",
      status: "running",
      startedAt,
      payload: { commandKind: input.command.payload.kind },
    },
  });
  input.emit({
    type: "task_graph.snapshot",
    payload: { snapshotVersion: 1, tasks: [{ status: "running", outputArtifactIds: [] }] },
  });
  options.chunks.forEach((content, index) => {
    input.emit({
      type: "invocation.log_chunk",
      payload: { runtimeInvocationId: invocationId, stream: "agent", sequence: index + 1, content },
    });
  });
  if (options.errorMessage) {
    input.emit({
      type: "invocation.log_chunk",
      payload: {
        runtimeInvocationId: invocationId,
        stream: "system",
        sequence: 1,
        content: options.errorMessage,
      },
    });
  }
  const outputText = options.chunks.join("");
  input.emit({
    type: "artifact.projected",
    payload: {
      artifactId,
      kind: "task-summary",
      format: "markdown",
      source: "runtime",
      contentRef: {
        runtimePathRef: "file:///fake/task-summary.md",
        inlineMarkdown:
          options.status === "succeeded"
            ? `# ✅ Task succeeded\n\n${outputText}`
            : `# ⚠️ Task failed\n\n${options.errorMessage}`,
      },
      contentAvailability: { daemonAvailable: true, sizeBytes: 1, mime: "text/markdown" },
      provenance: {
        runtimeInvocationId: invocationId,
        status: options.status,
        agentChunkCount: options.chunks.length,
      },
      links: [{ targetKind: "invocation", targetId: invocationId, relation: "produced-by" }],
    },
  });
  input.emit({
    type: "task_graph.snapshot",
    payload: {
      snapshotVersion: 2,
      tasks: [
        {
          status: options.status === "succeeded" ? "done" : "failed",
          outputArtifactIds: [artifactId],
        },
      ],
    },
  });
  input.db
    .prepare("UPDATE invocations SET status = ?, updated_at = ? WHERE id = ?")
    .run(options.status, completedAt, invocationId);
  input.emit({
    type: "invocation.updated",
    payload: {
      runtimeInvocationId: invocationId,
      taskRuntimeId,
      agentName: "spark-runtime",
      status: options.status,
      completedAt,
      terminalReason: options.errorMessage,
      payload: { outputArtifactIds: [artifactId], commandKind: input.command.payload.kind },
    },
  });
}

function makeContext(
  harness: TestHarness,
  runSparkCommand: RunSparkCommandFn,
  cancelSparkInvocation: CancelSparkInvocationFn = async () => ({
    invocationId: "inv_default",
    cancelled: false,
    message: "not found",
  }),
): MessageContext {
  const config: SparkDaemonConfig = {
    installationId: "spark-daemon-test",
    displayName: "Spark daemon test",
  };
  return {
    paths: harness.paths,
    config,
    db: harness.db,
    runtimeId: "rt_11111111111111111111111111111111",
    runtimeSessionId: undefined,
    setRuntimeSessionId() {},
    ensureHeartbeat() {},
    runSparkCommand,
    cancelSparkInvocation,
    humanWaits: new SparkDaemonHumanWaitRegistry(harness.db),
  };
}

function registerSecondCockpitWorkspace(harness: TestHarness) {
  const localPath = join(harness.workspace.localPath, "..", "other-cockpit-workspace");
  mkdirSync(localPath, { recursive: true });
  return registerWorkspace(harness.db, {
    serverUrl: "https://other-cockpit.example.test/",
    serverWorkspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    serverBindingId: "rtwb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    localWorkspaceKey: "other-cockpit-workspace",
    displayName: "Other Cockpit workspace",
    workspaceName: "Other Cockpit workspace",
    workspaceSlug: "other-cockpit-workspace",
    localPath,
  });
}

function buildTaskStartEnvelope(workspaceBindingId: string) {
  return serverCommandEnvelopeSchema.parse({
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "server.command",
    sentAt: new Date().toISOString(),
    runtimeId: "rt_11111111111111111111111111111111",
    workspaceBindingId,
    workspaceId: "ws_22222222222222222222222222222222",
    projectId: "proj_33333333333333333333333333333333",
    commandId: createId("cmd"),
    payload: {
      kind: "task.start.request",
      title: "Hello world prompt",
      payload: { prompt: "Print hello world." },
    },
  });
}

function buildAssignmentEnvelope(
  workspaceBindingId: string,
  payload: Record<string, unknown> = {
    goal: "Assign the daemon session.",
    target: {
      sessionId: "sess_ws_assign",
      workspaceId: "ws_22222222222222222222222222222222",
    },
    constraints: ["preserve metadata"],
    evidence: ["runtime websocket"],
    source: { kind: "cockpit" },
    title: "Assign session",
  },
) {
  return serverCommandEnvelopeSchema.parse({
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "server.command",
    sentAt: new Date().toISOString(),
    runtimeId: "rt_11111111111111111111111111111111",
    workspaceBindingId,
    workspaceId: "ws_22222222222222222222222222222222",
    projectId: "proj_33333333333333333333333333333333",
    commandId: createId("cmd"),
    payload: {
      kind: "assignment.create.request",
      title: "Assign session",
      payload,
    },
  });
}

function buildCancelEnvelope(workspaceBindingId: string, invocationId: string) {
  return serverCommandEnvelopeSchema.parse({
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "server.command",
    sentAt: new Date().toISOString(),
    runtimeId: "rt_11111111111111111111111111111111",
    workspaceBindingId,
    workspaceId: "ws_22222222222222222222222222222222",
    projectId: "proj_33333333333333333333333333333333",
    commandId: createId("cmd"),
    payload: {
      kind: "invocation.cancel.request",
      title: "Cancel invocation",
      payload: { runtimeInvocationId: invocationId },
    },
  });
}

describe("Spark daemon handleCommand task.start.request", () => {
  it("can start without server credentials so first registration can reach local RPC", async () => {
    const harness = makeHarness();
    try {
      await startSparkDaemon({
        paths: harness.paths,
        sparkHome: harness.sparkHome,
        db: harness.db,
        config: {
          installationId: "install-test",
          displayName: "Test daemon",
        },
        once: true,
      });

      expect(existsSync(harness.paths.pidFile)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("publishes readiness only after startup initialization and cleans up on ready failure", async () => {
    const harness = makeHarness();
    mkdirSync(harness.paths.runtimeDir, { recursive: true });
    writeFileSync(
      join(harness.paths.runtimeDir, "restart.starting.json"),
      JSON.stringify({
        state: "claimed",
        restartId: "restart-not-ready",
        previousPid: 999_999,
        previousInstanceId: "previous-instance",
        previousGeneration: "previous-generation",
        previousStartedAt: "2026-07-15T00:00:00.000Z",
        previousProcessStartToken: "test:previous",
        targetInstanceId: "target-instance",
        targetGeneration: "target-generation",
        protocolVersion: 1,
        requestedAt: "2026-07-15T00:01:00.000Z",
      }),
    );
    const onReady = vi.fn(() => {
      throw new Error("local control bind failed");
    });
    try {
      await expect(
        startSparkDaemon({
          paths: harness.paths,
          sparkHome: harness.sparkHome,
          db: harness.db,
          config: {
            installationId: "install-test",
            displayName: "Test daemon",
          },
          once: true,
          onReady,
        }),
      ).rejects.toThrow("local control bind failed");
      expect(onReady).toHaveBeenCalledOnce();
      expect(existsSync(harness.paths.pidFile)).toBe(false);
      expect(existsSync(join(harness.paths.runtimeDir, "restart.starting.json"))).toBe(true);
      expect(
        readdirSync(harness.paths.runtimeDir).some((name) => name.startsWith("restart.terminal.")),
      ).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps production scheduler and channel admission paused when serving fence commit fails", async () => {
    const harness = makeHarness();
    const store = new SparkInvocationStore(harness.db);
    const submitted = store.submit({
      sessionId: "queued-before-ready",
      prompt: "must remain queued",
      task: {
        type: "session.run",
        sessionId: "queued-before-ready",
        prompt: "must remain queued",
      },
    });
    const executeInvocation = vi.fn(async () => ({ text: "must not run" }));
    const startIngress = vi.fn(async () => []);
    const stopIngress = vi.fn(async () => undefined);
    const channelIngress = {
      start: startIngress,
      stop: stopIngress,
      setInteractionHandler: vi.fn(),
    } as unknown as DaemonChannelIngressRuntime;
    try {
      await expect(
        startSparkDaemon({
          paths: harness.paths,
          sparkHome: harness.sparkHome,
          db: harness.db,
          config: {
            installationId: "install-test",
            displayName: "Test daemon",
          },
          channelIngress,
          executeInvocation,
          schedulerPollIntervalMs: 1,
          onReady: () => undefined,
          onServing: () => {
            throw new Error("successor fence CAS failed");
          },
        }),
      ).rejects.toThrow("successor fence CAS failed");

      expect(startIngress).toHaveBeenCalledOnce();
      expect(executeInvocation).not.toHaveBeenCalled();
      expect(store.require(submitted.invocationId)).toMatchObject({
        status: "queued",
        attemptCount: 0,
      });
      expect(stopIngress).toHaveBeenCalledOnce();
    } finally {
      harness.cleanup();
    }
  });

  it("completes a successor fence before channel and scheduler admission open", async () => {
    const harness = makeHarness();
    const shutdown = new AbortController();
    mkdirSync(harness.paths.runtimeDir, { recursive: true });
    writeFileSync(
      join(harness.paths.runtimeDir, "restart.starting.json"),
      JSON.stringify({
        state: "claimed",
        restartId: "restart-serving",
        previousPid: 999_999,
        previousInstanceId: "previous-instance",
        previousGeneration: "previous-generation",
        previousStartedAt: "2026-07-15T00:00:00.000Z",
        previousProcessStartToken: "test:previous",
        targetInstanceId: "target-instance",
        targetGeneration: "target-generation",
        protocolVersion: 1,
        requestedAt: "2026-07-15T00:01:00.000Z",
      }),
    );
    const lifecycle = new SparkDaemonLifecycle(
      {
        acceptedRestartId: "restart-serving",
        instanceId: "target-instance",
        generation: "target-generation",
      },
      { initiallyServing: false },
    );
    const order: string[] = [];
    const terminalPublished = () =>
      readdirSync(harness.paths.runtimeDir).some((name) => name.startsWith("restart.terminal."));
    const startIngress = vi.fn(async () => {
      expect(terminalPublished()).toBe(false);
      expect(lifecycle.snapshot().state).toBe("starting");
      order.push("channel");
      return [];
    });
    const channelIngress = {
      start: startIngress,
      stop: vi.fn(async () => undefined),
      setInteractionHandler: vi.fn(),
    } as unknown as DaemonChannelIngressRuntime;
    try {
      await startSparkDaemon({
        paths: harness.paths,
        sparkHome: harness.sparkHome,
        db: harness.db,
        config: {
          installationId: "install-test",
          displayName: "Test daemon",
        },
        signal: shutdown.signal,
        channelIngress,
        onReady: (runtime) => {
          order.push("control");
          expect(runtime.channelIngress).toBe(channelIngress);
          expect(lifecycle.snapshot().state).toBe("starting");
          expect(terminalPublished()).toBe(false);
        },
        onServing: () => {
          expect(startIngress).toHaveBeenCalledOnce();
          lifecycle.activate();
          expect(lifecycle.snapshot().state).toBe("running");
          expect(
            completeSparkDaemonRestartSuccessor(harness.paths, lifecycle.processIdentity),
          ).toBe(true);
          expect(terminalPublished()).toBe(true);
          order.push("serving");
          setTimeout(() => shutdown.abort(), 0);
        },
      });

      expect(order).toEqual(["control", "channel", "serving"]);
      expect(lifecycle.snapshot()).toMatchObject({ state: "running", phase: "serving" });
    } finally {
      shutdown.abort();
      harness.cleanup();
    }
  });

  it("stops an idle daemon loop when shutdown is requested", async () => {
    const harness = makeHarness();
    try {
      const shutdown = new AbortController();
      const running = startSparkDaemon({
        paths: harness.paths,
        sparkHome: harness.sparkHome,
        db: harness.db,
        config: {
          installationId: "install-test",
          displayName: "Test daemon",
        },
        signal: shutdown.signal,
      });

      shutdown.abort();
      await running;

      expect(existsSync(harness.paths.pidFile)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("retries an unavailable Cockpit without filling the outbox or disabling local workspaces", async () => {
    const harness = makeHarness();
    const shutdown = new AbortController();
    let connectionAttempts = 0;
    let running: Promise<void> | undefined;
    const unavailableServer = createServer((socket) => {
      connectionAttempts += 1;
      socket.destroy();
    });

    try {
      unavailableServer.listen(0, "127.0.0.1");
      await once(unavailableServer, "listening");
      const address = unavailableServer.address();
      if (!address || typeof address === "string") {
        throw new Error("expected unavailable test server to listen on a TCP port");
      }
      const port = (address as AddressInfo).port;
      const serverUrl = `http://127.0.0.1:${port}/`;
      const config: SparkDaemonConfig = {
        installationId: "install-test",
        displayName: "Test daemon",
        runtimeId: "rt_11111111111111111111111111111111",
        runtimeToken: "runtime-token",
        webSocketUrl: `ws://127.0.0.1:${port}/runtime`,
      };
      const workspace = registerWorkspace(harness.db, {
        serverUrl,
        localPath: harness.workspace.localPath,
        localWorkspaceKey: "local-default",
        displayName: "Local default",
      });
      writeSparkDaemonConfig(harness.paths, config);

      running = startSparkDaemon({
        paths: harness.paths,
        sparkHome: harness.sparkHome,
        db: harness.db,
        config,
        signal: shutdown.signal,
        runScheduler: false,
        serverReconnectDelayMs: 5,
      });

      await vi.waitFor(() => expect(connectionAttempts).toBeGreaterThanOrEqual(3), {
        timeout: 1_000,
        interval: 5,
      });
      shutdown.abort();
      await running;

      expect(
        harness.db
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind = 'daemon.error'")
          .get(),
      ).toMatchObject({ count: 0 });
      expect(getWorkspaceById(harness.db, workspace.id)).toMatchObject({
        status: "available",
        diagnostics: {},
      });
      expect(sparkDaemonServerStatusSummaries(harness.db)).toContainEqual(
        expect.objectContaining({
          url: serverUrl,
          wsConnected: false,
          lastDisconnectReason: "server.unreachable",
        }),
      );
    } finally {
      shutdown.abort();
      await running?.catch(() => undefined);
      if (unavailableServer.listening) {
        await new Promise<void>((resolve, reject) => {
          unavailableServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
      harness.cleanup();
    }
  });

  it("runs the daemon-owned invocation scheduler inside the service process", async () => {
    const harness = makeHarness();
    try {
      const store = new SparkInvocationStore(harness.db);
      const submitted = store.submit({
        sessionId: "queued-session",
        prompt: "hello",
        task: { type: "session.run", sessionId: "queued-session", prompt: "hello" },
      });
      const shutdown = new AbortController();
      const executed: string[] = [];
      const running = startSparkDaemon({
        paths: harness.paths,
        sparkHome: harness.sparkHome,
        db: harness.db,
        config: {
          installationId: "install-test",
          displayName: "Test daemon",
        },
        signal: shutdown.signal,
        executeInvocation: async (task) => {
          executed.push(`${task.sessionId}:${task.prompt}`);
          shutdown.abort();
          return { text: "done" };
        },
        schedulerPollIntervalMs: 5,
      });

      await running;

      expect(executed).toEqual(["queued-session:hello"]);
      expect(store.require(submitted.invocationId)).toMatchObject({
        status: "succeeded",
        result: { text: "done" },
      });
      expect(existsSync(harness.paths.pidFile)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("drains active scheduler work and leaves queued work for the restart successor", async () => {
    const harness = makeHarness();
    const shutdown = new AbortController();
    const lifecycle = new SparkDaemonLifecycle();
    const invocationRegistry = new SparkDaemonInvocationRegistry();
    let directHandle: ReturnType<SparkDaemonInvocationRegistry["start"]> | undefined;
    const activeStarted = deferred<void>();
    const releaseActive = deferred<void>();
    const drainProgress: Array<{
      stage: "active-work" | "channel-ingress";
      scheduler: Array<{ invocationId: string }>;
      direct: Array<{ invocationId: string }>;
    }> = [];
    let running: Promise<void> | undefined;
    try {
      const store = new SparkInvocationStore(harness.db);
      const active = store.submit({
        sessionId: "restart-active",
        prompt: "finish before restart",
        task: {
          type: "session.run",
          sessionId: "restart-active",
          prompt: "finish before restart",
        },
      });
      const executed: string[] = [];
      running = startSparkDaemon({
        paths: harness.paths,
        sparkHome: harness.sparkHome,
        db: harness.db,
        config: {
          installationId: "install-test",
          displayName: "Test daemon",
        },
        signal: shutdown.signal,
        drainSignal: lifecycle.drainSignal,
        restartSignal: lifecycle.restartSignal,
        invocationRegistry,
        schedulerConcurrency: 1,
        schedulerPollIntervalMs: 5,
        executeInvocation: async (task) => {
          executed.push(task.sessionId);
          activeStarted.resolve(undefined);
          await releaseActive.promise;
          return { text: "finished by old daemon" };
        },
        onServing: () => {
          directHandle = invocationRegistry.start({
            invocationId: "inv_direct_restart_blocker",
            kind: "session.run",
            sessionId: "restart-direct",
          });
        },
        onDrainProgress: (progress) => drainProgress.push(progress),
      });

      await activeStarted.promise;
      const queued = store.submit({
        sessionId: "restart-queued",
        prompt: "run after restart",
        task: {
          type: "session.run",
          sessionId: "restart-queued",
          prompt: "run after restart",
        },
      });
      lifecycle.requestRestart("2026-07-15T00:00:00.000Z");

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.require(queued.invocationId).status).toBe("queued");
      expect(executed).toEqual(["restart-active"]);
      expect(drainProgress.at(-1)).toMatchObject({
        stage: "active-work",
        scheduler: [{ invocationId: active.invocationId }],
        direct: [{ invocationId: "inv_direct_restart_blocker" }],
      });

      releaseActive.resolve(undefined);
      directHandle?.finish();
      await running;

      expect(drainProgress.at(-1)).toMatchObject({
        stage: "channel-ingress",
        scheduler: [],
        direct: [],
      });

      expect(store.require(active.invocationId)).toMatchObject({
        status: "succeeded",
        result: { text: "finished by old daemon" },
      });
      expect(store.require(queued.invocationId).status).toBe("queued");
      expect(existsSync(harness.paths.pidFile)).toBe(false);

      const successorShutdown = new AbortController();
      const successorExecuted: string[] = [];
      await startSparkDaemon({
        paths: harness.paths,
        sparkHome: harness.sparkHome,
        db: harness.db,
        config: {
          installationId: "install-test",
          displayName: "Test daemon successor",
        },
        signal: successorShutdown.signal,
        schedulerConcurrency: 1,
        schedulerPollIntervalMs: 5,
        executeInvocation: async (task) => {
          successorExecuted.push(task.sessionId);
          successorShutdown.abort();
          return { text: "finished by successor" };
        },
      });

      expect(successorExecuted).toEqual(["restart-queued"]);
      expect(store.require(active.invocationId)).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
        result: { text: "finished by old daemon" },
      });
      expect(store.require(queued.invocationId)).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
        result: { text: "finished by successor" },
      });
    } finally {
      releaseActive.resolve(undefined);
      shutdown.abort();
      await running?.catch(() => undefined);
      harness.cleanup();
    }
  });

  it("publishes sequenced invocation events over the runtime WebSocket stream", async () => {
    const harness = makeHarness();
    const server = new WebSocketServer({ port: 0 });
    const shutdown = new AbortController();
    const helloReceived = deferred<void>();
    const viewEventReceived = deferred<void>();
    const interactionEventReceived = deferred<void>();
    const terminalEventReceived = deferred<void>();
    const runtimeEventTypes: string[] = [];
    const invocationSequences: number[] = [];

    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected WebSocket server to listen on a TCP port");
      }
      const port = (address as AddressInfo).port;
      const serverUrl = `http://127.0.0.1:${port}/`;
      const webSocketUrl = `ws://127.0.0.1:${port}/runtime`;
      const serverWorkspaceId = "ws_22222222222241112222222222222222";
      const routedWorkspace = registerWorkspace(harness.db, {
        serverUrl,
        serverWorkspaceId,
        serverBindingId: "rtwb_33333333333341113333333333333333",
        localPath: harness.workspace.localPath,
        localWorkspaceKey: "local-default",
        displayName: "Local default",
      });
      writeSparkDaemonConfig(harness.paths, {
        installationId: "install-test",
        displayName: "Test daemon",
        runtimeId: "rt_11111111111111111111111111111111",
        runtimeToken: "runtime-token",
        webSocketUrl,
      });

      server.on("connection", (socket) => {
        socket.on("message", (data) => {
          const message = JSON.parse(webSocketDataToString(data)) as {
            messageId: string;
            type: string;
            invocationId?: string;
            workspaceBindingId?: string;
            workspaceId?: string;
            payload?: {
              type?: string;
              sequence?: number;
              runtimeInvocationId?: string;
              content?: string;
              request?: { kind?: string; requestId?: string };
            };
          };
          if (message.type === "runtime.hello") {
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
            helloReceived.resolve(undefined);
            return;
          }
          if (
            message.type !== "invocation.updated" &&
            message.type !== "invocation.log_chunk" &&
            message.type !== "daemon.event"
          ) {
            return;
          }
          expect(JSON.stringify(message)).not.toMatch(
            /daemon\.queue|taskFileName|fileName|filePath/u,
          );
          runtimeEventTypes.push(message.type);
          if (typeof message.payload?.sequence === "number") {
            invocationSequences.push(message.payload.sequence);
          }
          socket.send(JSON.stringify({ type: "server.ingest_ack", ackOf: message.messageId }));
          if (
            message.type === "invocation.log_chunk" &&
            message.invocationId === message.payload?.runtimeInvocationId &&
            message.workspaceBindingId === routedWorkspace.id &&
            message.workspaceId === serverWorkspaceId &&
            message.payload?.sequence === 2 &&
            message.payload?.content === "done from live daemon"
          ) {
            viewEventReceived.resolve(undefined);
          }
          if (message.type === "invocation.updated" && message.payload?.sequence === 4) {
            terminalEventReceived.resolve(undefined);
          }
          if (
            message.type === "daemon.event" &&
            message.payload?.type === "daemon.interaction.request" &&
            message.workspaceBindingId === routedWorkspace.id &&
            message.workspaceId === serverWorkspaceId &&
            message.payload?.request?.kind === "confirmation" &&
            message.payload.request.requestId === "confirm-live-daemon"
          ) {
            interactionEventReceived.resolve(undefined);
          }
        });
      });

      const store = new SparkInvocationStore(harness.db);
      const running = startSparkDaemon({
        paths: harness.paths,
        sparkHome: harness.sparkHome,
        db: harness.db,
        config: {
          installationId: "install-test",
          displayName: "Test daemon",
        },
        signal: shutdown.signal,
        schedulerPollIntervalMs: 5,
        executeInvocation: async (task) => ({
          ok: true,
          jsonEvents: [
            {
              type: "view_event",
              event: {
                version: SPARK_PROTOCOL_VERSION,
                type: "session.message",
                sessionId: task.sessionId,
                message: {
                  version: SPARK_PROTOCOL_VERSION,
                  id: "assistant-ws-1",
                  role: "assistant",
                  text: "done from live daemon",
                  status: "done",
                  metadata: {},
                },
              },
            },
            {
              type: "daemon_event",
              event: {
                version: SPARK_PROTOCOL_VERSION,
                type: "daemon.interaction.request",
                source: "runtime",
                request: {
                  version: SPARK_PROTOCOL_VERSION,
                  kind: "confirmation",
                  requestId: "confirm-live-daemon",
                  title: "Confirm live daemon",
                  prompt: "Continue?",
                  severity: "info",
                  confirmLabel: "Confirm",
                  cancelLabel: "Cancel",
                  metadata: {},
                },
                metadata: {},
              },
            },
          ],
        }),
      });

      await helloReceived.promise;
      store.submit({
        sessionId: "queued-ws-session",
        workspaceBindingId: routedWorkspace.id,
        prompt: "hello over ws",
        task: {
          type: "session.run",
          sessionId: "queued-ws-session",
          prompt: "hello over ws",
          workspaceBindingId: routedWorkspace.id,
          workspaceId: serverWorkspaceId,
        },
      });
      await viewEventReceived.promise;
      await interactionEventReceived.promise;
      await terminalEventReceived.promise;
      shutdown.abort();
      await running;

      expect(runtimeEventTypes).toEqual([
        "invocation.updated",
        "invocation.log_chunk",
        "daemon.event",
        "invocation.updated",
      ]);
      expect(invocationSequences).toEqual([1, 2, 4]);
    } finally {
      shutdown.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      harness.cleanup();
    }
  });

  it("reconnects the invocation uplink from the last acknowledged sequence", async () => {
    const harness = makeHarness();
    const server = new WebSocketServer({ port: 0 });
    const shutdown = new AbortController();
    const replayed = deferred<void>();
    const sequencesByConnection: number[][] = [];
    const messageIdsForSequenceThree: string[] = [];
    let maxPayloadBytes = 0;

    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected WebSocket server to listen on a TCP port");
      }
      const port = (address as AddressInfo).port;
      const serverUrl = `http://127.0.0.1:${port}/`;
      const webSocketUrl = `ws://127.0.0.1:${port}/runtime`;
      const runtimeId = "rt_11111111111111111111111111111111";
      const serverWorkspaceId = "ws_22222222222241112222222222222222";
      const routedWorkspace = registerWorkspace(harness.db, {
        serverUrl,
        serverWorkspaceId,
        serverBindingId: "rtwb_33333333333341113333333333333333",
        localPath: harness.workspace.localPath,
        localWorkspaceKey: "local-default",
        displayName: "Local default",
      });
      writeSparkDaemonConfig(harness.paths, {
        installationId: "install-test",
        displayName: "Test daemon",
        runtimeId,
        runtimeToken: "runtime-token",
        webSocketUrl,
      });

      const store = new SparkInvocationStore(harness.db);
      const invocation = store.submit({
        sessionId: "uplink-reconnect",
        workspaceBindingId: routedWorkspace.id,
        prompt: "reconnect",
        task: {
          type: "session.run",
          sessionId: "uplink-reconnect",
          prompt: "reconnect",
          workspaceBindingId: routedWorkspace.id,
          workspaceId: serverWorkspaceId,
        },
      });
      const baseEvent = {
        version: SPARK_PROTOCOL_VERSION,
        source: "daemon" as const,
        emittedAt: "2026-07-14T00:00:00.000Z",
        workspaceId: serverWorkspaceId,
        sessionId: "uplink-reconnect",
        invocationId: invocation.invocationId,
        metadata: { workspaceBindingId: routedWorkspace.id },
      };
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", {
        ...baseEvent,
        type: "daemon.task.lifecycle",
        taskType: "session.run",
        status: "running",
      });
      store.appendEvent(invocation.invocationId, "daemon.view_event", {
        ...baseEvent,
        type: "daemon.view_event",
        view: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: "uplink-reconnect",
          message: { id: "assistant", role: "assistant", text: "hello", status: "streaming" },
        },
      });
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", {
        ...baseEvent,
        type: "daemon.task.lifecycle",
        taskType: "session.run",
        status: "succeeded",
      });

      let connectionIndex = 0;
      server.on("connection", (socket) => {
        const current = connectionIndex++;
        sequencesByConnection[current] = [];
        socket.on("message", (data) => {
          const message = JSON.parse(webSocketDataToString(data)) as {
            messageId: string;
            type: string;
            payload?: { sequence?: number };
          };
          if (message.type === "runtime.hello") {
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
            return;
          }
          if (message.type !== "invocation.updated" && message.type !== "invocation.log_chunk") {
            return;
          }
          const sequence = message.payload?.sequence;
          if (sequence === undefined) return;
          maxPayloadBytes = Math.max(
            maxPayloadBytes,
            Buffer.byteLength(webSocketDataToString(data)),
          );
          sequencesByConnection[current]!.push(sequence);
          if (sequence === 3) messageIdsForSequenceThree.push(message.messageId);
          if (current === 0 && sequence === 3) {
            socket.close();
            return;
          }
          socket.send(JSON.stringify({ type: "server.ingest_ack", ackOf: message.messageId }));
          if (current === 1 && sequence === 3) replayed.resolve(undefined);
        });
      });

      const running = startSparkDaemon({
        paths: harness.paths,
        sparkHome: harness.sparkHome,
        db: harness.db,
        config: {
          installationId: "install-test",
          displayName: "Test daemon",
        },
        signal: shutdown.signal,
        runScheduler: false,
        serverReconnectDelayMs: 5,
      });
      await replayed.promise;
      await vi.waitFor(() => {
        expect(store.pendingDeliveries(`cockpit:${runtimeId}`)).toHaveLength(0);
      });
      shutdown.abort();
      await running;

      expect(sequencesByConnection).toEqual([[1, 2, 3], [3]]);
      expect(new Set(messageIdsForSequenceThree).size).toBe(1);
      expect(maxPayloadBytes).toBeLessThan(1024 * 1024);
      console.info(
        "SPARK_INVOCATION_UPLINK_RECONNECT_TRANSCRIPT",
        JSON.stringify({
          sequencesByConnection,
          duplicateSequenceCount: messageIdsForSequenceThree.length - 1,
          stableMessageIdCount: new Set(messageIdsForSequenceThree).size,
          maxPayloadBytes,
        }),
      );
    } finally {
      shutdown.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      harness.cleanup();
    }
  });

  it("rejects a workspace id that does not match the registered binding", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const command = serverCommandEnvelopeSchema.parse({
        ...buildTaskStartEnvelope(harness.workspace.id),
        workspaceId: "ws_99999999999999999999999999999999",
      });
      const context = makeContext(harness, async () => {
        throw new Error("workspace route mismatch must not invoke bridge");
      });

      await handleCommand(ws, command, context);

      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]).toMatchObject({
        type: "runtime.command.reject",
        payload: {
          reasonCode: "WORKSPACE_ROUTE_MISMATCH",
          retryable: false,
        },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("rejects another Cockpit's workspace command before claiming a durable receipt", async () => {
    const harness = makeHarness();
    try {
      const otherWorkspace = registerSecondCockpitWorkspace(harness);
      const ws = new CapturingSocket();
      const command = serverCommandEnvelopeSchema.parse({
        ...buildTaskStartEnvelope(otherWorkspace.id),
        workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
      const runSparkCommand = vi.fn<RunSparkCommandFn>();
      const context = makeContext(harness, runSparkCommand);
      context.serverUrl = "https://cockpit.example.test/";

      await handleCommand(ws, command, context);

      expect(runSparkCommand).not.toHaveBeenCalled();
      expect(ws.sent).toEqual([
        expect.objectContaining({
          type: "runtime.command.reject",
          payload: expect.objectContaining({
            reasonCode: "WORKSPACE_ROUTE_MISMATCH",
            retryable: false,
          }),
        }),
      ]);
      expect(
        harness.db
          .prepare("SELECT COUNT(*) AS count FROM runtime_command_receipts WHERE command_id = ?")
          .get(command.commandId!),
      ).toEqual({ count: 0 });
    } finally {
      harness.cleanup();
    }
  });

  it("rejects another Cockpit's workspace-scoped ephemeral secret request", async () => {
    const harness = makeHarness();
    try {
      const otherWorkspace = registerSecondCockpitWorkspace(harness);
      const ws = new CapturingSocket();
      const context = makeContext(harness, vi.fn<RunSparkCommandFn>());
      context.serverUrl = "https://cockpit.example.test/";
      const request = {
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "server.ephemeral_secret.request",
        sentAt: new Date().toISOString(),
        runtimeId: context.runtimeId,
        workspaceBindingId: otherWorkspace.id,
        workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ephemeralRequestId: createId("eph"),
        actorUserId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        browserRequestId: createId("msg"),
        csrfVerified: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        payload: {
          operation: "channel.configure",
          workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          config: { adapter: "qqbot", appSecret: "must-not-cross-uplinks" },
        },
      };

      await handleServerMessage(ws, JSON.stringify(request), context);

      expect(ws.sent).toEqual([
        expect.objectContaining({
          type: "runtime.ephemeral_secret.result",
          workspaceBindingId: otherWorkspace.id,
          payload: expect.objectContaining({
            operation: "channel.configure",
            status: "failed",
            reasonCode: "SECRET_ROUTE_INVALID",
          }),
        }),
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it("streams ack, running, log chunks, and succeeded updates from the Spark bridge", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const command = buildTaskStartEnvelope(harness.workspace.id);
      const context = makeContext(harness, async (input) => {
        expect(input.workspace.localPath).toBe(harness.workspace.localPath);
        expect(input.command.payload.payload?.prompt).toBe("Print hello world.");
        emitFakeSparkSuccess(input, ["Hello", " world"]);
        return {
          invocationId: (input as { __fakeInvocationId?: string }).__fakeInvocationId!,
          taskRuntimeId: `task-${(input as { __fakeInvocationId?: string }).__fakeInvocationId}`,
          status: "succeeded",
          outputArtifactIds: ["art_fake"],
        };
      });

      await handleCommand(ws, command, context);

      const types = ws.sent.map((envelope) => (envelope as { type: string }).type);
      expect(types).toEqual([
        "runtime.command.ack",
        "invocation.updated",
        "task_graph.snapshot",
        "invocation.log_chunk",
        "invocation.log_chunk",
        "artifact.projected",
        "task_graph.snapshot",
        "invocation.updated",
        "runtime.command.result",
      ]);

      const ack = ws.sent[0] as { payload: { accepted: true; invocationId?: string } };
      expect(ack.payload.accepted).toBe(true);
      expect(ack.payload.invocationId).toMatch(/^inv_/);
      const invocationId = ack.payload.invocationId;

      const running = ws.sent[1] as {
        payload: { status: string; runtimeInvocationId: string; agentName?: string };
      };
      expect(running.payload).toMatchObject({
        status: "running",
        runtimeInvocationId: invocationId,
        agentName: "spark-runtime",
      });

      const runningSnapshot = ws.sent[2] as {
        payload: { snapshotVersion: number; tasks: { status: string }[] };
      };
      expect(runningSnapshot.payload.snapshotVersion).toBe(1);
      expect(runningSnapshot.payload.tasks[0]?.status).toBe("running");

      const firstChunk = ws.sent[3] as {
        payload: {
          runtimeInvocationId: string;
          stream: string;
          sequence: number;
          content: string;
        };
      };
      expect(firstChunk.payload).toMatchObject({
        runtimeInvocationId: invocationId,
        stream: "agent",
        sequence: 1,
        content: "Hello",
      });

      const secondChunk = ws.sent[4] as { payload: { sequence: number; content: string } };
      expect(secondChunk.payload).toMatchObject({ sequence: 2, content: " world" });

      const projection = ws.sent[5] as {
        payload: {
          artifactId: string;
          kind: string;
          format: string;
          source: string;
          contentRef: { inlineMarkdown?: string; runtimePathRef?: string };
          contentAvailability?: { daemonAvailable: boolean; sizeBytes?: number; mime?: string };
          provenance: Record<string, unknown>;
          links: { targetKind: string; targetId: string; relation: string }[];
        };
      };
      expect(projection.payload.artifactId).toMatch(/^art_/);
      expect(projection.payload).toMatchObject({
        kind: "task-summary",
        format: "markdown",
        source: "runtime",
      });
      expect(projection.payload.contentRef.runtimePathRef).toMatch(/^file:\/\//);
      expect(projection.payload.contentRef.inlineMarkdown).toContain("Task succeeded");
      expect(projection.payload.contentRef.inlineMarkdown).toContain("Hello world");
      expect(projection.payload.contentAvailability?.daemonAvailable).toBe(true);
      expect(projection.payload.provenance).toMatchObject({
        runtimeInvocationId: invocationId,
        status: "succeeded",
        agentChunkCount: 2,
      });
      expect(projection.payload.links[0]).toMatchObject({
        targetKind: "invocation",
        targetId: invocationId,
        relation: "produced-by",
      });

      const doneSnapshot = ws.sent[6] as {
        payload: {
          snapshotVersion: number;
          tasks: { status: string; outputArtifactIds: string[] }[];
        };
      };
      expect(doneSnapshot.payload.snapshotVersion).toBe(2);
      expect(doneSnapshot.payload.tasks[0]?.status).toBe("done");
      expect(doneSnapshot.payload.tasks[0]?.outputArtifactIds).toEqual([
        projection.payload.artifactId,
      ]);

      const succeeded = ws.sent[7] as {
        payload: {
          status: string;
          completedAt?: string;
          payload?: { outputArtifactIds?: string[] };
        };
      };
      expect(succeeded.payload).toMatchObject({ status: "succeeded" });
      expect(succeeded.payload.completedAt).toBeDefined();
      expect(succeeded.payload.payload?.outputArtifactIds).toEqual([projection.payload.artifactId]);
      expect(
        harness.db
          .prepare("SELECT status, workspace_binding_id AS workspaceBindingId FROM invocations")
          .get(),
      ).toMatchObject({
        status: "succeeded",
        workspaceBindingId: harness.workspace.id,
      });
    } finally {
      harness.cleanup();
    }
  });

  it("normalizes assignment.create.request through SparkAssignment before bridge execution", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const assignment = {
        goal: "Review the runtime assignment path.",
        target: {
          sessionId: "sess_ws_assign",
          workspaceId: "ws_22222222222222222222222222222222",
          role: "role:reviewer",
        },
        constraints: ["preserve metadata"],
        evidence: ["runtime websocket"],
        source: { kind: "cockpit" },
        title: "Review assignment",
      };
      const command = buildAssignmentEnvelope(harness.workspace.id, assignment);
      let bridgePayload: BridgeInput["command"]["payload"] | undefined;
      const context = makeContext(harness, async (input) => {
        bridgePayload = input.command.payload;
        emitFakeSparkSuccess(input, ["assigned"]);
        return {
          invocationId: (input as { __fakeInvocationId?: string }).__fakeInvocationId!,
          taskRuntimeId: `task-${(input as { __fakeInvocationId?: string }).__fakeInvocationId}`,
          status: "succeeded",
          outputArtifactIds: ["art_fake"],
        };
      });

      await handleCommand(ws, command, context);

      expect(bridgePayload).toMatchObject({
        kind: "task.start.request",
        title: "Assign session",
        payload: {
          ...assignment,
          prompt: assignment.goal,
          sessionId: assignment.target.sessionId,
          assignment,
        },
      });
      expect(ws.sent[0]).toMatchObject({ type: "runtime.command.ack" });
    } finally {
      harness.cleanup();
    }
  });

  it("rejects invalid assignment.create.request payloads before bridge execution", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const command = buildAssignmentEnvelope(harness.workspace.id, {
        goal: "Run invalid assignment",
        target: { sessionId: "sess_ws_assign" },
        source: { kind: "legacy-chat" },
      });
      const context = makeContext(harness, async () => {
        throw new Error("invalid assignment must not invoke bridge");
      });

      await handleCommand(ws, command, context);

      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]).toMatchObject({
        type: "runtime.command.reject",
        payload: {
          reasonCode: "ASSIGNMENT_INVALID",
          retryable: false,
        },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("emits a system log, failed snapshot, and failed update when the Spark bridge reports failure", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const command = buildTaskStartEnvelope(harness.workspace.id);
      const context = makeContext(harness, async (input) => {
        emitFakeSparkFailure(input, "model exploded");
        return {
          invocationId: (input as { __fakeInvocationId?: string }).__fakeInvocationId!,
          taskRuntimeId: `task-${(input as { __fakeInvocationId?: string }).__fakeInvocationId}`,
          status: "failed",
          outputArtifactIds: ["art_fake"],
        };
      });

      await handleCommand(ws, command, context);

      const types = ws.sent.map((envelope) => (envelope as { type: string }).type);
      expect(types).toEqual([
        "runtime.command.ack",
        "invocation.updated",
        "task_graph.snapshot",
        "invocation.log_chunk",
        "artifact.projected",
        "task_graph.snapshot",
        "invocation.updated",
        "runtime.command.result",
      ]);

      const errorChunk = ws.sent[3] as {
        payload: { stream: string; content: string; sequence: number };
      };
      expect(errorChunk.payload).toMatchObject({
        stream: "system",
        sequence: 1,
        content: "model exploded",
      });

      const projection = ws.sent[4] as {
        payload: {
          artifactId: string;
          kind: string;
          contentRef: { inlineMarkdown?: string };
          provenance: Record<string, unknown>;
        };
      };
      expect(projection.payload.kind).toBe("task-summary");
      expect(projection.payload.contentRef.inlineMarkdown).toContain("Task failed");
      expect(projection.payload.contentRef.inlineMarkdown).toContain("model exploded");
      expect(projection.payload.provenance).toMatchObject({ status: "failed" });

      const failedSnapshot = ws.sent[5] as {
        payload: { tasks: { status: string; outputArtifactIds: string[] }[] };
      };
      expect(failedSnapshot.payload.tasks[0]?.status).toBe("failed");
      expect(failedSnapshot.payload.tasks[0]?.outputArtifactIds).toEqual([
        projection.payload.artifactId,
      ]);

      const failed = ws.sent[6] as {
        payload: {
          status: string;
          terminalReason?: string;
          payload?: { outputArtifactIds?: string[] };
        };
      };
      expect(failed.payload).toMatchObject({
        status: "failed",
        terminalReason: "model exploded",
      });
      expect(failed.payload.payload?.outputArtifactIds).toEqual([projection.payload.artifactId]);
      expect(harness.db.prepare("SELECT status FROM invocations").get()).toMatchObject({
        status: "failed",
      });
    } finally {
      harness.cleanup();
    }
  });

  it("acknowledges cancellation through the Spark bridge cancellation hook", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const invocationId = createId("inv");
      const command = buildCancelEnvelope(harness.workspace.id, invocationId);
      const context = makeContext(
        harness,
        async () => {
          throw new Error("start bridge must not be invoked for cancellation");
        },
        async (input) => {
          expect(input).toMatchObject({
            invocationId,
            reason: "Spark daemon invocation cancellation requested by server command.",
          });
          return {
            invocationId,
            cancelled: true,
            message: "Cancellation signalled for 1 Spark role-run process(es).",
          };
        },
      );

      await handleCommand(ws, command, context);

      expect(ws.sent.map((value) => (value as { type: string }).type)).toEqual([
        "runtime.command.ack",
        "invocation.updated",
        "runtime.command.result",
      ]);
      expect(ws.sent[1]).toMatchObject({
        payload: {
          runtimeInvocationId: invocationId,
          status: "cancelled",
          terminalReason: "Cancellation signalled for 1 Spark role-run process(es).",
        },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("rejects new routed execution after restart draining begins", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const invocationRegistry = new SparkDaemonInvocationRegistry();
      invocationRegistry.beginDrain();
      const runSparkCommand = vi.fn<RunSparkCommandFn>();
      const context: MessageContext = {
        ...makeContext(harness, runSparkCommand),
        invocationRegistry,
      };

      await handleCommand(ws, buildTaskStartEnvelope(harness.workspace.id), context);

      expect(runSparkCommand).not.toHaveBeenCalled();
      expect(ws.sent).toContainEqual(
        expect.objectContaining({
          type: "runtime.command.reject",
          payload: expect.objectContaining({
            reasonCode: "DAEMON_DRAINING",
            retryable: true,
          }),
        }),
      );
    } finally {
      harness.cleanup();
    }
  });

  it("rejects routed execution when draining begins during model preparation", async () => {
    const harness = makeHarness();
    const finishPreparing = deferred<void>();
    try {
      const ws = new CapturingSocket();
      const invocationRegistry = new SparkDaemonInvocationRegistry();
      const preparing = deferred<void>();
      const runSparkCommand = vi.fn<RunSparkCommandFn>();
      const modelControl = {
        effectiveModel: vi.fn(async () => ({
          providerName: "test-provider",
          modelId: "test-model",
        })),
        prepareModel: vi.fn(async () => {
          preparing.resolve(undefined);
          await finishPreparing.promise;
        }),
      } as unknown as SparkDaemonModelControl;
      const context: MessageContext = {
        ...makeContext(harness, runSparkCommand),
        invocationRegistry,
        modelControl,
      };

      const handling = handleCommand(ws, buildTaskStartEnvelope(harness.workspace.id), context);
      await preparing.promise;
      invocationRegistry.beginDrain();
      finishPreparing.resolve(undefined);
      await handling;

      expect(runSparkCommand).not.toHaveBeenCalled();
      expect(invocationRegistry.snapshot()).toEqual([]);
      expect(ws.sent).toContainEqual(
        expect.objectContaining({
          type: "runtime.command.reject",
          payload: expect.objectContaining({
            reasonCode: "DAEMON_DRAINING",
            retryable: true,
          }),
        }),
      );
    } finally {
      finishPreparing.resolve(undefined);
      harness.cleanup();
    }
  });

  it("uses the shared invocation registry to cancel an active task.start command", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const invocationRegistry = new SparkDaemonInvocationRegistry();
      const started = deferred<void>();
      let invocationId = "";
      let observedAbort = false;
      const context: MessageContext = {
        ...makeContext(
          harness,
          async (input) => {
            invocationId = input.invocationId ?? "";
            started.resolve();
            await new Promise<void>((resolve) => {
              input.signal?.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  resolve();
                },
                { once: true },
              );
            });
            return {
              invocationId,
              taskRuntimeId: `task-${invocationId}`,
              status: "cancelled",
              outputArtifactIds: [],
            };
          },
          async (input) => ({
            invocationId: input.invocationId,
            cancelled: false,
            message: "no process matched; registry cancellation owns this invocation",
          }),
        ),
        invocationRegistry,
      };

      const startPromise = handleCommand(ws, buildTaskStartEnvelope(harness.workspace.id), context);
      await started.promise;
      expect(invocationRegistry.has(invocationId)).toBe(true);

      await handleCommand(ws, buildCancelEnvelope(harness.workspace.id, invocationId), context);
      await startPromise;

      expect(observedAbort).toBe(true);
      expect(invocationRegistry.has(invocationId)).toBe(false);
      expect(ws.sent).toContainEqual(
        expect.objectContaining({
          type: "runtime.command.ack",
          payload: expect.objectContaining({ accepted: true, invocationId }),
        }),
      );
      expect(ws.sent).toContainEqual(
        expect.objectContaining({
          type: "invocation.updated",
          payload: expect.objectContaining({
            status: "cancelled",
            runtimeInvocationId: invocationId,
          }),
        }),
      );
    } finally {
      harness.cleanup();
    }
  });

  it("keeps a post-relocation human request durable instead of leaking it to the old origin", () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const context = makeContext(harness, async () => {
        throw new Error("task bridge must not execute for a human wait");
      });
      context.serverUrl = "https://cockpit.example.test/";
      harness.db
        .prepare("UPDATE workspaces SET server_url = ? WHERE id = ?")
        .run("https://target.example.test/", harness.workspace.id);

      const registration = createDaemonHumanWait(ws, context, {
        invocationId: "inv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        workspaceBindingId: harness.workspace.id,
        workspaceId: "ws_22222222222222222222222222222222",
        kind: "ask_user",
        title: "Relocated decision",
        prompt: "Continue on the target?",
        questions: [],
      });

      expect(ws.sent).toEqual([]);
      expect(context.humanWaits?.listPendingOutbox()).toEqual([
        expect.objectContaining({
          kind: "human.request.created",
          envelope: expect.objectContaining({
            workspaceBindingId: harness.workspace.id,
            humanRequestId: registration.wait.humanRequestId,
            type: "human.request.created",
          }),
        }),
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it("returns human responses to daemon-owned waits", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const context = makeContext(harness, async () => {
        throw new Error("task bridge must not be invoked for human response delivery");
      });
      context.serverUrl = "https://cockpit.example.test/";
      const registration = createDaemonHumanWait(ws, context, {
        invocationId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workspaceBindingId: harness.workspace.id,
        workspaceId: "ws_22222222222222222222222222222222",
        projectId: "proj_33333333333333333333333333333333",
        kind: "ask_user",
        title: "Need decision",
        prompt: "Continue?",
        questions: [
          {
            id: "decision",
            type: "single",
            prompt: "Continue?",
            required: true,
            options: [{ value: "yes", label: "Yes" }],
          },
        ],
      });
      expect(ws.sent[0]).toMatchObject({
        type: "human.request.created",
        humanRequestId: registration.wait.humanRequestId,
        payload: { kind: "ask_user", title: "Need decision" },
      });

      const response = {
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "human.response.deliver",
        sentAt: new Date().toISOString(),
        runtimeId: "rt_11111111111111111111111111111111",
        workspaceBindingId: harness.workspace.id,
        workspaceId: "ws_22222222222222222222222222222222",
        projectId: "proj_33333333333333333333333333333333",
        humanRequestId: registration.wait.humanRequestId,
        payload: {
          status: "answered",
          answers: { decision: { values: ["yes"], labels: ["Yes"] } },
          responseArtifactRefs: [],
        },
      };

      await handleServerMessage(ws, JSON.stringify(response), context);
      const delivered = await registration.response;

      expect(delivered).toMatchObject({
        humanRequestId: registration.wait.humanRequestId,
        status: "answered",
        answers: { decision: { values: ["yes"], labels: ["Yes"] } },
      });
      expect(ws.sent[1]).toMatchObject({
        type: "human.response.ack",
        humanRequestId: registration.wait.humanRequestId,
        invocationId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        payload: {
          returnedToTool: true,
          message: "Returned human response to the daemon-owned wait.",
        },
      });
      const row = harness.db
        .prepare(
          "SELECT status, response_json AS responseJson FROM daemon_human_waits WHERE human_request_id = ?",
        )
        .get(registration.wait.humanRequestId) as { status: string; responseJson: string };
      expect(row.status).toBe("answered");
      expect(JSON.parse(row.responseJson)).toMatchObject({ status: "answered" });
    } finally {
      harness.cleanup();
    }
  });

  it("keeps a human wait pending across wrong runtime, wrong Cockpit, and mismatched ids", async () => {
    const harness = makeHarness();
    try {
      registerSecondCockpitWorkspace(harness);
      const wsA = new CapturingSocket();
      const wsB = new CapturingSocket();
      const contextA = makeContext(harness, vi.fn<RunSparkCommandFn>());
      contextA.serverUrl = "https://cockpit.example.test/";
      const contextB = makeContext(harness, vi.fn<RunSparkCommandFn>());
      contextB.runtimeId = "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      contextB.serverUrl = "https://other-cockpit.example.test/";
      const registration = createDaemonHumanWait(wsA, contextA, {
        invocationId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workspaceBindingId: harness.workspace.id,
        workspaceId: "ws_22222222222222222222222222222222",
        projectId: "proj_33333333333333333333333333333333",
        kind: "ask_user",
        title: "Route-bound decision",
        prompt: "Continue?",
        questions: [],
      });
      const response = {
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "human.response.deliver",
        sentAt: new Date().toISOString(),
        runtimeId: contextA.runtimeId,
        workspaceBindingId: harness.workspace.id,
        workspaceId: "ws_22222222222222222222222222222222",
        projectId: "proj_33333333333333333333333333333333",
        humanRequestId: registration.wait.humanRequestId,
        payload: { status: "answered", answers: { decision: "yes" }, responseArtifactRefs: [] },
      };

      await handleServerMessage(
        wsA,
        JSON.stringify({
          ...response,
          messageId: createId("msg"),
          runtimeId: contextB.runtimeId,
        }),
        contextA,
      );
      await handleServerMessage(
        wsB,
        JSON.stringify({
          ...response,
          messageId: createId("msg"),
          runtimeId: contextB.runtimeId,
        }),
        contextB,
      );
      await handleServerMessage(
        wsA,
        JSON.stringify({
          ...response,
          messageId: createId("msg"),
          workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
        contextA,
      );

      expect(contextA.humanWaits?.get(registration.wait.humanRequestId)).toMatchObject({
        status: "pending",
      });
      expect(contextA.humanWaits?.hasActive(registration.wait.humanRequestId)).toBe(true);
      expect(wsA.sent.slice(1)).toEqual([
        expect.objectContaining({
          type: "human.response.ack",
          payload: expect.objectContaining({ outcome: "unknown_request", returnedToTool: false }),
        }),
        expect.objectContaining({
          type: "human.response.ack",
          payload: expect.objectContaining({ outcome: "unknown_request", returnedToTool: false }),
        }),
      ]);
      expect(wsB.sent).toEqual([
        expect.objectContaining({
          type: "human.response.ack",
          payload: expect.objectContaining({ outcome: "unknown_request", returnedToTool: false }),
        }),
      ]);

      await handleServerMessage(wsA, JSON.stringify(response), contextA);
      await expect(registration.response).resolves.toMatchObject({ status: "answered" });
    } finally {
      harness.cleanup();
    }
  });

  it("does not let one Cockpit acknowledge another Cockpit's human outbox entry", async () => {
    const harness = makeHarness();
    try {
      registerSecondCockpitWorkspace(harness);
      const ws = new CapturingSocket();
      const contextA = makeContext(harness, vi.fn<RunSparkCommandFn>());
      contextA.serverUrl = "https://cockpit.example.test/";
      const contextB = makeContext(harness, vi.fn<RunSparkCommandFn>());
      contextB.runtimeId = "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      contextB.serverUrl = "https://other-cockpit.example.test/";
      createDaemonHumanWait(ws, contextA, {
        delivery: "async",
        workspaceBindingId: harness.workspace.id,
        workspaceId: "ws_22222222222222222222222222222222",
        kind: "ask_user",
        title: "Durable decision",
        prompt: "Continue?",
        questions: [],
      });
      const outbound = ws.sent[0] as { messageId: string };
      const ack = JSON.stringify({ type: "server.ingest_ack", ackOf: outbound.messageId });

      await handleServerMessage(ws, ack, contextB);
      expect(
        harness.db.prepare("SELECT status FROM outbox WHERE id = ?").get(outbound.messageId),
      ).toEqual({ status: "pending" });

      await handleServerMessage(ws, ack, contextA);
      expect(
        harness.db.prepare("SELECT status FROM outbox WHERE id = ?").get(outbound.messageId),
      ).toEqual({ status: "acked" });
    } finally {
      harness.cleanup();
    }
  });

  it("acknowledges unmatched human responses without auto-answering", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const response = {
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "human.response.deliver",
        sentAt: new Date().toISOString(),
        runtimeId: "rt_11111111111111111111111111111111",
        workspaceBindingId: harness.workspace.id,
        workspaceId: "ws_22222222222222222222222222222222",
        projectId: "proj_33333333333333333333333333333333",
        humanRequestId: "hreq_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        payload: {
          status: "answered",
          answers: { decision: "continue" },
          responseArtifactRefs: [],
        },
      };
      const context = makeContext(harness, async () => {
        throw new Error("task bridge must not be invoked for human response delivery");
      });

      await handleServerMessage(ws, JSON.stringify(response), context);

      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]).toMatchObject({
        type: "human.response.ack",
        payload: {
          returnedToTool: false,
          message: "No daemon-owned human wait matched this response.",
        },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a command for another runtime before receipt or execution", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const original = buildTaskStartEnvelope(harness.workspace.id);
      const command = serverCommandEnvelopeSchema.parse({
        ...original,
        runtimeId: "rt_99999999999999999999999999999999",
      });
      let executionCount = 0;
      const context = makeContext(harness, async () => {
        executionCount += 1;
        throw new Error("must not execute");
      });

      await handleCommand(ws, command, context);

      expect(executionCount).toBe(0);
      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]).toMatchObject({
        type: "runtime.command.reject",
        payload: { reasonCode: "RUNTIME_ID_MISMATCH", retryable: false },
      });
      expect(
        harness.db.prepare("SELECT COUNT(*) AS count FROM runtime_command_receipts").get(),
      ).toEqual({ count: 0 });
    } finally {
      harness.cleanup();
    }
  });

  it("rejects task.start.request for an unknown workspace binding", async () => {
    const harness = makeHarness();
    try {
      const ws = new CapturingSocket();
      const command = buildTaskStartEnvelope("rtwb_99999999999999999999999999999999");
      const context = makeContext(harness, async () => {
        throw new Error("must not be invoked");
      });

      await handleCommand(ws, command, context);

      expect(ws.sent).toHaveLength(1);
      const reject = ws.sent[0] as {
        type: string;
        payload: { reasonCode: string; retryable?: boolean };
      };
      expect(reject.type).toBe("runtime.command.reject");
      expect(reject.payload.reasonCode).toBe("UNKNOWN_WORKSPACE_BINDING");
    } finally {
      harness.cleanup();
    }
  });

  it("rejects mutating routed commands for a borrowed workspace", async () => {
    const harness = makeHarness();
    try {
      attachWorkspaceClient(harness.db, {
        workspaceId: harness.workspace.id,
        clientId: "wcl-borrowed-tui",
        kind: "interactive",
        displayName: "Spark TUI",
        now: "2026-05-26T00:00:00.000Z",
      });
      const ws = new CapturingSocket();
      const command = buildTaskStartEnvelope(harness.workspace.id);
      const context = makeContext(harness, async () => {
        throw new Error("must not be invoked");
      });

      await handleCommand(ws, command, context);

      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]).toMatchObject({
        type: "runtime.command.reject",
        payload: {
          reasonCode: "WORKSPACE_BORROWED",
          retryable: true,
        },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("allows borrowed workspaces to return snapshots", async () => {
    const harness = makeHarness();
    try {
      attachWorkspaceClient(harness.db, {
        workspaceId: harness.workspace.id,
        clientId: "wcl-borrowed-tui",
        kind: "interactive",
        displayName: "Spark TUI",
        now: "2026-05-26T00:00:00.000Z",
      });
      const ws = new CapturingSocket();
      const command = serverCommandEnvelopeSchema.parse({
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "server.command",
        sentAt: new Date().toISOString(),
        runtimeId: "rt_11111111111111111111111111111111",
        workspaceBindingId: harness.workspace.id,
        workspaceId: "ws_22222222222222222222222222222222",
        commandId: createId("cmd"),
        payload: { kind: "workspace.snapshot.request" },
      });
      const context = makeContext(harness, async () => {
        throw new Error("snapshot should not invoke task bridge");
      });

      await handleCommand(ws, command, context);

      expect(ws.sent).toHaveLength(3);
      expect(ws.sent[0]).toMatchObject({ type: "runtime.command.ack" });
      expect(ws.sent[1]).toMatchObject({
        type: "workspace.snapshot",
        payload: {
          borrowed: { borrowed: true, interactiveClientCount: 1 },
          control: { mode: "snapshot_only", reason: "borrowed", serverMutationAllowed: false },
        },
      });
      expect(ws.sent[2]).toMatchObject({
        type: "runtime.command.result",
        payload: { status: "succeeded" },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("rejects new routed commands for a paused workspace", async () => {
    const harness = makeHarness();
    try {
      stopWorkspace(harness.db, {
        id: harness.workspace.id,
        now: "2026-05-26T00:00:00.000Z",
      });
      const ws = new CapturingSocket();
      const command = buildTaskStartEnvelope(harness.workspace.id);
      const context = makeContext(harness, async () => {
        throw new Error("must not be invoked");
      });

      await handleCommand(ws, command, context);

      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]).toMatchObject({
        type: "runtime.command.reject",
        payload: {
          reasonCode: "WORKSPACE_DETACHED",
          retryable: true,
        },
      });
    } finally {
      harness.cleanup();
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
