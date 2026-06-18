import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
} from "@zendev-lab/navia-protocol";
import { resolveNaviaPaths } from "@zendev-lab/navia-system";
import {
  handleCommand,
  handleServerMessage,
  startSparkDaemon,
  type MessageContext,
  type ServerSocket,
} from "./daemon.js";
import type { CancelSparkInvocationFn, RunSparkCommandFn } from "./spark/bridge.js";
import { openSparkDaemonDatabase } from "./store/schema.js";
import { addWorkspace, stopWorkspace } from "./store/workspaces.js";
import type { SparkDaemonConfig } from "./config.js";

type BridgeInput = Parameters<RunSparkCommandFn>[0];

interface TestHarness {
  paths: ReturnType<typeof resolveNaviaPaths>;
  db: ReturnType<typeof openSparkDaemonDatabase>;
  workspace: ReturnType<typeof addWorkspace>;
  cleanup(): void;
}

function makeHarness(): TestHarness {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-daemon-"));
  const paths = resolveNaviaPaths({
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
  const workspace = addWorkspace(db, {
    localWorkspaceKey: "local-default",
    displayName: "Local default",
    localPath: root,
  });
  return {
    paths,
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
      contentAvailability: { runnerAvailable: true, sizeBytes: 1, mime: "text/markdown" },
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
  };
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

  it("stops an idle daemon loop when shutdown is requested", async () => {
    const harness = makeHarness();
    try {
      const shutdown = new AbortController();
      const running = startSparkDaemon({
        paths: harness.paths,
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
          contentAvailability?: { runnerAvailable: boolean; sizeBytes?: number; mime?: string };
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
      expect(projection.payload.contentAvailability?.runnerAvailable).toBe(true);
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
            reason: "Navia invocation cancellation requested by server command.",
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

  it("acknowledges human ask/resume responses without re-entering direct Pi execution", async () => {
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
          message: "No active Pi tool wait is attached in this Spark daemon slice.",
        },
      });
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
