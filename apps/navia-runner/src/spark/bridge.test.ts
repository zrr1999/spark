import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
} from "@zendev-lab/navia-protocol";
import { resolveNaviaPaths } from "@zendev-lab/navia-system";
import { openRunnerDatabase } from "../store/schema.js";
import { addWorkspace } from "../store/workspaces.js";
import { runNaviaCommandThroughSpark } from "./bridge.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "navia-spark-bridge-"));
  const paths = resolveNaviaPaths({
    app: "runner",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const db = openRunnerDatabase(paths);
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

describe("Navia Spark bridge", () => {
  it("executes through the injected Spark task runner and projects Spark artifacts", async () => {
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

      const result = await runNaviaCommandThroughSpark({
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
      expect(h.db.prepare("SELECT status FROM invocations").get()).toMatchObject({
        status: "succeeded",
      });
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
      const result = await runNaviaCommandThroughSpark({
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

function fakeGraph() {
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
  };
}
