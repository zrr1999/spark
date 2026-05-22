import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ArtifactRef,
  stableId,
  type TaskPlan,
  type TaskRef,
  type ThreadRef,
} from "spark-core";
import { defaultArtifactStore } from "spark-artifacts";
import { defaultSparkDagRunStore } from "spark-runtime";
import { defaultTaskGraphStore, defaultTaskTodoStore, TaskGraph } from "spark-tasks";
import sparkExtension from "../packages/spark/src/extension/index.ts";

type SparkExtensionApiForTest = Parameters<typeof sparkExtension>[0];
type SparkToolConfig = Parameters<NonNullable<SparkExtensionApiForTest["registerTool"]>>[0];
type SparkToolResult = Awaited<ReturnType<SparkToolConfig["execute"]>>;
type TestNotification = { message: string; level?: "info" | "warning" | "error" | "success" };

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

type TestSparkContext = {
  cwd: string;
  sessionManager: {
    getSessionFile: () => string | undefined;
    getLeafId: () => string | undefined;
  };
  hasUI: boolean;
  notifications: TestNotification[];
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error" | "success") => void;
    setWidget: (key: string, cb: unknown, opts?: { placement?: string }) => void;
    setStatus: (key: string, text: string | undefined) => void;
    confirm: (title: string, message: string) => Promise<boolean>;
    input: (title: string, defaultValue?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    custom?: (...args: unknown[]) => unknown;
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

void test("spark_claim_task attaches task-plan clarification ask refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-plan-ask-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "clarify-plan",
      title: "Clarify underspecified plan",
      description: "Exercise task plan clarification attachment.",
      kind: "implement",
    });

    const details = claim.details as
      | {
          task?: { ref?: TaskRef; plan?: { askRefs?: string[] } };
          planClarification?: { asked?: boolean; artifactRef?: string };
        }
      | undefined;
    assert.equal(details?.planClarification?.asked, true);
    assert.ok(details?.planClarification?.artifactRef);
    assert.deepEqual(details?.task?.plan?.askRefs, [details?.planClarification?.artifactRef]);
    const artifact = await defaultArtifactStore(dir).get(
      details.planClarification.artifactRef as ArtifactRef,
    );
    const body = artifact.body as {
      request?: { questions?: Array<{ id: string; type?: string; options?: unknown[] }> };
    };
    const successQuestion = body.request?.questions?.find(
      (question) => question.id === "successCriteria",
    );
    assert.equal(successQuestion?.type, "multi");
    assert.ok((successQuestion?.options?.length ?? 0) >= 2);
    assert.match(toolText(claim), /plan clarification saved to artifact:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
      | { ref?: ThreadRef; title?: string; status?: string }
      | undefined;
    assert.equal(renamedThreadDetails?.ref, thread.ref);
    assert.equal(renamedThreadDetails?.title, "Autonomous Spark naming quality");
    assert.equal(renamedThreadDetails?.status, "active");

    const doneThread = await executeSparkTool(tools, "spark_rename_thread", ctx, {
      thread: thread.ref,
      status: "done",
    });
    const doneThreadDetails = doneThread.details?.thread as
      | { ref?: ThreadRef; title?: string; status?: string }
      | undefined;
    assert.equal(doneThreadDetails?.status, "done");

    await executeSparkTool(tools, "spark_use_thread", ctx, { thread: thread.ref });
    await executeSparkTool(tools, "spark_rename_thread", ctx, {
      thread: thread.ref,
      status: "active",
    });

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
    assert.equal(loaded.getThread(thread.ref).status, "active");
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

void test("spark_claim_task creates a new task when multiple generic rename candidates are ambiguous", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-ambiguous-name-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Spark thread", description: "placeholder" });
    const first = graph.createTask({
      threadRef: thread.ref,
      name: "task-deadbeefcafebabe",
      title: "整理一下",
      description: "First generic non-ASCII placeholder.",
      kind: "interaction",
      status: "running",
    });
    const second = graph.createTask({
      threadRef: thread.ref,
      name: "capture-project-intent",
      title: "Capture project intent",
      description: "Second generic placeholder.",
      kind: "interaction",
      status: "running",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      title: "Implement concrete naming policy test",
      description:
        "No existing task can be chosen without guessing because multiple generic tasks are present.",
      kind: "implement",
    });
    const claimedTask = claim.details?.task as
      | { ref?: TaskRef; name?: string; title?: string }
      | undefined;
    assert.ok(claimedTask?.ref);
    assert.notEqual(claimedTask.ref, first.ref);
    assert.notEqual(claimedTask.ref, second.ref);
    assert.equal(claimedTask.name, "implement-concrete-naming-policy-test");

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(first.ref).name, "task-deadbeefcafebabe");
    assert.equal(loaded.getTask(second.ref).name, "capture-project-intent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task rejects terminal statuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-terminal-claim-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const rejected = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "terminal-claim",
      title: "Terminal claim",
      description: "Attempt to finish through the claim tool.",
      kind: "implement",
      status: "done",
    });

    assert.equal(rejected.details?.error, "terminal_status_not_allowed");
    assert.match(toolText(rejected), /only accepts unfinished statuses/);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const [thread] = graph.threads();
    assert.ok(thread);
    assert.equal(
      graph.tasks(thread.ref).some((task) => task.name === "terminal-claim"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_finish_task completes this session's claimed task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-task-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-me",
      title: "Finish me",
      description: "Exercise task lifecycle completion.",
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    const finished = await executeSparkTool(tools, "spark_finish_task", ctx, {
      summary: "Done for test.",
    });
    assert.match(toolText(finished), /Finished Spark task: \[done\] @finish-me: Finish me/);
    assert.equal((finished.details?.task as { status?: string } | undefined)?.status, "done");

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "done");
    assert.equal(loaded.getTask(taskRef).claim, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark artifact tools list and read artifacts with truncated default body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-artifacts-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const artifact = await defaultArtifactStore(dir).put({
      kind: "research",
      title: "Long research note",
      format: "text",
      body: "abcdef".repeat(1000),
      provenance: { producer: "spark" },
    });
    const { tools } = registerSparkToolsForTest();

    const listed = await executeSparkTool(tools, "spark_list_artifacts", ctx, { kind: "research" });
    assert.match(toolText(listed), new RegExp(`${artifact.ref}.*Long research note`));

    const read = await executeSparkTool(tools, "spark_get_artifact", ctx, {
      artifactRef: artifact.ref,
      maxChars: 40,
    });
    assert.match(toolText(read), /Long research note/);
    assert.match(toolText(read), /truncated/);
    assert.equal((read.details as { truncated?: boolean }).truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_use_thread clarifies generic new thread intent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-thread-intent-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const created = await executeSparkTool(tools, "spark_use_thread", ctx, { title: "tasks" });
    assert.match(toolText(created), /Current Spark thread/);
    const artifacts = await defaultArtifactStore(dir).list({
      kind: "ask-answer",
    });
    assert.equal(artifacts.length, 1);
    const traces = await defaultArtifactStore(dir).list({
      kind: "run-trace",
    });
    assert.ok(traces.some((artifact) => artifact.title === "Thread intent clarification"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_status does not activate an arbitrary thread for the Pi session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-no-auto-thread-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "status-no-auto");
    const { tools } = registerSparkToolsForTest();

    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    const statusText = toolText(status);

    assert.doesNotMatch(statusText, /\[current\]/);
    assert.match(statusText, /Tool persistence/);
    const statusDetails = status.details as { activeThreadRef?: string } | undefined;
    assert.equal(statusDetails?.activeThreadRef, undefined);
    await assert.rejects(() =>
      readFile(join(dir, ".spark", "current-thread", `${ctxSessionStoreScope(ctx)}.json`), "utf8"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("done threads are cleared from current selection and not auto-reactivated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-done-thread-current-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const doneThread = graph.createThread({
      title: "Completed workflow",
      description: "Should not remain current.",
      status: "done",
    });
    graph.createThread({
      title: "Next workflow",
      description: "Should not become current automatically.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "spark_use_thread", ctx, { thread: doneThread.ref });
    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    const statusDetails = status.details as { activeThreadRef?: string } | undefined;
    assert.equal(statusDetails?.activeThreadRef, undefined);
    assert.match(toolText(status), /Next workflow/);
    assert.doesNotMatch(toolText(status), /Next workflow \[current\]/);
    assert.doesNotMatch(toolText(status), /Completed workflow \[current\]/);

    await assert.rejects(() =>
      readFile(join(dir, ".spark", "current-thread", `${ctxSessionStoreScope(ctx)}.json`), "utf8"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_status includes persisted DAG manager status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-status-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultSparkDagRunStore(dir);
    const dagRun = await dagStore.startRun({
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 3,
      timeoutMs: 456,
    });
    await dagStore.finishRun(dagRun.ref, { scheduled: 2, completed: 1, timedOut: true });
    const staleRun = await dagStore.startRun({
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });

    const { tools } = registerSparkToolsForTest();
    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    const text = toolText(status);

    assert.match(text, /DAG manager: idle/);
    assert.match(text, /failed=1/);
    assert.match(text, /timed_out=1/);
    assert.match(
      text,
      new RegExp(
        `Last DAG run: ${staleRun.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[stale\\]`,
      ),
    );
    assert.equal((status.details as { dag?: { timedOut?: number } }).dag?.timedOut, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_dag_manager reconciles and clears inactive records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-manager-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultSparkDagRunStore(dir);
    const finished = await dagStore.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await dagStore.finishRun(finished.ref, { scheduled: 0, completed: 0, timedOut: false });
    await dagStore.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });

    const { tools } = registerSparkToolsForTest();
    const reconciled = await executeSparkTool(tools, "spark_dag_manager", ctx, {
      action: "reconcile",
    });
    assert.match(toolText(reconciled), /action=reconcile/);
    assert.match(toolText(reconciled), /failed=1/);

    const cleared = await executeSparkTool(tools, "spark_dag_manager", ctx, {
      action: "clear_inactive",
    });
    assert.match(toolText(cleared), /action=clear_inactive/);
    assert.match(toolText(cleared), /runs=0 recent/);
    assert.equal(
      (cleared.details as { dag?: { recentRuns?: unknown[] } }).dag?.recentRuns?.length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_run_ready_tasks emits DAG completion follow-up when manager finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-followup-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [thread] = graph.threads();
    assert.ok(thread);
    graph.createTask({
      threadRef: thread.ref,
      name: "ready-role",
      title: "Ready role task",
      description: "Run a quick fake role-run.",
      kind: "implement",
      status: "pending",
      roleRef: "role:builtin-worker",
      plan: executionReadyPlan("Ready role task"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(fakePi, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const { tools, messages } = registerSparkToolsForTest();
    await executeSparkTool(tools, "spark_run_ready_tasks", ctx, { dryRun: false });
    await waitFor(() => messages.some((message) => message.includes("Spark DAG run:")));

    const dagStatus = await defaultSparkDagRunStore(dir).status();
    assert.equal(dagStatus.succeeded, 1);
    assert.match(messages.join("\n"), /Spark DAG run:/);
    assert.match(messages.join("\n"), /scheduled 1, completed 1/);
    assert.equal(ctx.notifications.at(-1)?.level, "info");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark DAG run:/);
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
    assert.match(activeText, /Tool persistence/);
    assert.doesNotMatch(activeText, /Tool persistence \[current\]/);
    assert.doesNotMatch(activeText, /Thread status: active/);
    assert.match(activeText, /Active tasks:/);
    assert.match(activeText, /Mine running task/);
    assert.match(activeText, /Other pending task/);
    assert.match(activeText, /plan=not-ready\(missing-success,missing-evidence\)/);
    assert.doesNotMatch(activeText, /Finished task history/);
    assert.doesNotMatch(activeText, /Cancelled task history/);
    assert.doesNotMatch(activeText, /kind=implement/);
    assert.doesNotMatch(activeText, /claimed=session:/);
    assert.doesNotMatch(activeText, new RegExp(thread.ref));
    assert.match(activeText, /Hidden finished tasks: 2 \(use view=full to include\)/);
    assert.equal(active.details?.view, "active");
    assert.equal(active.details?.limit, 20);
    assert.equal(active.details?.activeThreadRef, undefined);
    assert.equal("tasks" in active.details!, false);
    assert.equal("dependencies" in active.details!, false);

    const limited = await executeSparkTool(tools, "spark_status", ctx, { limit: 1 });
    const limitedText = toolText(limited);
    assert.match(limitedText, /Spark tasks \(active view, limit=1\):/);
    assert.match(limitedText, /Hidden by limit: 1/);
    assert.equal((limitedText.match(/^  - \[/gm) ?? []).length, 1);

    const summary = await executeSparkTool(tools, "spark_status", ctx, { view: "summary" });
    const summaryText = toolText(summary);
    assert.match(summaryText, /Spark tasks \(summary view\):/);
    assert.match(summaryText, /Tasks: 4 total/);
    assert.doesNotMatch(summaryText, /Active tasks:/);
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

void test("spark_plan_tasks keeps large plan output bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-bounded-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: Array.from({ length: 8 }, (_, index) => ({
        name: `task-${index + 1}`,
        title: `Task ${index + 1}`,
        description: `Bounded output task ${index + 1}.`,
      })),
    });
    const text = toolText(planned);

    assert.match(text, /Planned tasks: created=8 updated=0 dependencies=0/);
    assert.match(text, /… 3 more changed task\(s\)/);
    assert.equal((text.match(/^- created/gm) ?? []).length, 5);
    assert.doesNotMatch(text, /\(task:/);
    const details = planned.details as { result?: { created?: unknown[]; dependencies?: number } };
    assert.equal(details.result?.created?.length, 8);
    assert.equal(details.result?.dependencies, 0);
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

function registerSparkToolsForTest(): { tools: Map<string, SparkToolConfig>; messages: string[] } {
  const tools = new Map<string, SparkToolConfig>();
  const messages: string[] = [];
  const pi: SparkExtensionApiForTest & {
    getAllTools: () => Array<{ name: string }>;
    setActiveTools: (names: string[]) => void;
  } = {
    registerCommand: () => undefined,
    registerTool: (config) => {
      tools.set(config.name, config);
    },
    on: () => undefined,
    sendUserMessage: (content) => {
      messages.push(content);
    },
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools: () => undefined,
  };
  sparkExtension(pi);
  return { tools, messages };
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
  const context: TestSparkContext = {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getLeafId: () => `${sessionName}-leaf`,
    },
    hasUI: true,
    notifications: [],
    ui: {
      notify(message, level) {
        context.notifications.push({ message, level });
      },
      setWidget: () => undefined,
      setStatus: () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      select: async () => undefined,
    },
  };
  return context;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), "timed out waiting for condition");
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
