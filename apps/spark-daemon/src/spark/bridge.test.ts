import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { SparkInvocationStore } from "../store/invocations.js";
import { openSparkDaemonDatabase } from "../store/schema.js";
import { addWorkspace } from "../store/workspaces.js";
import { runSparkCommandBridge } from "./bridge.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-spark-bridge-"));
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
  const workspace = addWorkspace(db, {
    localWorkspaceKey: "local-default",
    displayName: "Local default",
    localPath: root,
  });
  return {
    root,
    paths,
    db,
    workspace,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function command(
  workspaceBindingId: string,
  payload: Record<string, unknown> = { prompt: "Use Spark" },
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
    payload: { kind: "task.start.request", title: "Bridge task", payload },
  });
}

describe("Spark daemon bridge", () => {
  it("executes through the injected Spark task executor and projects Spark artifacts", async () => {
    const h = setup();
    try {
      const emitted: unknown[] = [];
      const graph = fakeGraph();
      const store = {
        async update<T>(fn: (graph: ReturnType<typeof fakeGraph>) => T | Promise<T>) {
          return { graph, result: await fn(graph) };
        },
        async save() {},
      };
      const artifactStore = {
        async get(ref: `artifact:${string}`) {
          return {
            ref,
            kind: "trace",
            title: "Spark role run",
            format: "json",
            hash: "hash123",
            provenance: { runRef: "run_1", taskRef: "task_1" },
          };
        },
        async getBody() {
          return JSON.stringify({ ok: true });
        },
      };

      const result = await runSparkCommandBridge({
        command: command(h.workspace.id, {
          prompt: "Use Spark",
          sessionId: "sess_bridge",
        }),
        workspace: h.workspace,
        route: {
          runtimeId: "rt_11111111111111111111111111111111",
          workspaceBindingId: h.workspace.id,
          workspaceId: "ws_22222222222222222222222222222222",
          projectId: "proj_33333333333333333333333333333333",
          commandId: "cmd_11111111111111111111111111111111",
          ackOf: "msg_11111111111111111111111111111111",
        },
        paths: h.paths,
        db: h.db,
        emit: (message) => emitted.push(message),
        taskGraphStore: store,
        artifactStore,
        executeSparkTask: async (input) => {
          expect(new SparkInvocationStore(h.db).sessionActivity("sess_bridge")).toMatchObject({
            active: true,
          });
          expect(input.cwd).toBe(h.workspace.localPath);
          expect(input.dryRun).toBe(false);
          return {
            ref: "run:bridge",
            status: "succeeded",
            outputArtifacts: ["artifact:bridge-output"],
          };
        },
      });

      expect(result.status).toBe("succeeded");
      expect(result.sparkRunRef).toBe("run:bridge");
      expect(emitted.map((value) => (value as { type: string }).type)).toEqual([
        "runtime.command.ack",
        "invocation.updated",
        "task_graph.snapshot",
        "invocation.log_chunk",
        "artifact.projected",
        "task_graph.snapshot",
        "invocation.updated",
      ]);
      const artifact = emitted.find(
        (value) => (value as { type: string }).type === "artifact.projected",
      ) as {
        payload: { contentRef: { sparkArtifactRef?: string } };
      };
      expect(artifact.payload.contentRef.sparkArtifactRef).toBe("artifact:bridge-output");
      expect(
        h.db.prepare("SELECT session_id AS sessionId, status FROM invocations").get(),
      ).toMatchObject({
        sessionId: "sess_bridge",
        status: "succeeded",
      });
      expect(new SparkInvocationStore(h.db).sessionActivity("sess_bridge")).toMatchObject({
        active: false,
      });
    } finally {
      h.cleanup();
    }
  });

  it("streams live role-run text deltas as ordered assistant invocation chunks", async () => {
    const h = setup();
    try {
      const emitted: unknown[] = [];
      const graph = fakeGraph();
      const store = {
        async update<T>(fn: (graph: ReturnType<typeof fakeGraph>) => T | Promise<T>) {
          return { graph, result: await fn(graph) };
        },
        async save() {},
      };
      const artifactStore = {
        async get() {
          throw new Error("unexpected artifact lookup for stream-only run");
        },
        async getBody() {
          throw new Error("unexpected artifact body lookup");
        },
      };

      const result = await runSparkCommandBridge({
        command: command(h.workspace.id),
        workspace: h.workspace,
        route: {
          runtimeId: "rt_11111111111111111111111111111111",
          workspaceBindingId: h.workspace.id,
          workspaceId: "ws_22222222222222222222222222222222",
          projectId: "proj_33333333333333333333333333333333",
          commandId: "cmd_11111111111111111111111111111111",
          ackOf: "msg_11111111111111111111111111111111",
        },
        paths: h.paths,
        db: h.db,
        emit: (message) => emitted.push(message),
        taskGraphStore: store,
        artifactStore,
        executeSparkTask: async (input) => {
          const onRoleEvent = input.onRoleEvent as ((event: unknown) => void) | undefined;
          onRoleEvent?.({ type: "stream_event", event: { type: "text_delta", delta: "Hel" } });
          onRoleEvent?.({ type: "stream_event", event: { type: "text_delta", delta: "lo" } });
          onRoleEvent?.({ type: "stream_event", event: { type: "done" } });
          return {
            ref: "run:streaming",
            status: "succeeded",
            outputArtifacts: [],
          };
        },
      });

      expect(result.status).toBe("succeeded");
      expect(emitted.map((value) => (value as { type: string }).type)).toEqual([
        "runtime.command.ack",
        "invocation.updated",
        "task_graph.snapshot",
        "invocation.log_chunk",
        "invocation.log_chunk",
        "invocation.log_chunk",
        "task_graph.snapshot",
        "invocation.updated",
      ]);
      const chunks = emitted.filter(
        (value) => (value as { type: string }).type === "invocation.log_chunk",
      ) as Array<{ payload: { stream: string; sequence: number; content: string } }>;
      expect(chunks.map((chunk) => chunk.payload)).toMatchObject([
        { stream: "system", sequence: 1, content: "Spark runtime role-run started." },
        { stream: "assistant", sequence: 2, content: "Hel" },
        { stream: "assistant", sequence: 3, content: "lo" },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it("emits final assistant text when a headless role run produces no deltas", async () => {
    const h = setup();
    try {
      const emitted: unknown[] = [];
      const graph = fakeGraph();
      const store = {
        async update<T>(fn: (graph: ReturnType<typeof fakeGraph>) => T | Promise<T>) {
          return { graph, result: await fn(graph) };
        },
        async save() {},
      };
      const artifactStore = {
        async get() {
          throw new Error("unexpected artifact lookup for final-only run");
        },
        async getBody() {
          throw new Error("unexpected artifact body lookup");
        },
      };

      await runSparkCommandBridge({
        command: command(h.workspace.id),
        workspace: h.workspace,
        route: {
          runtimeId: "rt_11111111111111111111111111111111",
          workspaceBindingId: h.workspace.id,
          workspaceId: "ws_22222222222222222222222222222222",
          projectId: "proj_33333333333333333333333333333333",
          commandId: "cmd_11111111111111111111111111111111",
          ackOf: "msg_11111111111111111111111111111111",
        },
        paths: h.paths,
        db: h.db,
        emit: (message) => emitted.push(message),
        taskGraphStore: store,
        artifactStore,
        executeSparkTask: async (input) => {
          const onRoleEvent = input.onRoleEvent as ((event: unknown) => void) | undefined;
          onRoleEvent?.({
            type: "stream_event",
            event: {
              type: "done",
              message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
            },
          });
          return {
            ref: "run:final-only",
            status: "succeeded",
            outputArtifacts: [],
          };
        },
      });

      const chunks = emitted.filter(
        (value) => (value as { type: string }).type === "invocation.log_chunk",
      ) as Array<{ payload: { stream: string; sequence: number; content: string } }>;
      expect(chunks.map((chunk) => chunk.payload)).toMatchObject([
        { stream: "system", sequence: 1, content: "Spark runtime role-run started." },
        { stream: "assistant", sequence: 2, content: "Final answer" },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it("uses role-run trace artifacts as assistant output when no live chunks were captured", async () => {
    const h = setup();
    try {
      const emitted: unknown[] = [];
      const graph = fakeGraph();
      const store = {
        async update<T>(fn: (graph: ReturnType<typeof fakeGraph>) => T | Promise<T>) {
          return { graph, result: await fn(graph) };
        },
        async save() {},
      };
      const artifactStore = {
        async get(ref: `artifact:${string}`) {
          return {
            ref,
            kind: "trace",
            title: "Spark role run",
            format: "json",
            hash: "hash123",
            provenance: { runRef: "run:artifact", taskRef: "task:artifact" },
          };
        },
        async getBody() {
          return JSON.stringify({
            schemaVersion: 1,
            stdout: { tail: "Artifact-backed answer" },
            stderr: { tail: "" },
            jsonEvents: { count: 0, tail: [] },
          });
        },
      };

      await runSparkCommandBridge({
        command: command(h.workspace.id),
        workspace: h.workspace,
        route: {
          runtimeId: "rt_11111111111111111111111111111111",
          workspaceBindingId: h.workspace.id,
          workspaceId: "ws_22222222222222222222222222222222",
          projectId: "proj_33333333333333333333333333333333",
          commandId: "cmd_11111111111111111111111111111111",
          ackOf: "msg_11111111111111111111111111111111",
        },
        paths: h.paths,
        db: h.db,
        emit: (message) => emitted.push(message),
        taskGraphStore: store,
        artifactStore,
        executeSparkTask: async () => ({
          ref: "run:artifact",
          status: "succeeded",
          outputArtifacts: ["artifact:bridge-output"],
        }),
      });

      expect(emitted.map((value) => (value as { type: string }).type)).toEqual([
        "runtime.command.ack",
        "invocation.updated",
        "task_graph.snapshot",
        "invocation.log_chunk",
        "artifact.projected",
        "invocation.log_chunk",
        "task_graph.snapshot",
        "invocation.updated",
      ]);
      const assistantChunk = emitted.find(
        (value) =>
          (value as { type: string }).type === "invocation.log_chunk" &&
          (value as { payload: { stream: string } }).payload.stream === "assistant",
      ) as { payload: { content: string } };
      expect(assistantChunk.payload.content).toBe("Artifact-backed answer");
    } finally {
      h.cleanup();
    }
  });

  it("keeps streamed chunks and emits useful failure log information when role execution throws", async () => {
    const h = setup();
    try {
      const emitted: unknown[] = [];
      const graph = fakeGraph();
      const store = {
        async update<T>(fn: (graph: ReturnType<typeof fakeGraph>) => T | Promise<T>) {
          return { graph, result: await fn(graph) };
        },
        async save() {},
      };
      const artifactStore = {
        async get() {
          throw new Error("unexpected artifact lookup for thrown failure");
        },
        async getBody() {
          throw new Error("unexpected artifact body lookup");
        },
      };

      const result = await runSparkCommandBridge({
        command: command(h.workspace.id),
        workspace: h.workspace,
        route: {
          runtimeId: "rt_11111111111111111111111111111111",
          workspaceBindingId: h.workspace.id,
          workspaceId: "ws_22222222222222222222222222222222",
          projectId: "proj_33333333333333333333333333333333",
          commandId: "cmd_11111111111111111111111111111111",
          ackOf: "msg_11111111111111111111111111111111",
        },
        paths: h.paths,
        db: h.db,
        emit: (message) => emitted.push(message),
        taskGraphStore: store,
        artifactStore,
        executeSparkTask: async (input) => {
          const onRoleEvent = input.onRoleEvent as ((event: unknown) => void) | undefined;
          onRoleEvent?.({ type: "stream_event", event: { type: "text_delta", delta: "partial" } });
          throw new Error("role exploded");
        },
      });

      expect(result.status).toBe("failed");
      const chunks = emitted.filter(
        (value) => (value as { type: string }).type === "invocation.log_chunk",
      ) as Array<{ payload: { stream: string; sequence: number; content: string } }>;
      expect(chunks.map((chunk) => chunk.payload)).toMatchObject([
        { stream: "system", sequence: 1, content: "Spark runtime role-run started." },
        { stream: "assistant", sequence: 2, content: "partial" },
        { stream: "system", sequence: 3, content: "role exploded" },
      ]);
      expect(
        (emitted.at(-1) as { payload: { status: string; terminalReason?: string } }).payload,
      ).toMatchObject({
        status: "failed",
        terminalReason: "role exploded",
      });
    } finally {
      h.cleanup();
    }
  });

  it("preserves live chunks before a cancelled role-run terminal update", async () => {
    const h = setup();
    try {
      const emitted: unknown[] = [];
      const graph = fakeGraph();
      const store = {
        async update<T>(fn: (graph: ReturnType<typeof fakeGraph>) => T | Promise<T>) {
          return { graph, result: await fn(graph) };
        },
        async save() {},
      };
      const artifactStore = {
        async get() {
          throw new Error("unexpected artifact lookup for cancelled run");
        },
        async getBody() {
          throw new Error("unexpected artifact body lookup");
        },
      };

      const result = await runSparkCommandBridge({
        command: command(h.workspace.id),
        workspace: h.workspace,
        route: {
          runtimeId: "rt_11111111111111111111111111111111",
          workspaceBindingId: h.workspace.id,
          workspaceId: "ws_22222222222222222222222222222222",
          projectId: "proj_33333333333333333333333333333333",
          commandId: "cmd_11111111111111111111111111111111",
          ackOf: "msg_11111111111111111111111111111111",
        },
        paths: h.paths,
        db: h.db,
        emit: (message) => emitted.push(message),
        taskGraphStore: store,
        artifactStore,
        executeSparkTask: async (input) => {
          const onRoleEvent = input.onRoleEvent as ((event: unknown) => void) | undefined;
          onRoleEvent?.({
            type: "stream_event",
            event: { type: "text_delta", delta: "before cancel" },
          });
          return {
            ref: "run:cancelled",
            status: "cancelled",
            errorMessage: "cancelled by user",
            outputArtifacts: [],
          };
        },
      });

      expect(result.status).toBe("cancelled");
      expect(
        emitted.some(
          (value) =>
            (value as { type: string }).type === "invocation.log_chunk" &&
            (value as { payload: { stream?: string; content?: string } }).payload.stream ===
              "assistant" &&
            (value as { payload: { stream?: string; content?: string } }).payload.content ===
              "before cancel",
        ),
      ).toBe(true);
      const terminal = emitted.at(-1) as { payload: { status: string; terminalReason?: string } };
      expect(terminal.payload).toMatchObject({
        status: "cancelled",
        terminalReason: "cancelled by user",
      });
    } finally {
      h.cleanup();
    }
  });

  it("merges daemon wrapper task progress instead of saving a stale graph", async () => {
    const h = setup();
    try {
      const emitted: unknown[] = [];
      const mergedTaskRefs: string[][] = [];
      let currentGraph = fakeGraph((refs) => mergedTaskRefs.push(refs));
      const store = {
        async update<T>(fn: (graph: ReturnType<typeof fakeGraph>) => T | Promise<T>) {
          return { graph: currentGraph, result: await fn(currentGraph) };
        },
        async save() {
          throw new Error("stale full-graph save should not be used");
        },
      };
      const artifactStore = {
        async get() {
          throw new Error("unexpected artifact lookup for merge-only run");
        },
        async getBody() {
          throw new Error("unexpected artifact body lookup");
        },
      };

      const result = await runSparkCommandBridge({
        command: command(h.workspace.id),
        workspace: h.workspace,
        route: {
          runtimeId: "rt_11111111111111111111111111111111",
          workspaceBindingId: h.workspace.id,
          workspaceId: "ws_22222222222222222222222222222222",
          projectId: "proj_33333333333333333333333333333333",
          commandId: "cmd_11111111111111111111111111111111",
          ackOf: "msg_11111111111111111111111111111111",
        },
        paths: h.paths,
        db: h.db,
        emit: (message) => emitted.push(message),
        taskGraphStore: store,
        artifactStore,
        executeSparkTask: async (input) => {
          currentGraph = fakeGraph((refs) => mergedTaskRefs.push(refs));
          const onHeartbeat = input.onHeartbeat as ((graph: unknown) => Promise<void>) | undefined;
          await onHeartbeat?.(input.graph);
          return {
            ref: "run:merged",
            status: "succeeded",
            outputArtifacts: [],
          };
        },
      });

      expect(result.status).toBe("succeeded");
      expect(mergedTaskRefs).toEqual([["task:fake"], ["task:fake"]]);
      expect(emitted.map((value) => (value as { type: string }).type)).toEqual([
        "runtime.command.ack",
        "invocation.updated",
        "task_graph.snapshot",
        "invocation.log_chunk",
        "task_graph.snapshot",
        "invocation.updated",
      ]);
    } finally {
      h.cleanup();
    }
  });

  it("maps Spark failures and carries retry lineage into terminal projections", async () => {
    const h = setup();
    try {
      const emitted: unknown[] = [];
      const graph = fakeGraph();
      const store = {
        async update<T>(fn: (graph: ReturnType<typeof fakeGraph>) => T | Promise<T>) {
          return { graph, result: await fn(graph) };
        },
        async save() {},
      };
      const artifactStore = {
        async get() {
          throw new Error("unexpected artifact lookup for failed run without outputs");
        },
        async getBody() {
          throw new Error("unexpected artifact body lookup");
        },
      };

      const retryOfInvocationId = "inv_retryorigin000000000000000000000";
      const result = await runSparkCommandBridge({
        command: command(h.workspace.id, { prompt: "Retry through Spark", retryOfInvocationId }),
        workspace: h.workspace,
        route: {
          runtimeId: "rt_11111111111111111111111111111111",
          workspaceBindingId: h.workspace.id,
          workspaceId: "ws_22222222222222222222222222222222",
          projectId: "proj_33333333333333333333333333333333",
          commandId: "cmd_11111111111111111111111111111111",
          ackOf: "msg_11111111111111111111111111111111",
        },
        paths: h.paths,
        db: h.db,
        emit: (message) => emitted.push(message),
        taskGraphStore: store,
        artifactStore,
        executeSparkTask: async () => ({
          ref: "run:failed-retry",
          status: "failed",
          errorMessage: "Spark role failed",
          outputArtifacts: [],
        }),
      });

      expect(result.status).toBe("failed");
      const terminal = emitted.at(-1) as {
        type: string;
        payload: { status: string; terminalReason?: string; payload?: Record<string, unknown> };
      };
      expect(terminal.type).toBe("invocation.updated");
      expect(terminal.payload.status).toBe("failed");
      expect(terminal.payload.terminalReason).toBe("Spark role failed");
      expect(terminal.payload.payload).toMatchObject({
        sparkRunRef: "run:failed-retry",
        retryOfInvocationId,
      });
      expect(h.db.prepare("SELECT status FROM invocations").get()).toMatchObject({
        status: "failed",
      });
    } finally {
      h.cleanup();
    }
  });
});

function fakeGraph(onMerge?: (taskRefs: string[]) => void) {
  const projects: Array<{ ref: `proj:${string}`; description: string }> = [];
  const tasks: Array<{ ref: `task:${string}`; name: string }> = [];
  return {
    projects: () => projects,
    tasks: () => tasks,
    createProject(input: { description: string }) {
      const project = { ref: "proj:fake" as const, description: input.description };
      projects.push(project);
      return project;
    },
    createTask(input: { name?: string }) {
      const task = { ref: "task:fake" as const, name: input.name ?? "fake" };
      tasks.push(task);
      return task;
    },
    mergeTaskProgressFrom(
      source: { tasks(): Array<{ ref: `task:${string}`; name: string }> },
      taskRefs: `task:${string}`[],
    ) {
      onMerge?.([...taskRefs]);
      for (const taskRef of taskRefs) {
        const sourceTask = source.tasks().find((task) => task.ref === taskRef);
        if (sourceTask && !tasks.some((task) => task.ref === taskRef)) tasks.push(sourceTask);
      }
    },
  };
}
