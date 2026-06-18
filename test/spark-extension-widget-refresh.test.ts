import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sparkExtension from "../packages/spark/src/extension/index.ts";
import type { SparkWidgetTheme, SparkWidgetTui } from "../packages/spark/src/ui/spark-widget.ts";
import { RoleRegistry, builtinRoleRef } from "@zendev-lab/pi-roles";
import { defaultWorkflowRunStore } from "../packages/pi-workflows/src/index.ts";
import {
  killActiveSparkRoleRunProcesses,
  listActiveSparkRoleRunProcesses,
  runSparkTask,
} from "@zendev-lab/spark-runtime";
import type { RunRef, TaskPlan } from "@zendev-lab/pi-extension-api";
import { TaskGraph, defaultTaskGraphStore } from "@zendev-lab/pi-tasks";
import {
  setSessionGoal,
  updateSessionGoalStatus,
} from "../packages/spark/src/extension/spark-session-goals.ts";

type SparkPi = Parameters<typeof sparkExtension>[0];
type SparkToolConfig = Parameters<NonNullable<SparkPi["registerTool"]>>[0];
type SparkEventHandler = Parameters<NonNullable<SparkPi["on"]>>[1];
type WidgetComponent = { render(): string[]; invalidate(): void };
type WidgetFactory = (tui: SparkWidgetTui, theme: SparkWidgetTheme) => WidgetComponent;

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
  };
};

const theme: SparkWidgetTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

function isWidgetFactory(value: unknown): value is WidgetFactory {
  return typeof value === "function";
}

function requireTool(tools: Map<string, SparkToolConfig>, name: string): SparkToolConfig {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool registration: ${name}`);
  return tool;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, "condition was not met before timeout");
}

function executionReadyPlan(objective: string): TaskPlan {
  return {
    objective,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`${objective} succeeds`],
    evidenceRequired: [`${objective} evidence is recorded`],
    steps: [objective],
    riskLevel: "normal",
    openQuestions: [],
    askRefs: [],
  };
}

async function executeTool(
  tool: SparkToolConfig,
  params: Record<string, unknown>,
  ctx: TestSparkContext,
): Promise<Awaited<ReturnType<SparkToolConfig["execute"]>>> {
  return tool.execute("tool-call", params, new AbortController().signal, () => {}, ctx);
}

void test("Spark extension widget hides acknowledged DAG history and shows actionable failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-extension-widget-dag-history-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Widget DAG project", description: "widget dag" });
    await defaultTaskGraphStore(dir).save(graph);

    const tools = new Map<string, SparkToolConfig>();
    const handlers = new Map<string, SparkEventHandler>();
    let widgetComponent: WidgetComponent | undefined;
    const widgetTui: SparkWidgetTui = {
      terminal: { columns: 160 },
      requestRender() {},
    };
    const ctx: TestSparkContext = {
      cwd: dir,
      hasUI: true,
      sessionManager: {
        getSessionFile: () => join(dir, "session.json"),
        getLeafId: () => "leaf-widget-dag-history",
      },
      ui: {
        setWidget(key, cb) {
          if (key === "spark-status")
            widgetComponent = isWidgetFactory(cb) ? cb(widgetTui, theme) : undefined;
        },
      },
    };
    const pi: SparkPi = {
      registerCommand() {},
      registerTool(config) {
        tools.set(config.name, config);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
      sendMessage() {},
    };
    sparkExtension(pi);

    await executeTool(
      requireTool(tools, "task_write"),
      { action: "project_use", project: project.ref },
      ctx,
    );
    assert.ok(widgetComponent);
    assert.doesNotMatch(widgetComponent.render().join("\n"), /Background work:/);

    const dagStore = defaultWorkflowRunStore(dir);
    const acknowledgedRun = await dagStore.startRun({
      projectRef: project.ref,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await dagStore.finishRun(acknowledgedRun.ref, {
      scheduled: 1,
      completed: 0,
      failed: 1,
      cancelled: 0,
      timedOut: false,
    });
    await dagStore.acknowledgeFailures({ runRef: acknowledgedRun.ref, sessionId: "session:test" });
    await handlers.get("session_tree")?.({}, ctx);
    assert.doesNotMatch(widgetComponent.render().join("\n"), /Background work:/);

    const actionableRun = await dagStore.startRun({
      projectRef: project.ref,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await dagStore.finishRun(actionableRun.ref, {
      scheduled: 2,
      completed: 1,
      failed: 1,
      cancelled: 0,
      timedOut: false,
    });
    await handlers.get("session_tree")?.({}, ctx);
    assert.match(
      widgetComponent.render().join("\n"),
      /Background work: 1\/2 tasks finished · failed · run:/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark extension widget reconciles stale DAG records when an owned child run is still active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-extension-widget-dag-reconcile-"));
  let runPromise: Promise<unknown> | undefined;
  let activeRunRef: RunRef | undefined;
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Widget DAG reconcile",
      description: "widget dag",
    });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Long running widget task",
      description: "Keep the child process active while the widget refreshes.",
      roleRef: builtinRoleRef("worker"),
      plan: executionReadyPlan("Keep the widget DAG active"),
    });
    const graphStore = defaultTaskGraphStore(dir);
    await graphStore.save(graph);

    const tools = new Map<string, SparkToolConfig>();
    const handlers = new Map<string, SparkEventHandler>();
    let widgetComponent: WidgetComponent | undefined;
    const widgetTui: SparkWidgetTui = {
      terminal: { columns: 160 },
      requestRender() {},
    };
    const ctx: TestSparkContext = {
      cwd: dir,
      hasUI: true,
      sessionManager: {
        getSessionFile: () => join(dir, "session.json"),
        getLeafId: () => "leaf-widget-dag-reconcile",
      },
      ui: {
        setWidget(key, cb) {
          if (key === "spark-status")
            widgetComponent = isWidgetFactory(cb) ? cb(widgetTui, theme) : undefined;
        },
      },
    };
    const pi: SparkPi = {
      registerCommand() {},
      registerTool(config) {
        tools.set(config.name, config);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
      sendMessage() {},
    };
    sparkExtension(pi);
    await executeTool(
      requireTool(tools, "task_write"),
      { action: "project_use", project: project.ref },
      ctx,
    );
    assert.ok(widgetComponent);

    const dagStore = defaultWorkflowRunStore(dir);
    const dagRun = await dagStore.startRun({
      projectRef: project.ref,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await dagStore.recordSchedule(dagRun.ref, { taskRef: task.ref, scheduled: 1 });
    await dagStore.reconcile({ graph, activeRunRefs: [] });
    await handlers.get("session_tree")?.({}, ctx);
    assert.match(
      widgetComponent.render().join("\n"),
      /Background work: 0\/1 tasks finished · stale/,
    );

    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);
    runPromise = runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      timeoutMs: 10_000,
      claim: { sessionId: "session:widget" },
    }).catch((error: unknown) => error);
    await waitFor(() => listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir));
    const activeProcess = listActiveSparkRoleRunProcesses().find((process) => process.cwd === dir);
    assert.ok(activeProcess);
    activeRunRef = activeProcess.runRef;
    await graphStore.update((latest) => {
      latest.mergeTaskProgressFrom(graph, [task.ref]);
    });

    await handlers.get("session_tree")?.({}, ctx);

    assert.match(
      widgetComponent.render().join("\n"),
      /Background work: 0\/1 tasks finished · running/,
    );
    const revived = await dagStore.load();
    const [record] = revived.runs;
    assert.equal(record?.status, "running");
    assert.deepEqual(record?.taskRunRefs, [activeProcess.runRef]);
  } finally {
    if (activeRunRef)
      await killActiveSparkRoleRunProcesses({
        runRef: activeRunRef,
        forceAfterMs: 0,
        waitMs: 1_000,
      });
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await runPromise?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark extension widget shows session goal without project state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-extension-widget-goal-no-project-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });

    const handlers = new Map<string, SparkEventHandler>();
    let widgetComponent: WidgetComponent | undefined;
    const widgetTui: SparkWidgetTui = {
      terminal: { columns: 160 },
      requestRender() {},
    };
    const ctx: TestSparkContext = {
      cwd: dir,
      hasUI: true,
      sessionManager: {
        getSessionFile: () => join(dir, "session.json"),
        getLeafId: () => "leaf-widget-goal-no-project",
      },
      ui: {
        setWidget(key, cb) {
          if (key === "spark-status")
            widgetComponent = isWidgetFactory(cb) ? cb(widgetTui, theme) : undefined;
        },
      },
    };
    const pi: SparkPi = {
      registerCommand() {},
      registerTool() {},
      on(event, handler) {
        handlers.set(event, handler);
      },
      sendMessage() {},
    };
    sparkExtension(pi);

    await setSessionGoal(dir, ctx, {
      objective: "Completed standalone goal remains visible",
      source: "explicit",
      status: "active",
    });
    await updateSessionGoalStatus(dir, ctx, "complete", { reason: "review passed" });
    await handlers.get("session_tree")?.({}, ctx);

    assert.ok(widgetComponent);
    const rendered = widgetComponent.render().join("\n");
    assert.match(rendered, /Goal\(✓\): Completed standalone goal remains visible/);
    assert.doesNotMatch(rendered, /Task/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark session_start creates .spark and shows session goal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-extension-session-start-goal-"));
  try {
    const handlers = new Map<string, SparkEventHandler[]>();
    let widgetComponent: WidgetComponent | undefined;
    const widgetTui: SparkWidgetTui = {
      terminal: { columns: 160 },
      requestRender() {},
    };
    const ctx: TestSparkContext = {
      cwd: dir,
      hasUI: true,
      sessionManager: {
        getSessionFile: () => join(dir, "session.json"),
        getLeafId: () => "leaf-session-start-goal",
      },
      ui: {
        setWidget(key, cb) {
          if (key === "spark-status")
            widgetComponent = isWidgetFactory(cb) ? cb(widgetTui, theme) : undefined;
        },
      },
    };
    const pi: SparkPi = {
      registerCommand() {},
      registerTool() {},
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendMessage() {},
    };
    sparkExtension(pi);

    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    assert.ok(await stat(join(dir, ".spark")));

    await setSessionGoal(dir, ctx, {
      objective: "Session goal survives an empty workspace",
      source: "explicit",
      status: "active",
    });
    for (const handler of handlers.get("session_tree") ?? []) await handler({}, ctx);

    assert.ok(widgetComponent);
    const rendered = widgetComponent.render().join("\n");
    assert.match(rendered, /Goal\([●◉]\): Session goal survives an empty workspace/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark extension refreshes SparkWidget after claim and TODO tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-extension-widget-refresh-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    graph.createProject({ title: "Widget refresh project", description: "widget refresh" });
    await defaultTaskGraphStore(dir).save(graph);

    const tools = new Map<string, SparkToolConfig>();
    const handlers = new Map<string, SparkEventHandler[]>();
    const widgetCalls: WidgetCall[] = [];
    let widgetComponent: WidgetComponent | undefined;
    let renderRequests = 0;
    const widgetTui: SparkWidgetTui = {
      terminal: { columns: 160 },
      requestRender() {
        renderRequests += 1;
      },
    };
    const ctx: TestSparkContext = {
      cwd: dir,
      hasUI: true,
      sessionManager: {
        getSessionFile: () => join(dir, "session.json"),
        getLeafId: () => "leaf-widget-refresh",
      },
      ui: {
        setWidget(key, cb, opts) {
          widgetCalls.push({ key, cb, opts });
          if (key === "spark-status")
            widgetComponent = isWidgetFactory(cb) ? cb(widgetTui, theme) : undefined;
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
      sendMessage() {},
    };
    sparkExtension(pi);

    await executeTool(
      requireTool(tools, "task_write"),
      { action: "project_use", project: "Widget refresh project" },
      ctx,
    );
    assert.equal(widgetCalls.length, 1);
    assert.ok(widgetComponent);
    assert.match(widgetComponent.render().join("\n"), /Widget refresh project/);

    await executeTool(
      requireTool(tools, "task_write"),
      {
        action: "claim",
        title: "Widget refresh task",
        description: "Exercise widget refresh after claim.",
        kind: "implement",
        plan: executionReadyPlan("Exercise widget refresh after claim."),
      },
      ctx,
    );
    assert.equal(widgetCalls.length, 1);
    assert.equal(widgetCalls[0]?.key, "spark-status");
    assert.deepEqual(widgetCalls[0]?.opts, { placement: "aboveEditor" });
    assert.equal(renderRequests, 1);
    assert.match(widgetComponent.render().join("\n"), /→ @me Widget refresh task/);
    assert.doesNotMatch(widgetComponent.render().join("\n"), /First child TODO/);

    for (const handler of handlers.get("tool_execution_end") ?? [])
      await handler({ toolName: "task_write" }, ctx);
    assert.equal(renderRequests, 2);

    await executeTool(
      requireTool(tools, "task_write"),
      {
        action: "todo_update",
        scope: "task",
        ops: [
          { op: "init", items: ["First child TODO"] },
          { op: "done", item: "First child TODO" },
          { op: "append", items: ["Second child TODO"] },
        ],
      },
      ctx,
    );
    assert.equal(widgetCalls.length, 1);
    assert.equal(renderRequests, 3);
    assert.match(widgetComponent.render().join("\n"), /First child TODO/);
    assert.match(widgetComponent.render().join("\n"), /Second child TODO/);

    for (const handler of handlers.get("tool_execution_end") ?? [])
      await handler({ toolName: "task_write" }, ctx);
    assert.equal(renderRequests, 4);

    await executeTool(
      requireTool(tools, "task_write"),
      {
        action: "todo_update",
        scope: "session",
        ops: [{ op: "append", items: ["Independent session TODO"] }],
      },
      ctx,
    );
    assert.equal(widgetCalls.length, 1);
    assert.equal(renderRequests, 5);
    assert.match(widgetComponent.render().join("\n"), /Independent session TODO/);

    for (const handler of handlers.get("tool_execution_end") ?? [])
      await handler({ toolName: "task_write" }, ctx);
    assert.equal(renderRequests, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
