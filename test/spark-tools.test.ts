import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stableId, type TaskPlan, type TaskRef, type ThreadRef } from "spark-core";
import { defaultArtifactStore } from "spark-artifacts";
import { defaultLearningStore } from "spark-learnings";
import { defaultSparkDagRunStore } from "spark-orchestrator";
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
  selected?: string;
  inputValue?: string;
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

void test("/spark command detects empty, existing, and initialized project modes", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "spark-command-empty-"));
  const existingDir = await mkdtemp(join(tmpdir(), "spark-command-existing-"));
  const initializedDir = await mkdtemp(join(tmpdir(), "spark-command-initialized-"));
  try {
    const emptyCtx = testSparkContext(emptyDir, "main");
    const emptyRun = registerSparkToolsForTest();
    const emptyCommand = emptyRun.commands.get("spark");
    assert.ok(emptyCommand, "missing /spark command");
    await emptyCommand.handler("Build a contextual Spark cockpit", emptyCtx);
    assert.ok(existsSync(join(emptyDir, ".spark", "thread.json")));
    assert.equal(emptyRun.messages.length, 0);
    const emptyMessage = emptyRun.customMessages[0]?.content ?? "";
    assert.match(emptyMessage, /Spark initialized|Spark 已初始化/);
    const emptyHidden = await consumeSparkModeContext(emptyRun, emptyCtx);
    assert.match(emptyHidden, /minimal local state/);
    assert.match(emptyHidden, /spark_rename_thread/);
    assert.match(emptyHidden, /do not create tasks merely because Spark just initialized/);

    await writeFile(join(existingDir, "README.md"), "# Existing project\n", "utf8");
    const existingCtx = testSparkContext(existingDir, "main");
    existingCtx.inputValue = "Audit existing project structure";
    const existingRun = registerSparkToolsForTest();
    const existingCommand = existingRun.commands.get("spark");
    assert.ok(existingCommand, "missing /spark command");
    await existingCommand.handler("", existingCtx);
    assert.ok(existsSync(join(existingDir, ".spark", "thread.json")));
    assert.equal(existingRun.messages.length, 0);
    assert.match(existingRun.customMessages[0]?.content ?? "", /Spark initialized/);
    assert.match(existingRun.customMessages.at(-1)?.content ?? "", /Spark planning mode requested/);
    const existingMessage = await consumeSparkModeContext(existingRun, existingCtx);
    assert.match(existingMessage, /Enter Spark planning mode/);
    assert.match(existingMessage, /Audit existing project structure/);
    assert.match(existingMessage, /answer directly for a simple research\/read-and-comment turn/);
    assert.match(existingMessage, /spark_plan_tasks only when there are concrete plan-bound tasks/);
    assert.match(existingMessage, /use spark_ask with context-specific questions/);
    assert.match(existingMessage, /Do not use generic intake templates/);
    const existingThreadJson = await readFile(join(existingDir, ".spark", "thread.json"), "utf8");
    assert.doesNotMatch(existingThreadJson, /Plan existing project/);
    assert.doesNotMatch(existingThreadJson, /Analyze project intent/);
    assert.doesNotMatch(existingThreadJson, /Plan targeted clarification/);
    assert.doesNotMatch(existingThreadJson, /Review initial direction/);

    await writeEmptySparkThread(initializedDir);
    const initializedCtx = testSparkContext(initializedDir, "main");
    await defaultTaskGraphStore(initializedDir).update(async (graph) => {
      const thread = graph.threads()[0];
      assert.ok(thread);
      await mkdir(join(initializedDir, ".spark", "current-thread"), { recursive: true });
      await writeFile(
        join(
          initializedDir,
          ".spark",
          "current-thread",
          `${ctxSessionStoreScope(initializedCtx)}.json`,
        ),
        JSON.stringify({ threadRef: thread.ref }, null, 2),
        "utf8",
      );
      graph.createTask({
        threadRef: thread.ref,
        title: "Ready implementation task",
        description: "Ready implementation task",
        plan: executionReadyPlan("Ready implementation task"),
        status: "pending",
      });
    });
    const initializedRun = registerSparkToolsForTest();
    const initializedCommand = initializedRun.commands.get("spark");
    assert.ok(initializedCommand, "missing /spark command");
    initializedCtx.selected = "Plan “Tool persistence”";
    await initializedCommand.handler("", initializedCtx);
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Spark planning mode requested/,
    );
    assert.match(
      await consumeSparkModeContext(initializedRun, initializedCtx),
      /Enter Spark planning mode/,
    );

    initializedCtx.selected = "Execute “Tool persistence”";
    await initializedCommand.handler("", initializedCtx);
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Spark execution mode requested/,
    );
    assert.match(
      await consumeSparkModeContext(initializedRun, initializedCtx),
      /Enter Spark execution mode/,
    );

    initializedCtx.ui.select = async () =>
      assert.fail("clear /spark execution prompts should not ask for mode");
    await initializedCommand.handler("execute the ready task", initializedCtx);
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Spark execution mode requested/,
    );
    assert.match(
      await consumeSparkModeContext(initializedRun, initializedCtx),
      /Enter Spark execution mode/,
    );
  } finally {
    await rm(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(existingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(initializedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("bare /spark in an existing project requires a concrete planning focus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-command-existing-no-focus-"));
  try {
    await writeFile(join(dir, "README.md"), "# Existing project\n", "utf8");
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const command = run.commands.get("spark");
    assert.ok(command, "missing /spark command");

    await command.handler("", ctx);

    assert.equal(existsSync(join(dir, ".spark", "thread.json")), false);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /needs a concrete focus/);
    assert.equal(run.messages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/plan and /execute enter Spark modes directly", async () => {
  const existingDir = await mkdtemp(join(tmpdir(), "spark-plan-direct-existing-"));
  const initializedDir = await mkdtemp(join(tmpdir(), "spark-execute-direct-initialized-"));
  const emptyDir = await mkdtemp(join(tmpdir(), "spark-execute-direct-empty-"));
  try {
    await writeFile(join(existingDir, "README.md"), "# Existing project\n", "utf8");
    const existingCtx = testSparkContext(existingDir, "main");
    const existingRun = registerSparkToolsForTest();
    const planCommand = existingRun.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");
    await planCommand.handler("Audit current task flow", existingCtx);
    assert.ok(existsSync(join(existingDir, ".spark", "thread.json")));
    assert.equal(existingRun.messages.length, 0);
    assert.match(existingRun.customMessages[0]?.content ?? "", /Spark initialized/);
    assert.doesNotMatch(
      existingRun.customMessages[0]?.content ?? "",
      /Enter Spark planning mode from explicit \/plan/,
    );
    assert.match(existingRun.customMessages.at(-1)?.content ?? "", /Spark planning mode requested/);
    assert.match(existingRun.customMessages.at(-1)?.content ?? "", /Audit current task flow/);
    const planMessage = await consumeSparkModeContext(existingRun, existingCtx);
    assert.match(planMessage, /Enter Spark planning mode from explicit \/plan/);
    assert.match(planMessage, /Audit current task flow/);
    assert.match(planMessage, /use spark_ask for context-specific detailed intent/);
    assert.match(planMessage, /do not leave them as prose/);
    assert.match(planMessage, /do not use canned intake templates/);
    assert.match(
      planMessage,
      /call spark_plan_tasks to create or refine concrete plan-bound tasks/,
    );
    assert.doesNotMatch(
      planMessage,
      /answer directly for a simple research\/read-and-comment turn/,
    );

    await writeEmptySparkThread(initializedDir);
    const initializedCtx = testSparkContext(initializedDir, "main");
    await defaultTaskGraphStore(initializedDir).update(async (graph) => {
      const thread = graph.threads()[0];
      assert.ok(thread);
      await mkdir(join(initializedDir, ".spark", "current-thread"), { recursive: true });
      await writeFile(
        join(
          initializedDir,
          ".spark",
          "current-thread",
          `${ctxSessionStoreScope(initializedCtx)}.json`,
        ),
        JSON.stringify({ threadRef: thread.ref }, null, 2),
        "utf8",
      );
      graph.createTask({
        threadRef: thread.ref,
        title: "Ready direct execution task",
        description: "Ready direct execution task",
        plan: executionReadyPlan("Ready direct execution task"),
        status: "pending",
      });
    });
    const initializedRun = registerSparkToolsForTest();
    const executeCommand = initializedRun.commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("Finish the direct execution task", initializedCtx);
    assert.equal(initializedRun.messages.length, 0);
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Spark execution mode requested/,
    );
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Finish the direct execution task/,
    );
    const executeMessage = await consumeSparkModeContext(initializedRun, initializedCtx);
    assert.match(executeMessage, /Enter Spark execution mode/);
    assert.match(executeMessage, /Execution focus: Finish the direct execution task/);
    assert.match(executeMessage, /Prefer DAG execution with spark_run_ready_tasks dryRun=false/);
    assert.match(executeMessage, /Treat DAG execution like background subagent orchestration/);
    assert.match(
      executeMessage,
      /After each manually claimed task finishes, continue by auto-claiming or dispatching the next ready task/,
    );
    assert.equal(
      initializedCtx.notifications.at(-1)?.message,
      "Spark execution mode: prefer DAG or continue ready tasks.",
    );

    const emptyCtx = testSparkContext(emptyDir, "main");
    const emptyRun = registerSparkToolsForTest();
    const emptyExecute = emptyRun.commands.get("execute");
    assert.ok(emptyExecute, "missing /execute command");
    await emptyExecute.handler("", emptyCtx);
    assert.match(emptyCtx.notifications.at(-1)?.message ?? "", /needs initialized Spark state/);
  } finally {
    await rm(existingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(initializedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/plan includes active roadmap item context and matches focus to an existing item", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-roadmap-context-"));
  try {
    await writeEmptySparkThread(dir);
    await writeRoadmap(dir, {
      activeItemRef: "roadmap-item:other",
      items: [
        {
          ref: "roadmap-item:other",
          title: "Other roadmap item",
          objective: "Keep an unrelated active item available.",
          status: "active",
        },
        {
          ref: "roadmap-item:planning",
          title: "Roadmap assisted planning",
          objective: "Use roadmap item intent while planning tasks.",
          scope: "Only planning-mode task organization.",
          successCriteria: ["Planning prompt includes roadmap context."],
          evidenceRequired: ["Roadmap item refs are visible to planning."],
        },
      ],
    });
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const planCommand = run.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");

    await planCommand.handler("Roadmap assisted planning", ctx);

    assert.equal(run.messages.length, 0);
    assert.match(run.customMessages.at(-1)?.content ?? "", /Spark planning mode requested/);
    const message = await consumeSparkModeContext(run, ctx);
    assert.match(message, /Roadmap planning context:/);
    assert.match(message, /Roadmap assisted planning/);
    assert.match(message, /Use roadmap item intent while planning tasks/);
    assert.match(message, /Only planning-mode task organization/);
    assert.match(message, /Roadmap item refs are visible to planning/);
    const roadmap = JSON.parse(await readFile(join(dir, ".spark", "roadmap.json"), "utf8")) as {
      activeItemRef?: string;
      roadmaps: Array<{ activeItemRef?: string }>;
    };
    assert.equal(roadmap.activeItemRef, "roadmap-item:planning");
    assert.equal(roadmap.roadmaps[0]?.activeItemRef, "roadmap-item:planning");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_plan_tasks maps active roadmap item hints into task plans and attaches refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-roadmap-hints-"));
  try {
    await writeEmptySparkThread(dir);
    await writeRoadmap(dir, {
      activeItemRef: "roadmap-item:planning",
      items: [
        {
          ref: "roadmap-item:planning",
          title: "Roadmap assisted planning",
          objective: "Organize roadmap-backed Spark planning tasks.",
          scope: "Do not add dashboard or scheduling features.",
          successCriteria: ["Created tasks use roadmap success criteria."],
          evidenceRequired: ["Task refs are attached to the roadmap item."],
          status: "active",
        },
      ],
    });
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "roadmap-backed-task",
          title: "Create roadmap-backed task",
          description: "Exercise roadmap-assisted planning hints.",
          kind: "implement",
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    assert.match(toolText(planned), /roadmap item updated: roadmap-item:planning/);
    const graph = await defaultTaskGraphStore(dir).load();
    const task = graph?.tasks()[0];
    assert.ok(task);
    assert.match(task.plan?.contextRefs.join("\n") ?? "", /Roadmap objective:/);
    assert.match(task.plan?.constraints.join("\n") ?? "", /Do not add dashboard/);
    assert.deepEqual(task.plan?.successCriteria, ["Created tasks use roadmap success criteria."]);
    assert.deepEqual(task.plan?.evidenceRequired, ["Task refs are attached to the roadmap item."]);

    const roadmap = JSON.parse(await readFile(join(dir, ".spark", "roadmap.json"), "utf8")) as {
      roadmaps: Array<{ items: Array<{ threadRefs?: string[]; taskRefs?: string[] }> }>;
    };
    const item = roadmap.roadmaps[0]?.items[0];
    assert.ok(item?.threadRefs?.includes(task.threadRef));
    assert.ok(item?.taskRefs?.includes(task.ref));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_plan_tasks dryRun previews ready tasks without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-dry-run-ready-"));
  try {
    await writeEmptySparkThread(dir);
    const before = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      dryRun: true,
      tasks: [
        {
          name: "dry-ready",
          title: "Preview ready task",
          description: "Preview a ready task without saving it.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Preview a ready task without saving it."),
        },
      ],
    });

    assert.match(toolText(planned), /Dry-run planned tasks: created=1 updated=0 dependencies=0/);
    const details = planned.details as
      | {
          dryRun?: boolean;
          result?: { created?: unknown[] };
          planDecisions?: Array<{ accepted?: boolean }>;
        }
      | undefined;
    assert.equal(details?.dryRun, true);
    assert.equal(details?.result?.created?.length, 1);
    assert.equal(details?.planDecisions?.[0]?.accepted, true);
    assert.equal(await readFile(join(dir, ".spark", "thread.json"), "utf8"), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_plan_tasks dryRun reports mixed readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-dry-run-mixed-"));
  try {
    await writeEmptySparkThread(dir);
    const before = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      dryRun: true,
      tasks: [
        {
          name: "dry-ready",
          title: "Preview ready task",
          description: "Preview a ready task without saving it.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Preview a ready task without saving it."),
        },
        {
          name: "dry-blocked",
          title: "Preview blocked task",
          description: "Preview a blocked task without saving it.",
          kind: "implement",
          status: "pending",
        },
      ],
    });

    assert.match(toolText(planned), /Task plan not ready: @dry-blocked/);
    const details = planned.details as
      | {
          dryRun?: boolean;
          error?: string;
          result?: { created?: unknown[] };
          planDecisions?: Array<{ accepted?: boolean; blocked?: boolean }>;
        }
      | undefined;
    assert.equal(details?.dryRun, true);
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.result?.created?.length, 2);
    assert.equal(details?.planDecisions?.[0]?.accepted, true);
    assert.equal(details?.planDecisions?.[1]?.blocked, true);
    assert.equal(await readFile(join(dir, ".spark", "thread.json"), "utf8"), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_plan_tasks dryRun reports all-rejected readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-dry-run-rejected-"));
  try {
    await writeEmptySparkThread(dir);
    const before = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("dryRun readiness should not open a task-plan ask");
    ctx.ui.custom = async () => assert.fail("dryRun readiness should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      dryRun: true,
      tasks: [
        {
          name: "dry-blocked-one",
          title: "Preview blocked task one",
          description: "Preview a blocked task without saving it.",
          kind: "implement",
          status: "pending",
        },
        {
          name: "dry-blocked-two",
          title: "Preview blocked task two",
          description: "Preview another blocked task without saving it.",
          kind: "review",
          status: "pending",
        },
      ],
    });

    assert.match(toolText(planned), /Task plan not ready: @dry-blocked-one/);
    const details = planned.details as
      | {
          dryRun?: boolean;
          error?: string;
          result?: { created?: unknown[] };
          planDecisions?: Array<{ accepted?: boolean; blocked?: boolean }>;
        }
      | undefined;
    assert.equal(details?.dryRun, true);
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.result?.created?.length, 2);
    assert.equal(
      details?.planDecisions?.every((decision) => decision.blocked),
      true,
    );
    assert.equal(await readFile(join(dir, ".spark", "thread.json"), "utf8"), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/execute keeps execution mode active and auto-claims the next ready task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-execute-continuous-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const thread = graph.threads()[0];
      assert.ok(thread);
      await mkdir(join(dir, ".spark", "current-thread"), { recursive: true });
      await writeFile(
        join(dir, ".spark", "current-thread", `${ctxSessionStoreScope(ctx)}.json`),
        JSON.stringify({ threadRef: thread.ref }, null, 2),
        "utf8",
      );
      graph.createTask({
        threadRef: thread.ref,
        name: "first-ready",
        title: "First ready task",
        description: "First ready task",
        plan: executionReadyPlan("First ready task"),
        status: "pending",
      });
      graph.createTask({
        threadRef: thread.ref,
        name: "second-ready",
        title: "Second ready task",
        description: "Second ready task",
        plan: executionReadyPlan("Second ready task"),
        status: "pending",
      });
    });

    const { tools, commands, messages, customMessages } = registerSparkToolsForTest();
    const executeCommand = commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("work through the ready queue", ctx);

    await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "first-ready",
      title: "First ready task",
      description: "First ready task",
      status: "running",
    });
    const messagesBefore = messages.length;
    const customBefore = customMessages.length;
    const finished = await executeSparkTool(tools, "spark_finish_task", ctx, {
      summary: "Finished first ready task.",
    });

    const text = finished.content.map((item) => item.text).join("\n");
    assert.match(text, /Execution mode continued: auto-claimed next ready task @second-ready/);
    // Continuation must not occupy the user input lane: spark_finish_task should
    // not send a user message even when execution mode auto-claims the next task.
    assert.equal(
      messages.length,
      messagesBefore,
      "spark_finish_task must not inject a user message for execution-mode continuation",
    );
    const continuation = customMessages
      .slice(customBefore)
      .find((message) => message.customType === "spark-execution-continuation");
    assert.ok(continuation, "missing spark-execution-continuation custom message");
    const continuationContent =
      typeof continuation.content === "string"
        ? continuation.content
        : (continuation.content as Array<{ type: string; text?: string }>)
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("\n");
    assert.match(continuationContent, /Continue Spark execution mode/);
    assert.match(continuationContent, /Spark auto-claimed @second-ready/);

    const graph = await defaultTaskGraphStore(dir).load();
    const next = graph?.tasks().find((task) => task.name === "second-ready");
    assert.equal(next?.status, "running");
    assert.equal(next?.claim?.kind, "main");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_plan_tasks blocks underspecified executable tasks without opening a canned ask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-plan-not-ready-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("spark_plan_tasks should not open a task-plan ask");
    ctx.ui.custom = async () => assert.fail("spark_plan_tasks should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "clarify-plan",
          title: "Clarify underspecified plan",
          description: "Exercise task plan readiness validation.",
          kind: "implement",
        },
      ],
    });

    const details = planned.details as
      | {
          error?: string;
          planDecision?: {
            asked?: boolean;
            accepted?: boolean;
            blocked?: boolean;
            summary?: string;
          };
        }
      | undefined;
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.planDecision?.asked, false);
    assert.equal(details?.planDecision?.accepted, false);
    assert.equal(details?.planDecision?.blocked, true);
    assert.match(details?.planDecision?.summary ?? "", /fix: Add at least one observable entry/);
    assert.match(toolText(planned), /Task plan not ready: @clarify-plan/);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_plan_tasks accepts cancelled cleanup tasks without success/evidence readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-cancelled-plan-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("cancelled cleanup should not open a task-plan ask");
    ctx.ui.custom = async () => assert.fail("cancelled cleanup should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "retire-placeholder",
          title: "Retire placeholder task",
          description:
            "Historical placeholder that should be cancelled without execution evidence.",
          kind: "interaction",
          status: "cancelled",
        },
      ],
    });

    const details = planned.details as
      | { planDecisions?: Array<{ asked?: boolean; accepted?: boolean; blocked?: boolean }> }
      | undefined;
    assert.equal(details?.planDecisions?.[0]?.asked, false);
    assert.equal(details?.planDecisions?.[0]?.accepted, true);
    assert.equal(details?.planDecisions?.[0]?.blocked, false);
    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    const task = (await defaultTaskGraphStore(dir).load())?.tasks()[0];
    assert.equal(task?.status, "cancelled");
    assert.equal(task?.plan?.successCriteria.length, 0);
    assert.equal(task?.plan?.evidenceRequired.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task does not ask for task-plan refinement at claim time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-claim-no-plan-ask-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "claim-plan",
      title: "Claim underspecified plan",
      description: "Claiming should not ask for task plan refinement.",
      kind: "implement",
    });

    assert.match(toolText(claim), /Claimed Spark task/);
    assert.equal((await defaultArtifactStore(dir).list({ kind: "ask-answer" })).length, 0);
    const details = claim.details as { planClarification?: unknown } | undefined;
    assert.equal(details?.planClarification, undefined);
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
    await useOnlySparkThread(tools, ctx);

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
    await executeSparkTool(tools, "spark_use_thread", ctx, { thread: thread.ref });

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

    await executeSparkTool(tools, "spark_rename_thread", ctx, {
      thread: thread.ref,
      status: "active",
    });
    await executeSparkTool(tools, "spark_use_thread", ctx, { thread: thread.ref });

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
    await executeSparkTool(tools, "spark_use_thread", ctx, { thread: thread.ref });

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
    await executeSparkTool(tools, "spark_use_thread", ctx, { thread: thread.ref });

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
    await useOnlySparkThread(tools, ctx);

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-me",
      title: "Finish me",
      description: "Exercise task lifecycle completion.",
      plan: executionReadyPlan("Finish me"),
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    const finished = await executeSparkTool(tools, "spark_finish_task", ctx, {
      summary: "Done for test.",
    });
    assert.match(toolText(finished), /Finished Spark task: \[done\] @finish-me: Finish me/);
    assert.match(
      toolText(finished),
      /Completion evidence warning: Task completion needs evidence artifacts/,
    );
    assert.match(toolText(finished), /Learning candidate: artifact:/);
    assert.equal((finished.details?.task as { status?: string } | undefined)?.status, "done");
    assert.equal(
      (finished.details?.completionReadiness as { ready?: boolean } | undefined)?.ready,
      false,
    );
    assert.equal(
      (finished.details?.learningCandidate as { status?: string } | undefined)?.status,
      "candidate",
    );
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 1);
    assert.equal((await defaultLearningStore(dir).list()).length, 0);

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
      body: "abcdef".repeat(20_000),
      provenance: { producer: "spark" },
    });
    const { tools } = registerSparkToolsForTest();

    const listed = await executeSparkTool(tools, "spark_list_artifacts", ctx, { kind: "research" });
    assert.match(toolText(listed), new RegExp(`${artifact.ref}.*Long research note`));
    const [listedArtifact] =
      (listed.details as { artifacts?: Array<{ bodyTruncated?: boolean }> }).artifacts ?? [];
    assert.equal(listedArtifact?.bodyTruncated, true);

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

void test("spark learning tools record, search, export, and import learnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-learnings-"));
  const importDir = await mkdtemp(join(tmpdir(), "spark-tool-learnings-import-"));
  try {
    await writeEmptySparkThread(dir);
    await writeEmptySparkThread(importDir);
    const ctx = testSparkContext(dir, "main");
    const importCtx = testSparkContext(importDir, "main");
    const { tools } = registerSparkToolsForTest();

    const recorded = await executeSparkTool(tools, "spark_learning_record", ctx, {
      id: "learning-explicit-export",
      title: "Export shared learnings explicitly",
      statement:
        ".spark is local runtime state; share learnings through explicit Markdown exports.",
      category: "decision",
      scope: "project",
      evidenceRefs: ["artifact:decision-gate"],
      tags: ["nyakore", "spark"],
      confidence: 0.9,
    });
    assert.match(toolText(recorded), /Recorded learning artifact:learning-explicit-export/);

    const search = await executeSparkTool(tools, "spark_learning_search", ctx, {
      query: "explicit Markdown exports",
    });
    assert.match(toolText(search), /Export shared learnings explicitly/);

    const read = await executeSparkTool(tools, "spark_learning_read", ctx, {
      ref: "artifact:learning-explicit-export",
    });
    assert.match(toolText(read), /local runtime state/);

    const exportPath = join("exports", "learnings.md");
    const exported = await executeSparkTool(tools, "spark_learning_export_markdown", ctx, {
      outputPath: exportPath,
    });
    assert.match(toolText(exported), /Exported 1 learning/);
    assert.match(await readFile(join(dir, exportPath), "utf8"), /```json spark-learning/);

    const dryRun = await executeSparkTool(tools, "spark_learning_import_markdown", importCtx, {
      inputPath: join(dir, exportPath),
    });
    assert.match(toolText(dryRun), /Dry-run parsed 1 learning/);
    assert.equal((await defaultLearningStore(importDir).list()).length, 0);

    const imported = await executeSparkTool(tools, "spark_learning_import_markdown", importCtx, {
      inputPath: join(dir, exportPath),
      apply: true,
    });
    assert.match(toolText(imported), /Imported 1 learning/);
    assert.equal((await defaultLearningStore(importDir).list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(importDir, { recursive: true, force: true });
  }
});

void test("spark learning import accepts legacy compound-learnings directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-legacy-learnings-"));
  try {
    await writeEmptySparkThread(dir);
    const learningDir = join(dir, ".learnings", "gotchas");
    await mkdir(learningDir, { recursive: true });
    await writeFile(
      join(learningDir, "stripe-webhook-raw-body.md"),
      `---
title: "Webhook 验证必须使用 raw body"
category: gotchas
tags: [stripe, webhook, python]
created: 2025-01-15
context: "集成 Stripe webhook 时验证始终失败"
---

## 问题

Stripe webhook 签名验证要求使用原始请求体（raw body），但 FastAPI 默认会解析 JSON。

## 解决方案

在验证前获取 raw body。
`,
    );
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const dryRun = await executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
      inputPath: ".learnings",
    });
    assert.match(toolText(dryRun), /legacy-compound-learnings/);
    assert.match(toolText(dryRun), /Dry-run parsed 1 learning/);
    assert.equal((await defaultLearningStore(dir).list()).length, 0);

    const imported = await executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
      inputPath: ".learnings",
      apply: true,
    });
    assert.match(toolText(imported), /Imported 1 learning/);

    const results = await defaultLearningStore(dir).search({ query: "raw body stripe" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.record.category, "gotcha");
    assert.deepEqual(results[0]?.record.tags, ["stripe", "webhook", "python"]);
    assert.match(results[0]?.record.sourceContent ?? "", /FastAPI/);

    await executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
      inputPath: ".learnings",
      apply: true,
    });
    assert.equal((await defaultLearningStore(dir).list()).length, 1);

    const deleted = await executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
      inputPath: ".learnings",
      apply: true,
      deleteLegacyAfterVerifiedExport: true,
      verificationExportPath: "exports/verified-learnings.md",
    });
    assert.match(toolText(deleted), /deleted legacy source/);
    assert.equal(existsSync(join(dir, ".learnings")), false);
    assert.equal(existsSync(join(dir, "exports", "verified-learnings.md")), true);
    assert.equal((await defaultLearningStore(dir).list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark learning tools keep candidate and inactive lifecycle explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-learning-lifecycle-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "spark_learning_record", ctx, {
      id: "learning-review-candidates",
      title: "Review candidates before activation",
      statement: "Task-derived learning candidates should not enter active recall automatically.",
      status: "candidate",
      category: "workflow",
    });
    const defaultSearch = await executeSparkTool(tools, "spark_learning_search", ctx, {
      query: "Task-derived",
    });
    assert.match(toolText(defaultSearch), /No matching learnings/);

    const candidateSearch = await executeSparkTool(tools, "spark_learning_search", ctx, {
      query: "Task-derived",
      includeCandidates: true,
    });
    assert.match(toolText(candidateSearch), /Review candidates before activation/);

    const rejected = await executeSparkTool(tools, "spark_learning_reject", ctx, {
      ref: "artifact:learning-review-candidates",
      reason: "Candidate was intentionally not promoted.",
    });
    assert.match(toolText(rejected), /Rejected learning candidate/);

    await executeSparkTool(tools, "spark_learning_record", ctx, {
      id: "learning-old-policy",
      title: "Old policy",
      statement: "Old learning policy.",
    });
    const stale = await executeSparkTool(tools, "spark_learning_mark_stale", ctx, {
      ref: "artifact:learning-old-policy",
      reason: "Policy was replaced.",
    });
    assert.match(toolText(stale), /Marked stale/);

    const all = await executeSparkTool(tools, "spark_learning_list", ctx, {
      includeInactive: true,
    });
    assert.match(toolText(all), /rejected/);
    assert.match(toolText(all), /stale/);
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
    assert.match(toolText(created), /Created new Spark thread/);
    assert.equal((created.details as { created?: boolean } | undefined)?.created, true);
    const artifacts = await defaultArtifactStore(dir).list({
      kind: "ask-answer",
    });
    assert.equal(artifacts.length, 1);
    const traces = await defaultArtifactStore(dir).list({
      kind: "run-trace",
    });
    const askArtifact = await defaultArtifactStore(dir).get(artifacts[0].ref);
    const askBody = askArtifact.body as {
      request?: { questions?: Array<{ id: string; prompt?: string }> };
    };
    assert.ok(askBody.request?.questions?.every((question) => question.prompt?.includes("tasks")));
    assert.ok(traces.some((artifact) => artifact.title === "Thread intent clarification"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_use_thread reports selected existing threads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-use-thread-existing-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const selected = await executeSparkTool(tools, "spark_use_thread", ctx, {
      thread: "Tool persistence",
    });

    assert.match(toolText(selected), /Selected existing Spark thread/);
    assert.equal((selected.details as { created?: boolean } | undefined)?.created, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("all spark tools describe prerequisites and operation semantics", () => {
  const { tools } = registerSparkToolsForTest();
  const sparkTools = [...tools.values()].filter((tool) => tool.name.startsWith("spark_"));
  assert.ok(sparkTools.length >= 20);
  for (const tool of sparkTools) {
    assert.match(tool.description, /\nAtomic: /, `${tool.name} is missing Atomic marker`);
    assert.match(tool.description, /\nIdempotent: /, `${tool.name} is missing Idempotent marker`);
    assert.match(tool.description, /\nPrerequisites:\n- /, `${tool.name} is missing prerequisites`);
  }
});

void test("spark_list_threads returns structured filtered thread summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-list-threads-"));
  try {
    await writeEmptySparkThread(dir);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [activeThread] = graph.threads();
    assert.ok(activeThread);
    const doneThread = graph.createThread({
      title: "Finished thread",
      description: "Thread that should only appear in done/all filters.",
      status: "done",
    });
    graph.createTask({
      threadRef: activeThread.ref,
      name: "active-work",
      title: "Active work",
      description: "Active work item.",
      status: "pending",
    });
    graph.createTask({
      threadRef: activeThread.ref,
      name: "finished-work",
      title: "Finished work",
      description: "Finished work item.",
      status: "done",
    });
    graph.createTask({
      threadRef: activeThread.ref,
      name: "cancelled-work",
      title: "Cancelled work",
      description: "Cancelled work item.",
      status: "cancelled",
    });
    graph.createTask({
      threadRef: doneThread.ref,
      name: "done-thread-work",
      title: "Done thread work",
      description: "Done thread work item.",
      status: "done",
    });
    await store.save(graph);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "spark_use_thread", ctx, { thread: activeThread.ref });

    const active = JSON.parse(
      toolText(await executeSparkTool(tools, "spark_list_threads", ctx, {})),
    ) as Array<{
      ref: string;
      status: string;
      currentForSession: boolean;
      taskCounts: { total: number; active: number; done: number; cancelled: number };
    }>;
    assert.deepEqual(
      active.map((thread) => thread.ref),
      [activeThread.ref],
    );
    assert.equal(active[0]?.currentForSession, true);
    assert.deepEqual(active[0]?.taskCounts, { total: 3, active: 1, done: 1, cancelled: 1 });

    const done = JSON.parse(
      toolText(await executeSparkTool(tools, "spark_list_threads", ctx, { status: "done" })),
    ) as Array<{ ref: string; status: string; currentForSession: boolean }>;
    assert.deepEqual(
      done.map((thread) => thread.ref),
      [doneThread.ref],
    );
    assert.equal(done[0]?.currentForSession, false);

    const all = JSON.parse(
      toolText(await executeSparkTool(tools, "spark_list_threads", ctx, { status: "all" })),
    ) as Array<{ ref: string }>;
    assert.deepEqual(
      all.map((thread) => thread.ref),
      [activeThread.ref, doneThread.ref],
    );
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
    assert.match(statusText, /Spark available: no thread selected/);
    assert.doesNotMatch(statusText, /Thread Tool persistence/);
    const summary = await executeSparkTool(tools, "spark_status", ctx, { view: "summary" });
    assert.match(toolText(summary), /Tool persistence/);
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
    assert.match(toolText(status), /Spark available: no thread selected/);
    assert.doesNotMatch(toolText(status), /Next workflow \[current\]/);
    assert.doesNotMatch(toolText(status), /Completed workflow \[current\]/);
    const summary = await executeSparkTool(tools, "spark_status", ctx, { view: "summary" });
    assert.match(toolText(summary), /Next workflow/);

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

void test("spark_run_ready_tasks reports DAG completion without queuing a follow-up user message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-followup-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  try {
    process.env.PI_ROLES_HOME = dir;
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.inputValue = "test/model";
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [thread] = graph.threads();
    assert.ok(thread);
    const otherThread = graph.createThread({
      title: "Other DAG thread",
      description: "Must not be scheduled by current-thread DAG execution.",
    });
    const otherTask = graph.createTask({
      threadRef: otherThread.ref,
      name: "other-ready-role",
      title: "Other ready role task",
      description: "This task is ready but belongs to another thread.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Other ready role task"),
    });
    graph.createTask({
      threadRef: thread.ref,
      name: "ready-role",
      title: "Ready role task",
      description: "Run a quick fake role-run.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Ready role task"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'done' }) + '\\n');\nprocess.exit(0);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const { tools, messages } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);
    await executeSparkTool(tools, "spark_run_ready_tasks", ctx, { dryRun: false });
    await waitFor(
      () => ctx.notifications.some((notice) => notice.message.includes("Spark DAG run:")),
      10_000,
    );
    await waitFor(() => !ctx.notifications.at(-1)?.message.includes("running"), 10_000);

    const dagStatus = await defaultSparkDagRunStore(dir).status();
    assert.equal(dagStatus.succeeded, 1);
    assert.equal(dagStatus.lastRun?.threadRef, thread.ref);
    const reloadedGraph = await defaultTaskGraphStore(dir).load();
    assert.equal(reloadedGraph?.getTask(otherTask.ref).status, "pending");
    assert.doesNotMatch(messages.join("\n"), /Spark DAG run:/);
    assert.equal(ctx.notifications.at(-1)?.level, "info");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark DAG run:/);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /scheduled 1, completed 1/);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_run_ready_tasks marks DAG manager failed when child role-run fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-child-failed-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  try {
    process.env.PI_ROLES_HOME = dir;
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.inputValue = "test/model";
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [thread] = graph.threads();
    assert.ok(thread);
    graph.createTask({
      threadRef: thread.ref,
      name: "empty-role",
      title: "Empty role task",
      description: "Run a fake role-run that produces no evidence.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Empty role task"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(fakePi, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const { tools, messages } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);
    await executeSparkTool(tools, "spark_run_ready_tasks", ctx, { dryRun: false });
    await waitFor(
      () => ctx.notifications.some((notice) => notice.message.includes("Spark DAG run:")),
      3_000,
    );
    await waitFor(() => !ctx.notifications.at(-1)?.message.includes("running"), 3_000);

    const dagStatus = await defaultSparkDagRunStore(dir).status();
    assert.equal(dagStatus.succeeded, 0);
    assert.equal(dagStatus.failed, 1);
    assert.equal(dagStatus.lastRun?.status, "failed");
    assert.doesNotMatch(messages.join("\n"), /Spark DAG .* failed: scheduled 1, completed 1/);
    assert.equal(ctx.notifications.at(-1)?.level, "error");
    assert.match(
      ctx.notifications.at(-1)?.message ?? "",
      /Spark DAG .* failed: scheduled 1, completed 1/,
    );
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Inspect the DAG manager error/);
    await waitFor(() => existsSync(join(dir, ".spark", "todos")), 3_000);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
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
      claim: {
        kind: "main",
        claimedBy: sessionKey,
        sessionId: sessionKey,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    });
    graph.createTask({
      threadRef: thread.ref,
      name: "other",
      title: "Other pending task",
      description: "Visible unfinished work from another session.",
      kind: "review",
      status: "pending",
      claimedBySession: otherSessionKey,
      claim: {
        kind: "main",
        claimedBy: otherSessionKey,
        sessionId: otherSessionKey,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
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
    await useOnlySparkThread(tools, ctx);
    const active = await executeSparkTool(tools, "spark_status", ctx, {});
    const activeText = toolText(active);
    assert.match(activeText, /Spark tasks \(active view, limit=20\):/);
    assert.match(activeText, /Tool persistence \[current\]/);
    assert.doesNotMatch(activeText, /Thread status: active/);
    assert.match(activeText, /Active tasks:/);
    assert.match(activeText, /Mine running task/);
    assert.match(activeText, /Other pending task/);
    assert.doesNotMatch(activeText, /plan=present/);
    assert.doesNotMatch(activeText, /plan=/);
    assert.doesNotMatch(activeText, /missing-success|missing-evidence/);
    assert.doesNotMatch(activeText, /Finished task history/);
    assert.doesNotMatch(activeText, /Cancelled task history/);
    assert.doesNotMatch(activeText, /kind=implement/);
    assert.doesNotMatch(activeText, /claimed=session:/);
    assert.doesNotMatch(activeText, new RegExp(thread.ref));
    assert.match(activeText, /Hidden finished tasks: 2 \(use view=full to include\)/);
    assert.equal(active.details?.view, "active");
    assert.equal(active.details?.limit, 20);
    assert.equal(active.details?.activeThreadRef, thread.ref);
    assert.equal("tasks" in active.details!, false);
    assert.equal("dependencies" in active.details!, false);

    const json = await executeSparkTool(tools, "spark_status", ctx, { format: "json" });
    const jsonText = toolText(json);
    assert.doesNotMatch(jsonText, /Spark tasks \(/);
    const jsonStatus = JSON.parse(jsonText) as {
      found: boolean;
      format: string;
      view: string;
      renderedThreads: Array<{
        ref: string;
        current: boolean;
        taskCounts: { total: number; claimedBySession: number };
        tasks: Array<{ name: string; title: string; owner: string }>;
      }>;
      independentTodos: { total: number; todos: unknown[] };
    };
    assert.equal(jsonStatus.found, true);
    assert.equal(jsonStatus.format, "json");
    assert.equal(jsonStatus.view, "active");
    assert.equal(jsonStatus.renderedThreads[0]?.ref, thread.ref);
    assert.equal(jsonStatus.renderedThreads[0]?.current, true);
    assert.equal(jsonStatus.renderedThreads[0]?.taskCounts.total, 4);
    assert.equal(jsonStatus.renderedThreads[0]?.taskCounts.claimedBySession, 1);
    assert.deepEqual(
      jsonStatus.renderedThreads[0]?.tasks.map((task) => task.name),
      ["mine", "other"],
    );
    assert.equal(jsonStatus.independentTodos.total, 0);
    assert.equal(json.details?.format, "json");

    const limited = await executeSparkTool(tools, "spark_status", ctx, { limit: 1 });
    const limitedText = toolText(limited);
    assert.match(limitedText, /Spark tasks \(active view, limit=1\):/);
    assert.match(limitedText, /Hidden by limit: 1/);
    assert.equal((limitedText.match(/^ {2}- \[/gm) ?? []).length, 1);

    const summary = await executeSparkTool(tools, "spark_status", ctx, { view: "summary" });
    const summaryText = toolText(summary);
    assert.match(summaryText, /Spark tasks \(summary view\):/);
    assert.match(summaryText, /Tasks: 4 total/);
    assert.doesNotMatch(summaryText, /Active tasks:/);
    assert.doesNotMatch(summaryText, /^ {2}- \[/m);
    assert.equal(summary.details?.view, "summary");
    assert.equal(summary.details?.limit, undefined);

    const full = await executeSparkTool(tools, "spark_status", ctx, { view: "full" });
    const fullText = toolText(full);
    assert.match(fullText, /Spark tasks \(full view\):/);
    assert.match(fullText, /Durable tasks:/);
    assert.match(fullText, /Finished task history/);
    assert.match(fullText, /Cancelled task history/);
    assert.match(fullText, /Spark state cache:/);
    assert.match(fullText, /current-thread: \d+ files/);
    assert.match(fullText, /Protected stores:/);
    assert.match(fullText, /thread graph: 1 files/);
    assert.doesNotMatch(fullText, /Hidden finished tasks/);
    assert.equal(full.details?.view, "full");
    assert.equal(full.details?.limit, undefined);
    const state = (
      full.details as
        | {
            state?: {
              caches: Array<{ kind: string; files: number }>;
              protectedStores: Array<{ reason: string; files: number }>;
            };
          }
        | undefined
    )?.state;
    assert.ok(state);
    assert.ok(state.caches.some((cache) => cache.kind === "current-thread" && cache.files >= 1));
    assert.ok(
      state.protectedStores.some((store) => store.reason === "task-graph" && store.files === 1),
    );

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
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: Array.from({ length: 8 }, (_, index) => ({
        name: `task-${index + 1}`,
        title: `Task ${index + 1}`,
        description: `Bounded output task ${index + 1}.`,
        plan: executionReadyPlan(`Bounded output task ${index + 1}.`),
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

async function writeRoadmap(
  cwd: string,
  input: {
    activeItemRef?: string;
    items: Array<{
      ref: string;
      title?: string;
      objective: string;
      scope?: string;
      status?: string;
      successCriteria?: string[];
      evidenceRequired?: string[];
    }>;
  },
): Promise<void> {
  await mkdir(join(cwd, ".spark"), { recursive: true });
  await writeFile(
    join(cwd, ".spark", "roadmap.json"),
    `${JSON.stringify(
      {
        version: 1,
        activeRoadmapRef: "roadmap:main",
        activeItemRef: input.activeItemRef,
        roadmaps: [
          {
            ref: "roadmap:main",
            title: "Project roadmap",
            status: "active",
            activeItemRef: input.activeItemRef,
            items: input.items,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function registerSparkToolsForTest(): {
  tools: Map<string, SparkToolConfig>;
  messages: string[];
  customMessages: Array<{ customType: string; content: string; display?: boolean }>;
  commands: Map<string, Parameters<SparkExtensionApiForTest["registerCommand"]>[1]>;
  eventHandlers: Map<string, Array<(event: unknown, ctx: TestSparkContext) => unknown>>;
} {
  const tools = new Map<string, SparkToolConfig>();
  const messages: string[] = [];
  const customMessages: Array<{ customType: string; content: string; display?: boolean }> = [];
  const commands = new Map<string, Parameters<SparkExtensionApiForTest["registerCommand"]>[1]>();
  const eventHandlers = new Map<
    string,
    Array<(event: unknown, ctx: TestSparkContext) => unknown>
  >();
  const pi: SparkExtensionApiForTest & {
    getAllTools: () => Array<{ name: string }>;
    setActiveTools: (names: string[]) => void;
  } = {
    registerCommand: (name, config) => {
      commands.set(name, config);
    },
    registerTool: (config) => {
      tools.set(config.name, config);
    },
    on: (event, handler) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler as (event: unknown, ctx: TestSparkContext) => unknown);
      eventHandlers.set(event, handlers);
    },
    sendMessage: (message) => {
      customMessages.push(message);
    },
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools: () => undefined,
  };
  sparkExtension(pi);
  return { tools, messages, customMessages, commands, eventHandlers };
}

async function consumeSparkModeContext(
  run: ReturnType<typeof registerSparkToolsForTest>,
  ctx: TestSparkContext,
): Promise<string> {
  for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
    const result = (await handler({}, ctx)) as
      | { message?: { customType?: string; content?: string; display?: boolean } }
      | undefined;
    if (result?.message?.customType === "spark-mode-context") {
      assert.equal(result.message.display, false);
      assert.ok(result.message.content);
      return result.message.content;
    }
  }
  assert.fail("missing hidden Spark mode context");
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

async function useOnlySparkThread(
  tools: Map<string, SparkToolConfig>,
  ctx: TestSparkContext,
): Promise<void> {
  await executeSparkTool(tools, "spark_use_thread", ctx, { thread: "Tool persistence" });
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
      input: async () => context.inputValue,
      select: async () => context.selected,
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
