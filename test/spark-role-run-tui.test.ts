import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Project,
  ProjectRef,
  RoleRef,
  RunRef,
  Task,
  TaskRef,
  TaskRun,
} from "@zendev-lab/spark-extension-api";
import { TaskGraph, defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

import sparkExtension from "../packages/spark-extension/src/extension/index.ts";
import {
  buildSparkRoleRunRegistry,
  type SparkRoleRunRegistryEntry,
} from "../packages/spark-extension/src/extension/spark-role-run-observability.ts";
import { roleRunTaskInfoByRefForTests } from "../packages/spark-extension/src/extension/spark-role-run-tui-controller.ts";
import type {
  SparkWidgetTheme,
  SparkWidgetTui,
} from "../packages/spark-extension/src/ui/spark-widget.ts";
import {
  formatSparkRoleRunStatusSummary,
  renderSparkRoleRunBoardLines,
  renderSparkRoleRunCompletionMessageLines,
} from "../packages/spark-extension/src/ui/spark-role-run-tui.ts";

type SparkPi = Parameters<typeof sparkExtension>[0];
type SparkToolConfig = Parameters<NonNullable<SparkPi["registerTool"]>>[0];
type SparkEventHandler = Parameters<NonNullable<SparkPi["on"]>>[1];
type MessageRenderer =
  NonNullable<SparkPi["registerMessageRenderer"]> extends (_type: string, renderer: infer T) => void
    ? T
    : never;

type WidgetCall = {
  key: string;
  cb: unknown;
  opts?: { placement?: string };
};

type TestSparkContext = {
  cwd: string;
  hasUI: true;
  sessionManager: {
    getSessionFile(): string;
    getLeafId(): string;
  };
  ui: {
    setWidget(key: string, cb: unknown, opts?: { placement?: string }): void;
    setStatus(key: string, text: string | undefined): void;
  };
};

const projectRef = "proj:role-tui" as ProjectRef;
const taskRef = "task:role-tui" as TaskRef;
const roleRef = "role:builtin-worker" as RoleRef;

const theme: SparkWidgetTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

function requireTool(tools: Map<string, SparkToolConfig>, name: string): SparkToolConfig {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool registration: ${name}`);
  return tool;
}

async function executeTool(
  tool: SparkToolConfig,
  params: Record<string, unknown>,
  ctx: TestSparkContext,
): Promise<Awaited<ReturnType<SparkToolConfig["execute"]>>> {
  return tool.execute("tool-call", params, new AbortController().signal, () => {}, ctx);
}

function graphWithRuns(runs: TaskRun[]): TaskGraph {
  const now = "2026-06-17T00:00:00.000Z";
  const project: Project = {
    ref: projectRef,
    title: "Role TUI project",
    description: "role tui",
    roadmap: {
      ref: "roadmap:role-tui",
      title: "Role TUI project",
      items: [],
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
  const task: Task = {
    ref: taskRef,
    projectRef,
    name: "role-tui-task",
    title: "Render role runs",
    description: "render role runs",
    kind: "implement",
    status: "running",
    roleRef,
    supersededBy: [],
    inputArtifacts: [],
    outputArtifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  return TaskGraph.fromSnapshot({ projects: [project], tasks: [task], dependencies: [], runs });
}

function taskRun(input: Partial<TaskRun> & { ref: RunRef }): TaskRun {
  const { ref, ...overrides } = input;
  return {
    ref,
    projectRef,
    taskRef,
    roleRef,
    runName: "worker-1",
    ownerSessionId: "session:test",
    status: "running",
    startedAt: "2026-06-17T00:00:01.000Z",
    outputArtifacts: [],
    ...overrides,
  };
}

void test("Spark role-run TUI renderer produces bounded board and status summaries", () => {
  const running = taskRun({ ref: "run:aaaaaaaa11111111" as RunRef });
  const failed = taskRun({
    ref: "run:bbbbbbbb22222222" as RunRef,
    status: "failed",
    finishedAt: "2026-06-17T00:00:20.000Z",
    errorMessage: "boom",
  });
  const snapshot = buildSparkRoleRunRegistry({
    graph: graphWithRuns([running, failed]),
    now: "2026-06-17T00:00:30.000Z",
    activityEvents: [
      {
        runRef: running.ref,
        type: "tool_activity",
        at: "2026-06-17T00:00:10.000Z",
        toolName: "edit",
      },
    ],
    usageByRunRef: {
      [running.ref]: { totalTokens: 12_345, costUsd: 0.1234, model: "test-model" },
    },
  });

  assert.equal(formatSparkRoleRunStatusSummary(snapshot), "roles: failed=1 interrupted=1");
  const lines = renderSparkRoleRunBoardLines(
    snapshot,
    roleRunTaskInfoByRefForTests([
      { ref: taskRef, name: "role-tui-task", title: "Render role runs" },
    ]),
    { width: 100, maxLines: 3, now: "2026-06-17T00:00:30.000Z" },
    theme,
  );

  assert.equal(lines.length, 3);
  assert.match(lines.join("\n"), /Role runs \(failed=1/);
  assert.match(lines.join("\n"), /worker @role-tui-task/);
  assert.match(lines.join("\n"), /(tool edit|non-terminal)/);
});

void test("Spark role-run completion message renderer supports compact and expanded details", () => {
  const run = taskRun({
    ref: "run:cccccccc33333333" as RunRef,
    status: "succeeded",
    finishedAt: "2026-06-17T00:00:12.000Z",
    outputArtifacts: ["artifact:trace"],
  });
  const snapshot = buildSparkRoleRunRegistry({ graph: graphWithRuns([run]) });
  const entry = snapshot.entries[0] as SparkRoleRunRegistryEntry;

  const compact = renderSparkRoleRunCompletionMessageLines(entry, { width: 120 }, theme).join("\n");
  assert.match(compact, /worker completed run:cccccccc/);
  assert.match(compact, /artifacts: artifact:trace/);

  const expanded = renderSparkRoleRunCompletionMessageLines(
    entry,
    { width: 120, expanded: true },
    theme,
  ).join("\n");
  assert.match(expanded, /task: task:role-tui/);
  assert.match(expanded, /completed/);
});

void test("Spark extension role-run surfaces are no-op safe without UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-role-run-tui-no-ui-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const run = taskRun({
      ref: "run:eeeeeeee55555555" as RunRef,
      status: "succeeded",
      finishedAt: "2026-06-17T00:00:12.000Z",
      outputArtifacts: ["artifact:trace"],
    });
    const graph = graphWithRuns([run]);
    await defaultTaskGraphStore(dir).save(graph);

    const tools = new Map<string, SparkToolConfig>();
    const handlers = new Map<string, SparkEventHandler[]>();
    const messages: Array<{ customType: string; content: string }> = [];
    const ctx = {
      cwd: dir,
      hasUI: false,
      sessionManager: {
        getSessionFile: () => join(dir, "session.json"),
        getLeafId: () => "leaf-role-run-tui-no-ui",
      },
    } as unknown as TestSparkContext;
    const pi: SparkPi = {
      registerCommand() {},
      registerTool(config) {
        tools.set(config.name, config);
      },
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendMessage(message) {
        messages.push(message as { customType: string; content: string });
      },
    };
    sparkExtension(pi);

    await executeTool(
      requireTool(tools, "task_write"),
      { action: "project_use", project: projectRef },
      ctx,
    );
    for (const handler of handlers.get("session_tree") ?? []) await handler({}, ctx);

    assert.deepEqual(messages, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark extension publishes role-run footer status, below-editor widget, and completion message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-role-run-tui-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = graphWithRuns([]);
    const graphStore = defaultTaskGraphStore(dir);
    await graphStore.save(graph);

    const tools = new Map<string, SparkToolConfig>();
    const handlers = new Map<string, SparkEventHandler[]>();
    const widgetCalls: WidgetCall[] = [];
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const messages: Array<{
      customType: string;
      content: string;
      details?: Record<string, unknown>;
    }> = [];
    const messageRenderers = new Map<string, MessageRenderer>();
    let sparkStatusWidget: { render(): string[]; invalidate(): void } | undefined;
    const widgetTui: SparkWidgetTui = { terminal: { columns: 160 }, requestRender() {} };
    const ctx: TestSparkContext = {
      cwd: dir,
      hasUI: true,
      sessionManager: {
        getSessionFile: () => join(dir, "session.json"),
        getLeafId: () => "leaf-role-run-tui",
      },
      ui: {
        setWidget(key, cb, opts) {
          widgetCalls.push({ key, cb, opts });
          if (key === "spark-status" && typeof cb === "function") {
            sparkStatusWidget = (
              cb as (
                tui: SparkWidgetTui,
                theme: SparkWidgetTheme,
              ) => { render(): string[]; invalidate(): void }
            )(widgetTui, theme);
          }
        },
        setStatus(key, text) {
          statuses.push({ key, text });
        },
      },
    };
    const pi: SparkPi = {
      registerCommand() {},
      registerTool(config) {
        tools.set(config.name, config);
      },
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendMessage(message) {
        messages.push(
          message as { customType: string; content: string; details?: Record<string, unknown> },
        );
      },
      registerMessageRenderer(customType, renderer) {
        messageRenderers.set(customType, renderer as MessageRenderer);
      },
    };
    sparkExtension(pi);

    assert.ok(messageRenderers.has("spark-role-run-completion"));
    await executeTool(
      requireTool(tools, "task_write"),
      { action: "project_use", project: projectRef },
      ctx,
    );
    assert.ok(sparkStatusWidget);

    const running = taskRun({ ref: "run:dddddddd44444444" as RunRef });
    await graphStore.update((latest) => {
      latest.recordRun(running);
    });
    for (const handler of handlers.get("session_tree") ?? []) await handler({}, ctx);

    assert.equal(messages.length, 0);
    assert.deepEqual(statuses.at(-1), { key: "spark-role-runs", text: "roles: stale=1" });
    const roleWidget = [...widgetCalls]
      .reverse()
      .find((call: WidgetCall) => call.key === "spark-role-runs");
    assert.deepEqual(roleWidget?.opts, { placement: "belowEditor" });
    assert.ok(roleWidget);
    assert.ok(Array.isArray(roleWidget.cb));
    const roleWidgetText = roleWidget.cb.join("\n");
    assert.match(roleWidgetText, /Role runs \(stale=1\)/);
    assert.match(roleWidgetText, /@role-tui-task/);

    await graphStore.update((latest) => {
      latest.recordRun({
        ...running,
        status: "succeeded",
        finishedAt: "2026-06-17T00:00:12.000Z",
        outputArtifacts: ["artifact:trace"],
      });
    });
    for (const handler of handlers.get("session_tree") ?? []) await handler({}, ctx);

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.customType, "spark-role-run-completion");
    assert.match(messages[0]?.content ?? "", /worker completed: run:dddddddd/);
    const renderer = messageRenderers.get("spark-role-run-completion");
    assert.ok(renderer);
    const rendered = renderer(
      { content: messages[0]!.content, details: messages[0]!.details },
      { expanded: true },
      theme,
    )
      ?.render(120)
      .join("\n");
    assert.match(rendered ?? "", /artifact:trace/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
