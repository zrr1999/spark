import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stableId, type TaskRef, type ThreadRef } from "spark-core";
import { defaultTaskGraphStore, defaultTaskTodoStore, TaskGraph } from "spark-tasks";
import sparkExtension from "../packages/spark/src/extension/index.ts";

type SparkExtensionApiForTest = Parameters<typeof sparkExtension>[0];
type SparkToolConfig = Parameters<NonNullable<SparkExtensionApiForTest["registerTool"]>>[0];
type SparkToolResult = Awaited<ReturnType<SparkToolConfig["execute"]>>;

type TestSparkContext = {
  cwd: string;
  sessionManager: {
    getSessionFile: () => string | undefined;
    getLeafId: () => string | undefined;
  };
  hasUI: boolean;
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error" | "success") => void;
    setWidget: (key: string, cb: unknown, opts?: { placement?: string }) => void;
    setStatus: (key: string, text: string | undefined) => void;
    confirm: (title: string, message: string) => Promise<boolean>;
    input: (title: string, defaultValue?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
  };
};

interface TaskTodoStoreFile {
  version: 1;
  todos: Array<{
    taskRef: string;
    content: string;
    status: string;
    notes?: string[];
  }>;
}

interface IndependentTodoStoreFile {
  version: 1;
  todos: Array<{
    id?: string;
    content: string;
    status: string;
    notes?: string[];
  }>;
}

void test("spark_claim_task and spark_update_task_todos persist task TODOs across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-todos-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "persist-todos",
      title: "Persist task TODOs",
      description: "Exercise task-scoped TODO persistence through Spark tools.",
      kind: "implement",
      todos: ["Read sources", "Run focused tests"],
    });
    const claimedTask = claim.details?.task as
      | {
          ref?: TaskRef;
          name?: string;
          claim?: { sessionId?: string };
          claimedBySession?: string;
        }
      | undefined;
    assert.equal(claimedTask?.name, "persist-todos");
    assert.ok(claimedTask?.ref);
    assert.equal(claimedTask.claim?.sessionId, ctxSessionKey(ctx));
    assert.equal(claimedTask.claimedBySession, ctxSessionKey(ctx));

    const todoFile = sessionTaskTodoPath(dir, ctx);
    const afterClaim = JSON.parse(await readFile(todoFile, "utf8")) as TaskTodoStoreFile;
    assert.equal(afterClaim.version, 1);
    assert.equal(afterClaim.todos.length, 2);
    assert.deepEqual(
      afterClaim.todos.map((todo) => [todo.content, todo.status]),
      [
        ["Read sources", "in_progress"],
        ["Run focused tests", "pending"],
      ],
    );
    assert.doesNotMatch(await readFile(join(dir, ".spark", "thread.json"), "utf8"), /Read sources/);

    await executeSparkTool(tools, "spark_update_task_todos", ctx, {
      ops: [
        { op: "done", item: "Read sources" },
        { op: "append", items: ["Check reload"] },
        { op: "note", item: "Run focused tests", text: "Persisted after reload" },
      ],
    });

    const afterUpdate = JSON.parse(await readFile(todoFile, "utf8")) as TaskTodoStoreFile;
    assert.deepEqual(
      afterUpdate.todos.map((todo) => [todo.content, todo.status, todo.notes ?? []]),
      [
        ["Read sources", "done", []],
        ["Run focused tests", "in_progress", ["Persisted after reload"]],
        ["Check reload", "pending", []],
      ],
    );

    const reloadedGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(reloadedGraph);
    await defaultTaskTodoStore(dir, ctxSessionKey(ctx)).hydrate(reloadedGraph);
    assert.deepEqual(
      reloadedGraph.taskTodos(claimedTask.ref).map((todo) => [todo.content, todo.status]),
      [
        ["Read sources", "done"],
        ["Run focused tests", "in_progress"],
        ["Check reload", "pending"],
      ],
    );

    const reloaded = registerSparkToolsForTest();
    const status = await executeSparkTool(reloaded.tools, "spark_status", ctx, {});
    const statusText = toolText(status);
    assert.match(statusText, /Persist task TODOs/);
    assert.match(statusText, /\[done\].*Read sources/);
    assert.match(statusText, /\[in_progress\].*Run focused tests/);
    assert.match(statusText, /\[pending\].*Check reload/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark rename tools improve obvious placeholder thread and generic task names without changing refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-rename-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "「自定义输入」", description: "placeholder" });
    const generic = graph.createTask({
      threadRef: thread.ref,
      name: "capture-project-intent",
      title: "Capture project intent",
      description: "Old broad placeholder task.",
      kind: "interaction",
      status: "running",
    });
    const existing = graph.createTask({
      threadRef: thread.ref,
      name: "implement-safe-naming",
      title: "Other naming task",
      description: "Ensure rename conflict suffixes are safe.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const renamedThread = await executeSparkTool(tools, "spark_rename_thread", ctx, {
      title: "Autonomous Spark naming quality",
      description: "Improve obvious placeholder Spark display names.",
    });
    const renamedThreadDetails = renamedThread.details?.thread as
      | { ref?: ThreadRef; title?: string }
      | undefined;
    assert.equal(renamedThreadDetails?.ref, thread.ref);
    assert.equal(renamedThreadDetails?.title, "Autonomous Spark naming quality");

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      title: "Implement safe naming",
      description: "Update generic task display names while preserving stable refs.",
      kind: "implement",
    });
    const claimedTask = claim.details?.task as
      | { ref?: TaskRef; name?: string; title?: string }
      | undefined;
    assert.equal(claimedTask?.ref, generic.ref);
    assert.equal(claimedTask?.title, "Implement safe naming");
    assert.equal(claimedTask?.name, "implement-safe-naming-2");

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getThread(thread.ref).title, "Autonomous Spark naming quality");
    assert.equal(loaded.getTask(generic.ref).name, "implement-safe-naming-2");
    assert.equal(loaded.getTask(existing.ref).name, "implement-safe-naming");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task preserves intentional task names when only the title improves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-intentional-name-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Hypha v0", description: "intentional" });
    const task = graph.createTask({
      threadRef: thread.ref,
      name: "hypha-v0",
      title: "Current task",
      description: "Generic title, intentional @name.",
      kind: "interaction",
      status: "running",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      title: "Implement editor diagnostics slice",
      description: "Narrow the active Hypha work without replacing the intentional handle.",
      kind: "implement",
    });
    const claimedTask = claim.details?.task as
      | { ref?: TaskRef; name?: string; title?: string }
      | undefined;
    assert.equal(claimedTask?.ref, task.ref);
    assert.equal(claimedTask?.name, "hypha-v0");
    assert.equal(claimedTask?.title, "Implement editor diagnostics slice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_status activates the first thread as current for the Pi session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-activates-thread-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "status-activates");
    const { tools } = registerSparkToolsForTest();

    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    const statusText = toolText(status);

    assert.match(statusText, /Tool persistence \[current\]/);
    const statusDetails = status.details as
      | { activeThreadRef?: string; threads?: Array<{ ref?: string }> }
      | undefined;
    assert.equal(statusDetails?.activeThreadRef, statusDetails?.threads?.[0]?.ref);
    await readFile(
      join(dir, ".spark", "current-thread", `${ctxSessionStoreScope(ctx)}.json`),
      "utf8",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_status defaults to active view, supports full history, summary, and limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-views-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const otherCtx = testSparkContext(dir, "other");
    const sessionKey = ctxSessionKey(ctx);
    const otherSessionKey = ctxSessionKey(otherCtx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [thread] = graph.threads();
    assert.ok(thread);
    graph.createTask({
      threadRef: thread.ref,
      name: "mine",
      title: "Mine running task",
      description: "Visible unfinished work for the current session.",
      kind: "implement",
      status: "running",
      claimedBySession: sessionKey,
    });
    graph.createTask({
      threadRef: thread.ref,
      name: "other",
      title: "Other pending task",
      description: "Visible unfinished work from another session.",
      kind: "review",
      status: "pending",
      claimedBySession: otherSessionKey,
    });
    graph.createTask({
      threadRef: thread.ref,
      name: "finished",
      title: "Finished task history",
      description: "Hidden from active view unless full history is requested.",
      kind: "generic",
      status: "done",
    });
    graph.createTask({
      threadRef: thread.ref,
      name: "cancelled",
      title: "Cancelled task history",
      description: "Hidden from active view unless full history is requested.",
      kind: "generic",
      status: "cancelled",
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    const active = await executeSparkTool(tools, "spark_status", ctx, {});
    const activeText = toolText(active);
    assert.match(activeText, /Spark tasks \(active view, limit=20\):/);
    assert.match(activeText, /Tool persistence \[current\]/);
    assert.match(activeText, /Active\/current tasks:/);
    assert.match(activeText, /Mine running task/);
    assert.match(activeText, /Other pending task/);
    assert.doesNotMatch(activeText, /Finished task history/);
    assert.doesNotMatch(activeText, /Cancelled task history/);
    assert.match(activeText, /Hidden finished tasks: 2 \(use view=full to include\)/);
    assert.equal(active.details?.view, "active");
    assert.equal(active.details?.limit, 20);
    assert.equal(active.details?.activeThreadRef, thread.ref);

    const limited = await executeSparkTool(tools, "spark_status", ctx, { limit: 1 });
    const limitedText = toolText(limited);
    assert.match(limitedText, /Spark tasks \(active view, limit=1\):/);
    assert.match(limitedText, /Hidden by limit: 1/);
    assert.equal((limitedText.match(/^  - \[/gm) ?? []).length, 1);

    const summary = await executeSparkTool(tools, "spark_status", ctx, { view: "summary" });
    const summaryText = toolText(summary);
    assert.match(summaryText, /Spark tasks \(summary view\):/);
    assert.match(summaryText, /Tasks: 4 total/);
    assert.doesNotMatch(summaryText, /Active\/current tasks:/);
    assert.doesNotMatch(summaryText, /^  - \[/m);
    assert.equal(summary.details?.view, "summary");
    assert.equal(summary.details?.limit, undefined);

    const full = await executeSparkTool(tools, "spark_status", ctx, { view: "full" });
    const fullText = toolText(full);
    assert.match(fullText, /Spark tasks \(full view\):/);
    assert.match(fullText, /Durable tasks:/);
    assert.match(fullText, /Finished task history/);
    assert.match(fullText, /Cancelled task history/);
    assert.doesNotMatch(fullText, /Hidden finished tasks/);
    assert.equal(full.details?.view, "full");
    assert.equal(full.details?.limit, undefined);

    const fullFromLegacyFlag = await executeSparkTool(tools, "spark_status", ctx, {
      showFinished: true,
    });
    assert.equal(fullFromLegacyFlag.details?.view, "full");
    assert.match(toolText(fullFromLegacyFlag), /Finished task history/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_update_todos persists independent session TODOs across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todos-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "spark_update_todos", ctx, {
      ops: [
        { op: "init", items: ["Coordinate review", "Summarize result"] },
        { op: "done", item: "Coordinate review" },
        { op: "append", items: ["Archive notes"] },
        { op: "note", item: "Summarize result", text: "Visible after reload" },
      ],
    });

    const todoFile = sessionIndependentTodoPath(dir, ctx);
    const stored = JSON.parse(await readFile(todoFile, "utf8")) as IndependentTodoStoreFile;
    assert.equal(stored.version, 1);
    assert.deepEqual(
      stored.todos.map((todo) => [todo.content, todo.status, todo.notes ?? []]),
      [
        ["Coordinate review", "done", []],
        ["Summarize result", "in_progress", ["Visible after reload"]],
        ["Archive notes", "pending", []],
      ],
    );
    assert.doesNotMatch(
      await readFile(join(dir, ".spark", "thread.json"), "utf8"),
      /Coordinate review/,
    );

    const reloaded = registerSparkToolsForTest();
    const status = await executeSparkTool(reloaded.tools, "spark_status", ctx, {});
    const statusText = toolText(status);
    assert.match(statusText, /Independent session TODOs: 3/);
    assert.match(statusText, /\[done\].*Coordinate review/);
    assert.match(statusText, /\[in_progress\].*Summarize result/);
    assert.match(statusText, /\[pending\].*Archive notes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeEmptySparkThread(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".spark"), { recursive: true });
  const graph = new TaskGraph();
  graph.createThread({ title: "Tool persistence", description: "Test Spark tool persistence." });
  await defaultTaskGraphStore(cwd).save(graph);
}

function registerSparkToolsForTest(): { tools: Map<string, SparkToolConfig> } {
  const tools = new Map<string, SparkToolConfig>();
  const pi: SparkExtensionApiForTest & {
    getAllTools: () => Array<{ name: string }>;
    setActiveTools: (names: string[]) => void;
  } = {
    registerCommand: () => undefined,
    registerTool: (config) => {
      tools.set(config.name, config);
    },
    on: () => undefined,
    sendUserMessage: () => undefined,
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools: () => undefined,
  };
  sparkExtension(pi);
  return { tools };
}

async function executeSparkTool(
  tools: Map<string, SparkToolConfig>,
  name: string,
  ctx: TestSparkContext,
  params: Record<string, unknown>,
): Promise<SparkToolResult> {
  const tool = tools.get(name);
  assert.ok(tool, `missing Spark tool: ${name}`);
  return tool.execute(`call-${name}`, params, new AbortController().signal, () => undefined, ctx);
}

function testSparkContext(cwd: string, sessionName: string): TestSparkContext {
  const sessionFile = join(cwd, ".pi-sessions", `${sessionName}.json`);
  return {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getLeafId: () => `${sessionName}-leaf`,
    },
    hasUI: true,
    ui: {
      notify: () => undefined,
      setWidget: () => undefined,
      setStatus: () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      select: async () => undefined,
    },
  };
}

function ctxSessionKey(ctx: TestSparkContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  return `session:${stableId(sessionFile)}`;
}

function ctxSessionStoreScope(ctx: TestSparkContext): string {
  return ctxSessionKey(ctx)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");
}

function sessionTaskTodoPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "todos", `${ctxSessionStoreScope(ctx)}.json`);
}

function sessionIndependentTodoPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "session-todos", `${ctxSessionStoreScope(ctx)}.json`);
}

function toolText(result: SparkToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}
