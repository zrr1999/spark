import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  stableId,
  type RoleRef,
  type RunRef,
  type TaskPlan,
  type TaskRef,
  type ThreadRef,
} from "spark-core";
import { defaultArtifactStore } from "spark-artifacts";
import { defaultLearningStore } from "spark-learnings";
import { defaultSparkDagRunStore } from "spark-orchestrator";
import { killActiveSparkRoleRunProcesses, listActiveSparkRoleRunProcesses } from "spark-runtime";
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

    await mkdir(join(existingDir, ".git"));
    await writeFile(join(existingDir, "README.md"), "# Existing project\n", "utf8");
    const existingCtx = testSparkContext(existingDir, "main");
    existingCtx.inputValue = "Audit existing project structure";
    const existingRun = registerSparkToolsForTest();
    const existingCommand = existingRun.commands.get("spark");
    assert.ok(existingCommand, "missing /spark command");
    await existingCommand.handler("", existingCtx);
    assert.ok(existsSync(join(existingDir, ".spark", "thread.json")));
    assert.ok(existsSync(join(existingDir, "SPARK.md")));
    assert.equal(existingRun.messages.length, 0);
    assert.equal(existingRun.customMessages.length, 1);
    assert.doesNotMatch(existingRun.customMessages[0]?.content ?? "", /Spark initialized/);
    assert.match(existingRun.customMessages[0]?.content ?? "", /Spark planning mode requested/);
    const existingMessage = await consumeSparkModeContext(existingRun, existingCtx);
    assert.match(existingMessage, /Enter Spark planning mode/);
    assert.match(existingMessage, /Audit existing project structure/);
    assert.match(existingMessage, /answer directly for a simple research\/read-and-comment turn/);
    assert.match(existingMessage, /spark_plan_tasks only when there are concrete plan-bound tasks/);
    assert.match(existingMessage, /context-specific spark_ask questions/);
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
        title: "Implementation task needing a plan",
        description: "Implementation task needing a plan",
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

    initializedCtx.selected = "Run “Tool persistence”";
    await initializedCommand.handler("keep running until done", initializedCtx);
    assert.match(initializedRun.customMessages.at(-1)?.content ?? "", /Spark run mode requested/);
    assert.equal(await tryConsumeSparkModeContext(initializedRun, initializedCtx), undefined);

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

void test("/plan, /execute, and /run enter Spark modes directly", async () => {
  const existingDir = await mkdtemp(join(tmpdir(), "spark-plan-direct-existing-"));
  const initializedDir = await mkdtemp(join(tmpdir(), "spark-execute-direct-initialized-"));
  const emptyDir = await mkdtemp(join(tmpdir(), "spark-execute-direct-empty-"));
  try {
    await mkdir(join(existingDir, ".git"));
    await writeFile(join(existingDir, "README.md"), "# Existing project\n", "utf8");
    const existingCtx = testSparkContext(existingDir, "main");
    const existingRun = registerSparkToolsForTest();
    const planCommand = existingRun.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");
    await planCommand.handler("Audit current task flow", existingCtx);
    assert.ok(existsSync(join(existingDir, ".spark", "thread.json")));
    assert.equal(existsSync(join(existingDir, "SPARK.md")), false);
    assert.equal(existingRun.messages.length, 0);
    assert.equal(existingRun.customMessages.length, 1);
    assert.doesNotMatch(existingRun.customMessages[0]?.content ?? "", /Spark initialized/);
    assert.doesNotMatch(
      existingRun.customMessages[0]?.content ?? "",
      /Enter Spark planning mode from \/plan/,
    );
    assert.match(existingRun.customMessages[0]?.content ?? "", /Spark planning mode requested/);
    assert.match(existingRun.customMessages[0]?.content ?? "", /Audit current task flow/);
    const planMessage = await consumeSparkModeContext(existingRun, existingCtx);
    assert.match(planMessage, /Enter Spark planning mode from \/plan/);
    assert.match(planMessage, /not as a permission gate/);
    assert.match(planMessage, /Audit current task flow/);
    assert.match(planMessage, /context-specific spark_ask questions/);
    assert.match(planMessage, /target thread selection/);
    assert.match(planMessage, /design options only or durable task planning/);
    assert.match(planMessage, /Do not call spark_plan_tasks while those choices remain unresolved/);
    assert.match(planMessage, /do not leave them as prose/);
    assert.match(planMessage, /do not use canned intake templates/);
    assert.match(
      planMessage,
      /Once planning-affecting uncertainty is resolved, call spark_plan_tasks directly/,
    );
    assert.doesNotMatch(
      planMessage,
      /answer directly for a simple research\/read-and-comment turn/,
    );
    const planningState = JSON.parse(
      await readFile(
        join(existingDir, ".spark", "current-thread", `${ctxSessionStoreScope(existingCtx)}.json`),
        "utf8",
      ),
    ) as { planningMode?: { source?: string; threadRef?: string; focus?: string } };
    assert.equal(planningState.planningMode?.source, "direct");
    assert.match(planningState.planningMode?.threadRef ?? "", /^thread:/);
    assert.equal(planningState.planningMode?.focus, "Audit current task flow");

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
        title: "Direct execution task needing a plan",
        description: "Direct execution task needing a plan",
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
    assert.match(executeMessage, /Claim at most one concrete task/);
    assert.match(executeMessage, /Stop after that task finishes/);
    assert.match(executeMessage, /suggest \/run-sequential or \/run-parallel/);
    assert.doesNotMatch(executeMessage, /continue by auto-claiming/);
    assert.equal(
      initializedCtx.notifications.at(-1)?.message,
      "Spark execution mode: execute one task, then stop.",
    );

    const runCommand = initializedRun.commands.get("run");
    assert.ok(runCommand, "missing /run command");
    await runCommand.handler("Finish the queue until done", initializedCtx);
    assert.match(initializedRun.customMessages.at(-1)?.content ?? "", /Spark run mode requested/);
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Finish the queue until done/,
    );
    assert.equal(await tryConsumeSparkModeContext(initializedRun, initializedCtx), undefined);
    assert.match(
      initializedCtx.notifications.at(-1)?.message ?? "",
      /Spark run mode: sequential background orchestrator run:/,
    );
    const currentThreadState = JSON.parse(
      await readFile(
        join(
          initializedDir,
          ".spark",
          "current-thread",
          `${ctxSessionStoreScope(initializedCtx)}.json`,
        ),
        "utf8",
      ),
    ) as {
      runMode?: {
        runRef?: string;
        threadRef?: string;
        focus?: string;
        status?: string;
        policy?: { maxConcurrency?: number; timeoutMs?: number };
      };
    };
    assert.match(currentThreadState.runMode?.runRef ?? "", /^run:/);
    assert.match(currentThreadState.runMode?.threadRef ?? "", /^thread:/);
    assert.equal(currentThreadState.runMode?.focus, "Finish the queue until done");
    assert.equal(currentThreadState.runMode?.status, "running");
    assert.equal(currentThreadState.runMode?.policy?.maxConcurrency, 1);
    assert.equal(currentThreadState.runMode?.policy?.timeoutMs, 3_600_000);
    await waitFor(async () => {
      const status = await executeSparkTool(
        initializedRun.tools,
        "spark_status",
        initializedCtx,
        {},
      );
      return /Spark run mode: blocked run:/.test(toolText(status));
    });
    const runStatus = await executeSparkTool(
      initializedRun.tools,
      "spark_status",
      initializedCtx,
      {},
    );
    assert.match(toolText(runStatus), /Spark run mode: blocked run:/);
    assert.match(toolText(runStatus), /focus=Finish the queue until done/);
    assert.match(toolText(runStatus), /strategy=sequential/);

    const runParallelCommand = initializedRun.commands.get("run-parallel");
    const runSequentialCommand = initializedRun.commands.get("run-sequential");
    assert.ok(runParallelCommand, "missing /run-parallel command");
    assert.ok(runSequentialCommand, "missing /run-sequential command");
    await runParallelCommand.handler("Finish the queue in parallel", initializedCtx);
    const parallelThreadState = JSON.parse(
      await readFile(
        join(
          initializedDir,
          ".spark",
          "current-thread",
          `${ctxSessionStoreScope(initializedCtx)}.json`,
        ),
        "utf8",
      ),
    ) as { runMode?: { focus?: string; policy?: { maxConcurrency?: number } } };
    assert.equal(parallelThreadState.runMode?.focus, "Finish the queue in parallel");
    assert.equal(parallelThreadState.runMode?.policy?.maxConcurrency, 4);

    const emptyCtx = testSparkContext(emptyDir, "main");
    const emptyRun = registerSparkToolsForTest();
    const emptyExecute = emptyRun.commands.get("execute");
    assert.ok(emptyExecute, "missing /execute command");
    await emptyExecute.handler("", emptyCtx);
    assert.match(emptyCtx.notifications.at(-1)?.message ?? "", /needs initialized Spark state/);
    const emptyRunCommand = emptyRun.commands.get("run");
    assert.ok(emptyRunCommand, "missing /run command");
    await emptyRunCommand.handler("", emptyCtx);
    assert.match(emptyCtx.notifications.at(-1)?.message ?? "", /needs initialized Spark state/);
  } finally {
    await rm(existingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(initializedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("latest direct Spark mode replaces older pending hidden mode context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-mode-context-replace-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkThread(run.tools, ctx);

    const runCommand = run.commands.get("run");
    const executeCommand = run.commands.get("execute");
    const planCommand = run.commands.get("plan");
    assert.ok(runCommand, "missing /run command");
    assert.ok(executeCommand, "missing /execute command");
    assert.ok(planCommand, "missing /plan command");

    await runCommand.handler("work through background queue", ctx);
    await executeCommand.handler("take one task", ctx);
    await planCommand.handler("revise the failed task plan", ctx);

    const hidden = await consumeSparkModeContext(run, ctx);
    assert.match(hidden, /Enter Spark planning mode from \/plan/);
    assert.match(hidden, /revise the failed task plan/);
    assert.doesNotMatch(hidden, /Enter Spark run mode/);
    assert.doesNotMatch(hidden, /Enter Spark execution mode/);
  } finally {
    await rm(dir, { recursive: true, force: true });
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
    await useOnlySparkThreadInExplicitPlanMode(tools, ctx);

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
    assert.equal((planned.details as { approval?: unknown }).approval, undefined);
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

void test("spark_plan_tasks writes directly whenever durable planning is needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-direct-any-mode-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools, commands } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const noMode = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "direct-no-mode",
          title: "Direct plan outside prompt mode",
          description: "Save durable planning without requiring explicit /plan mode.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Save durable planning without requiring explicit /plan mode."),
        },
      ],
    });
    assert.match(toolText(noMode), /Planned tasks: created=1 updated=0/);

    const executeCommand = commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("Do one task", ctx);
    const duringExecute = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "direct-execute-mode",
          title: "Direct plan during execution prompt",
          description: "Save durable planning when the model detects planning is needed.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan(
            "Save durable planning when the model detects planning is needed.",
          ),
        },
      ],
    });
    assert.match(toolText(duringExecute), /Planned tasks: created=1 updated=0/);

    const graph = await defaultTaskGraphStore(dir).load();
    assert.deepEqual(
      graph
        ?.tasks()
        .map((task) => task.name)
        .sort(),
      ["direct-execute-mode", "direct-no-mode"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_plan_tasks writes directly without approval UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-direct-write-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = undefined as never;
    ctx.ui.input = undefined as never;
    ctx.ui.custom = undefined;
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "direct-plan-write",
          title: "Direct plan write task",
          description: "Exercise direct saving of ready task plans.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Exercise direct saving of ready task plans."),
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    const details = planned.details as { error?: string; approval?: unknown; dryRun?: unknown };
    assert.equal(details.error, undefined);
    assert.equal(details.approval, undefined);
    assert.equal(details.dryRun, undefined);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 1);
    assert.equal(graph?.tasks()[0]?.name, "direct-plan-write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_plan_tasks blocks mixed readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-readiness-mixed-"));
  try {
    await writeEmptySparkThread(dir);
    const before = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "ready-plan",
          title: "Ready task",
          description: "A ready task that should not save when a sibling is blocked.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("A ready task that should not save when a sibling is blocked."),
        },
        {
          name: "blocked-plan",
          title: "Blocked task",
          description: "A blocked task that should prevent saving the whole batch.",
          kind: "implement",
          status: "pending",
        },
      ],
    });

    const details = planned.details as
      | {
          dryRun?: unknown;
          error?: string;
          result?: { created?: unknown[] };
          planDecisions?: Array<{ accepted?: boolean; blocked?: boolean }>;
        }
      | undefined;
    assert.match(toolText(planned), /Task plan not ready: @blocked-plan/);
    assert.equal(details?.dryRun, undefined);
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

void test("spark_plan_tasks reports all-rejected readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-rejected-"));
  try {
    await writeEmptySparkThread(dir);
    const before = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("readiness validation should not open a task-plan ask");
    ctx.ui.custom = async () =>
      assert.fail("readiness validation should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "blocked-one",
          title: "Blocked task one",
          description: "A blocked task that should not save.",
          kind: "implement",
          status: "pending",
        },
        {
          name: "blocked-two",
          title: "Blocked task two",
          description: "Another blocked task that should not save.",
          kind: "review",
          status: "pending",
        },
      ],
    });

    assert.match(toolText(planned), /Task plan not ready: @blocked-one/);
    const details = planned.details as
      | {
          dryRun?: unknown;
          error?: string;
          result?: { created?: unknown[] };
          planDecisions?: Array<{ accepted?: boolean; blocked?: boolean }>;
        }
      | undefined;
    assert.equal(details?.dryRun, undefined);
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

void test("/execute stops after one task and only hints the next ready task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-execute-one-task-"));
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

    const run = registerSparkToolsForTest();
    const executeCommand = run.commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("work through the ready queue", ctx);
    const executePrompt = await consumeSparkModeContext(run, ctx);
    assert.match(executePrompt, /Claim at most one concrete task/);
    assert.match(executePrompt, /Stop after that task finishes/);
    assert.doesNotMatch(executePrompt, /continue through ready tasks until blocked/i);
    assert.doesNotMatch(executePrompt, /auto-claiming or dispatching the next ready task/i);

    await executeSparkTool(run.tools, "spark_claim_task", ctx, {
      name: "first-ready",
      title: "First ready task",
      description: "First ready task",
      status: "running",
    });
    const finished = await executeSparkTool(run.tools, "spark_finish_task", ctx, {
      summary: "Finished first ready task.",
    });

    const text = finished.content.map((item) => item.text).join("\n");
    assert.match(text, /Execution mode stopped after one task/);
    assert.match(text, /Next ready task: @second-ready/);
    assert.match(text, /Run \/execute to take one more step, or \/run to continue automatically/);
    assert.doesNotMatch(text, /auto-claimed next ready task/);
    assert.equal((finished.details as { autoClaimedTask?: unknown }).autoClaimedTask, undefined);
    assert.ok((finished.details as { nextReadyTask?: unknown }).nextReadyTask);
    assert.equal(await tryConsumeSparkModeContext(run, ctx), undefined);

    const graph = await defaultTaskGraphStore(dir).load();
    const next = graph?.tasks().find((task) => task.name === "second-ready");
    assert.equal(next?.status, "pending");
    assert.equal(next?.claim, undefined);
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
    await useOnlySparkThreadInExplicitPlanMode(tools, ctx);

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

void test("spark_plan_tasks rejects standalone design/planning tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-not-concrete-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThreadInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "background-role-results-design",
          title: "设计 DAG 子 agent 完成结果的用户/父 agent 可见机制",
          description: "Decide how background child role-run results should be visible.",
          kind: "plan",
          status: "pending",
          plan: executionReadyPlan("Decide result visibility."),
        },
      ],
    });

    assert.match(toolText(planned), /task_not_concrete/);
    assert.match(toolText(planned), /standalone design\/planning/);
    assert.match(toolText(planned), /embed the chosen design in each concrete task\.plan/);
    assert.equal((planned.details as { error?: string }).error, "task_not_concrete");
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
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThreadInExplicitPlanMode(tools, ctx);

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

void test("spark_plan_tasks refuses to cancel tasks that still have dependents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-cancel-dependent-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const thread = graph.threads()[0];
      assert.ok(thread);
      const prerequisite = graph.createTask({
        threadRef: thread.ref,
        name: "kept-prereq",
        title: "Kept prerequisite",
        description: "A prerequisite that is still depended on.",
        status: "pending",
        plan: executionReadyPlan("Keep prerequisite"),
      });
      const dependent = graph.createTask({
        threadRef: thread.ref,
        name: "dependent-work",
        title: "Dependent work",
        description: "Depends on the kept prerequisite.",
        status: "pending",
        plan: executionReadyPlan("Use prerequisite"),
      });
      graph.addDependency(dependent.ref, prerequisite.ref);
    });
    const before = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "kept-prereq",
          title: "Kept prerequisite",
          description: "A prerequisite that is still depended on.",
          kind: "implement",
          status: "cancelled",
        },
      ],
    });

    assert.match(toolText(planned), /Task plan dependency error/);
    assert.match(toolText(planned), /cannot be cancelled/);
    assert.equal((planned.details as { error?: string }).error, "task_dependency_error");
    assert.equal(await readFile(join(dir, ".spark", "thread.json"), "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task accepts a task plan patch without explicit /plan mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-plan-no-mode-gate-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const claimed = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "claim-plan-patch",
      title: "Claim with plan patch",
      description: "A claim-time plan patch can be saved without explicit /plan mode.",
      kind: "implement",
      plan: executionReadyPlan("A claim-time plan patch can be saved without explicit /plan mode."),
    });

    assert.match(toolText(claimed), /Claimed Spark task/);
    const task = (await defaultTaskGraphStore(dir).load())?.tasks()[0];
    assert.equal(task?.name, "claim-plan-patch");
    assert.equal(
      task?.plan?.objective,
      "A claim-time plan patch can be saved without explicit /plan mode.",
    );
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
    await useOnlySparkThreadInExplicitPlanMode(tools, ctx);

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

void test("spark_finish_task refuses to cancel a claimed prerequisite with dependents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-cancel-dependent-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const thread = graph.threads()[0];
      assert.ok(thread);
      const prerequisite = graph.createTask({
        threadRef: thread.ref,
        name: "claimed-prereq",
        title: "Claimed prerequisite",
        description: "A claimed prerequisite with a dependent.",
        status: "running",
        claimedBySession: ctxSessionKey(ctx),
        plan: executionReadyPlan("Keep claimed prerequisite"),
      });
      graph.claimTask(prerequisite.ref, {
        kind: "main",
        claimedBy: ctxSessionKey(ctx),
        sessionId: ctxSessionKey(ctx),
        leaseMs: 60_000,
      });
      const dependent = graph.createTask({
        threadRef: thread.ref,
        name: "dependent-on-claimed",
        title: "Dependent on claimed",
        description: "Depends on the claimed prerequisite.",
        status: "pending",
        plan: executionReadyPlan("Use claimed prerequisite"),
      });
      graph.addDependency(dependent.ref, prerequisite.ref);
    });
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const cancelled = await executeSparkTool(tools, "spark_finish_task", ctx, {
      status: "cancelled",
      summary: "Try to cancel prerequisite.",
    });

    assert.match(toolText(cancelled), /Cannot finish Spark task/);
    assert.match(toolText(cancelled), /cannot be cancelled/);
    assert.equal((cancelled.details as { error?: string }).error, "task_dependency_error");
    const graph = await defaultTaskGraphStore(dir).load();
    const task = graph?.tasks().find((candidate) => candidate.name === "claimed-prereq");
    assert.equal(task?.status, "running");
    assert.ok(task?.claim);
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

void test("spark_status surfaces corrupt current thread state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-corrupt-current-thread-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "status-corrupt-current-thread");
    await mkdir(join(dir, ".spark", "current-thread"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "current-thread", `${ctxSessionStoreScope(ctx)}.json`),
      "{not-json",
      "utf8",
    );
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "spark_status", ctx, {}),
      (error) => error instanceof SyntaxError,
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

void test("spark_status includes persisted Spark orchestrator status", async () => {
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

    assert.match(text, /Spark orchestrator: idle actionable=run:/);
    assert.match(text, /actionable=2/);
    assert.doesNotMatch(text, /stale=1/);
    assert.doesNotMatch(text, /timed_out=1/);
    assert.match(
      text,
      new RegExp(
        `Actionable DAG run: ${staleRun.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[stale\\]`,
      ),
    );
    assert.match(text, /Next steps \(stale\):/);
    assert.match(text, /stale: run spark_background_runs reconcile/);
    const dagDetails = status.details as {
      dag?: {
        stale?: number;
        timedOut?: number;
        nextSteps?: Array<{ status: string; nextActions: string[] }>;
      };
    };
    assert.equal(dagDetails.dag?.stale, 1);
    assert.equal(dagDetails.dag?.timedOut, 1);
    assert.equal(dagDetails.dag?.nextSteps?.[0]?.status, "stale");
    assert.match(dagDetails.dag?.nextSteps?.[0]?.nextActions.join("\n") ?? "", /stale:/);
    assert.deepEqual(
      dagDetails.dag?.nextSteps?.map((step) => step.status),
      ["stale", "timed_out"],
    );
    assert.match(
      dagDetails.dag?.nextSteps?.[1]?.nextActions.join("\n") ?? "",
      /timed_out: legacy foreground timeout record/,
    );
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
    assert.match(toolText(reconciled), /failed=0/);
    assert.match(toolText(reconciled), /stale=1/);
    assert.match(toolText(reconciled), /Next steps \(stale\):/);
    assert.match(toolText(reconciled), /stale: run spark_background_runs reconcile/);
    assert.match(
      (
        (reconciled.details as { dag?: { nextSteps?: Array<{ nextActions: string[] }> } }).dag
          ?.nextSteps?.[0]?.nextActions ?? []
      ).join("\n"),
      /task graph state is consistent/,
    );

    const acknowledged = await executeSparkTool(tools, "spark_dag_manager", ctx, {
      action: "ack",
    });
    assert.match(toolText(acknowledged), /action=ack/);
    assert.match(toolText(acknowledged), /stale=1/);
    assert.match(toolText(acknowledged), /acknowledged=1/);
    assert.match(toolText(acknowledged), /Acknowledged DAG problem runs: 1 newly/);
    assert.doesNotMatch(toolText(acknowledged), /Next steps \(stale\):/);
    const acknowledgedDetails = acknowledged.details as {
      acknowledged?: { acknowledged?: string[] };
      dag?: { acknowledged?: number; recentRuns?: Array<{ acknowledgedBySession?: string }> };
    };
    assert.equal(acknowledgedDetails.dag?.acknowledged, 1);
    assert.equal(acknowledgedDetails.acknowledged?.acknowledged?.length, 1);
    assert.equal(
      acknowledgedDetails.dag?.recentRuns?.find((run) => run.acknowledgedBySession)
        ?.acknowledgedBySession,
      ctxSessionKey(ctx),
    );

    const compactStatus = await executeSparkTool(tools, "spark_status", ctx, {});
    assert.doesNotMatch(toolText(compactStatus), /Spark orchestrator:/);
    assert.doesNotMatch(toolText(compactStatus), /stale=1/);

    const fullStatus = await executeSparkTool(tools, "spark_status", ctx, { view: "full" });
    assert.match(toolText(fullStatus), /Spark orchestrator: idle runs=2 recent/);
    assert.match(toolText(fullStatus), /stale=1/);
    assert.match(toolText(fullStatus), /acknowledged=1/);
    assert.match(toolText(fullStatus), /Recent DAG runs:/);

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

void test("spark_state prune defaults to dry-run and does not write DAG run store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-prune-dryrun-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultSparkDagRunStore(dir);
    const run = await dagStore.startRun({ dryRun: false, maxConcurrency: 1, timeoutMs: 100 });
    await dagStore.finishRun(run.ref, { scheduled: 0, completed: 0, timedOut: false });
    const before = await readFile(join(dir, ".spark", "dag-runs.json"), "utf8");

    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "spark_state", ctx, {
      action: "prune",
      olderThanDays: 0,
      keepRecent: 0,
      keepRecentPerThread: 0,
    });

    assert.match(toolText(result), /Spark DAG run prune dry-run/);
    assert.match(toolText(result), /Candidates: 1; kept=0/);
    const prune = (result.details as { prune?: { dryRun?: boolean; candidates?: unknown[] } })
      .prune;
    assert.equal(prune?.dryRun, true);
    assert.equal(prune?.candidates?.length, 1);
    assert.equal(await readFile(join(dir, ".spark", "dag-runs.json"), "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_background_runs exposes active child runs and refuses broad kill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-background-runs-active-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  const previousPath = process.env.PATH;
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
      name: "background-child",
      title: "Background child task",
      description: "Run a long-lived fake role-run for background inspection.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Background child task"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--list-models' && args[1] === 'test/model') process.exit(0);",
        "if (args[0] === '--list-models') { process.stdout.write('No models matching ' + args[1] + '\\n'); process.exit(0); }",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);
    await executeSparkTool(tools, "spark_run_ready_tasks", ctx, {
      dryRun: false,
      timeoutMs: 50,
    });

    await waitFor(async () => {
      const status = await executeSparkTool(tools, "spark_background_runs", ctx, {
        action: "status",
        includeDetails: true,
      });
      const background = (
        status.details as { background?: { childRuns?: Array<{ activeProcess?: boolean }> } }
      ).background;
      return Boolean(background?.childRuns?.some((child) => child.activeProcess));
    }, 5_000);

    const status = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "status",
      includeDetails: true,
    });
    const statusText = toolText(status);
    assert.match(statusText, /Background work: running/);
    assert.match(statusText, /Active children:/);
    assert.match(statusText, /task=@background-child/);
    assert.match(statusText, /pid=\d+/);
    const statusDetails = status.details as {
      background?: {
        summary?: { state?: string; activeChildren?: number };
        childRuns?: Array<{
          runRef: string;
          taskName?: string;
          activeProcess?: boolean;
          pid?: number;
          claimKind?: string;
        }>;
      };
    };
    assert.equal(statusDetails.background?.summary?.state, "running");
    assert.equal(statusDetails.background?.summary?.activeChildren, 1);
    const child = statusDetails.background?.childRuns?.find((entry) => entry.activeProcess);
    assert.ok(child?.runRef);
    assert.equal(child.taskName, "background-child");
    assert.equal(child.claimKind, "role-run");
    assert.equal(typeof child.pid, "number");

    const inspect = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "inspect",
      runRef: child.runRef,
    });
    assert.match(toolText(inspect), new RegExp(`Background child run: ${child.runRef} active`));
    assert.match(toolText(inspect), /Task: @background-child/);

    const refused = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "kill",
    });
    assert.match(toolText(refused), /kill_requires_target/);
    assert.equal(
      (refused.details as { background?: { error?: string } }).background?.error,
      "kill_requires_target",
    );

    const killed = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "kill",
      runRef: child.runRef,
      forceAfterMs: 0,
    });
    assert.match(toolText(killed), /Stopped background child runs: 1/);
    assert.equal(
      ((killed.details as { background?: { killed?: unknown[] } }).background?.killed ?? []).length,
      1,
    );
    await waitFor(async () => {
      const reloaded = await defaultTaskGraphStore(dir).load();
      return !reloaded?.tasks(thread.ref).some((task) => task.status === "running");
    }, 5_000);
    await waitFor(async () => (await defaultSparkDagRunStore(dir).status()).running === 0, 5_000);
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    if (existsSync(join(dir, ".spark", "dag-runs.json"))) {
      await waitFor(async () => {
        const reloaded = await defaultTaskGraphStore(dir).load();
        return !reloaded?.tasks().some((task) => task.status === "running");
      }, 5_000).catch(() => undefined);
      await waitFor(
        async () => (await defaultSparkDagRunStore(dir).status()).running === 0,
        5_000,
      ).catch(() => undefined);
    }
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_background_runs inspect/list use compact role-run summaries and tail refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-background-runs-role-summary-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [thread] = graph.threads();
    assert.ok(thread);
    const failedTask = graph.createTask({
      threadRef: thread.ref,
      name: "compact-failed-role-run",
      title: "Compact failed role-run task",
      description: "Represents a failed role-run with compact summary evidence.",
      kind: "implement",
      status: "failed",
      plan: executionReadyPlan("Compact failed role-run task"),
    });
    const succeededTask = graph.createTask({
      threadRef: thread.ref,
      name: "compact-succeeded-role-run",
      title: "Compact succeeded role-run task",
      description: "Represents a succeeded role-run with compact summary evidence.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Compact succeeded role-run task"),
    });
    const now = new Date().toISOString();
    const roleRef = "role:builtin-worker" as RoleRef;
    const failedRunRef = "run:compact-failed-role-run" as RunRef;
    const succeededRunRef = "run:compact-succeeded-role-run" as RunRef;
    const transcript = await defaultArtifactStore(dir).put({
      kind: "role-run",
      title: "Failed role-run transcript",
      format: "text",
      body: "full transcript is intentionally behind a ref",
      provenance: {
        producer: "task",
        threadRef: thread.ref,
        taskRef: failedTask.ref,
        roleRef,
        runRef: failedRunRef,
      },
    });
    const failedArtifact = await defaultArtifactStore(dir).put({
      kind: "role-run",
      title: "Failed compact role-run result",
      format: "json",
      body: {
        schemaVersion: 1,
        runRef: failedRunRef,
        taskRef: failedTask.ref,
        roleRef,
        runName: "worker-compact-failed",
        status: "failed",
        startedAt: now,
        finishedAt: now,
        summary: "Failed compact summary: missing required evidence",
        transcriptRef: transcript.ref,
        record: {
          ref: failedRunRef,
          roleRef,
          runName: "worker-compact-failed",
          status: "failed",
          startedAt: now,
          finishedAt: now,
        },
        stdout: { bytes: 50_000, tail: "bounded stdout tail", tailBytes: 19, truncated: true },
        stderr: { bytes: 120, tail: "bounded stderr tail", tailBytes: 19, truncated: false },
        jsonEvents: { count: 42, tail: ['{"type":"error"}'], tailEventCount: 1, truncated: true },
      },
      provenance: {
        producer: "task",
        threadRef: thread.ref,
        taskRef: failedTask.ref,
        roleRef,
        runRef: failedRunRef,
      },
    });
    const succeededArtifact = await defaultArtifactStore(dir).put({
      kind: "role-run",
      title: "Succeeded compact role-run result",
      format: "json",
      body: {
        schemaVersion: 1,
        runRef: succeededRunRef,
        taskRef: succeededTask.ref,
        roleRef,
        runName: "worker-compact-succeeded",
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
        summary: "Succeeded compact summary: docs updated",
        record: {
          ref: succeededRunRef,
          roleRef,
          runName: "worker-compact-succeeded",
          status: "succeeded",
          startedAt: now,
          finishedAt: now,
        },
        stdout: { bytes: 24, tail: "done", tailBytes: 4, truncated: false },
        stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
        jsonEvents: { count: 1, tail: ['{"type":"done"}'], tailEventCount: 1, truncated: false },
      },
      provenance: {
        producer: "task",
        threadRef: thread.ref,
        taskRef: succeededTask.ref,
        roleRef,
        runRef: succeededRunRef,
      },
    });
    const failedRun = graph.recordRun({
      ref: failedRunRef,
      threadRef: thread.ref,
      taskRef: failedTask.ref,
      roleRef,
      runName: "worker-compact-failed",
      status: "failed",
      errorMessage: "missing required evidence",
      startedAt: now,
      finishedAt: now,
      outputArtifacts: [failedArtifact.ref],
      completionSummary: {
        runRef: failedRunRef,
        taskRef: failedTask.ref,
        roleRef,
        runName: "worker-compact-failed",
        status: "failed",
        summary: "Failed compact summary: missing required evidence",
        artifactRefs: [failedArtifact.ref],
        createdAt: now,
      },
    });
    const succeededRun = graph.recordRun({
      ref: succeededRunRef,
      threadRef: thread.ref,
      taskRef: succeededTask.ref,
      roleRef,
      runName: "worker-compact-succeeded",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      outputArtifacts: [succeededArtifact.ref],
      completionSummary: {
        runRef: succeededRunRef,
        taskRef: succeededTask.ref,
        roleRef,
        runName: "worker-compact-succeeded",
        status: "succeeded",
        summary: "Succeeded compact summary: docs updated",
        artifactRefs: [succeededArtifact.ref],
        createdAt: now,
      },
    });
    await store.save(graph);
    const dagStore = defaultSparkDagRunStore(dir);
    const dagRun = await dagStore.startRun({
      threadRef: thread.ref,
      dryRun: false,
      maxConcurrency: 2,
      timeoutMs: 100,
    });
    await dagStore.recordSchedule(dagRun.ref, {
      taskRef: failedTask.ref,
      runRef: failedRunRef,
      scheduled: 1,
    });
    await dagStore.recordProgress(dagRun.ref, {
      taskRef: failedTask.ref,
      run: failedRun,
      completed: 1,
    });
    await dagStore.recordSchedule(dagRun.ref, {
      taskRef: succeededTask.ref,
      runRef: succeededRunRef,
      scheduled: 2,
    });
    await dagStore.recordProgress(dagRun.ref, {
      taskRef: succeededTask.ref,
      run: succeededRun,
      completed: 2,
    });
    await dagStore.finishRun(dagRun.ref, {
      scheduled: 2,
      completed: 2,
      timedOut: false,
      failed: 1,
      runs: [failedRun, succeededRun],
    });

    const inspect = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "inspect",
      runRef: failedRunRef,
    });
    const inspectText = toolText(inspect);
    assert.match(inspectText, /Background child run: run:compact-failed-role-run failed/);
    assert.match(inspectText, /Summary: Failed compact summary: missing required evidence/);
    assert.match(inspectText, new RegExp(`Transcript: ${transcript.ref}`));
    assert.match(inspectText, /Stdout tail: 50000 bytes, showing last 19 bytes \(truncated\)/);
    const inspectDetails = inspect.details as {
      background?: {
        childRuns?: Array<{
          transcriptRef?: string;
          stdoutTail?: { tail?: string; truncated?: boolean };
          jsonEventsTail?: { count?: number; tailEventCount?: number };
        }>;
      };
    };
    assert.equal(inspectDetails.background?.childRuns?.[0]?.transcriptRef, transcript.ref);
    assert.equal(
      inspectDetails.background?.childRuns?.[0]?.stdoutTail?.tail,
      "bounded stdout tail",
    );
    assert.equal(inspectDetails.background?.childRuns?.[0]?.stdoutTail?.truncated, true);
    assert.equal(inspectDetails.background?.childRuns?.[0]?.jsonEventsTail?.count, 42);

    const list = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "list",
      includeHistory: true,
    });
    const listText = toolText(list);
    assert.match(listText, /Child runs:/);
    assert.match(listText, /run:compact-failed-role-run: failed .*Failed compact summary/);
    assert.match(listText, /run:compact-succeeded-role-run: succeeded .*Succeeded compact summary/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_background_runs inspect keeps legacy large role-run artifacts behind refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-background-runs-large-role-artifact-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [thread] = graph.threads();
    assert.ok(thread);
    const task = graph.createTask({
      threadRef: thread.ref,
      name: "legacy-large-background-role-run",
      title: "Legacy large background role-run task",
      description: "Represents an old background role-run with a large full-output artifact.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Legacy large background role-run task"),
    });
    const legacyBodyMarker = "BACKGROUND_LEGACY_ROLE_RUN_FULL_BODY_SENTINEL";
    const artifact = await defaultArtifactStore(dir).put({
      kind: "role-run",
      title: "Legacy large background role-run artifact",
      format: "text",
      body: legacyBodyMarker.repeat(4_000),
      provenance: { producer: "task", threadRef: thread.ref, taskRef: task.ref },
    });
    const now = new Date().toISOString();
    const runRef = "run:legacy-large-background-role-run" as RunRef;
    const roleRef = "role:builtin-worker" as RoleRef;
    graph.recordRun({
      ref: runRef,
      threadRef: thread.ref,
      taskRef: task.ref,
      roleRef,
      runName: "worker-legacy-large-background",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      outputArtifacts: [artifact.ref],
    });
    await store.save(graph);

    const inspect = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "inspect",
      runRef,
    });
    const text = toolText(inspect);
    assert.match(text, /Background child run: run:legacy-large-background-role-run succeeded/);
    assert.match(text, new RegExp(artifact.ref));
    assert.match(text, /legacy_or_unknown_role_run_body: full artifact not loaded/);
    assert.doesNotMatch(text, new RegExp(legacyBodyMarker));
    assert.doesNotMatch(JSON.stringify(inspect.details), new RegExp(legacyBodyMarker));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_background_runs reconciles, acks scoped problems, and renders legacy timeouts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-background-runs-records-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const [thread] = graph.threads();
    assert.ok(thread);
    const dagStore = defaultSparkDagRunStore(dir);
    const stale = await dagStore.startRun({
      threadRef: thread.ref,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const legacy = await dagStore.startRun({
      threadRef: thread.ref,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await dagStore.finishRun(legacy.ref, { scheduled: 1, completed: 0, timedOut: true });

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);
    const reconciled = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "reconcile",
      includeDetails: true,
    });
    assert.match(toolText(reconciled), /Reconciled background records changed: 1/);
    assert.match(toolText(reconciled), /Legacy timeout record/);
    assert.match(toolText(reconciled), /DAG .*stale/);
    const reconcileDetails = reconciled.details as {
      background?: { dagRuns?: Array<{ runRef: string; status: string; legacyTimedOut: boolean }> };
    };
    assert.equal(
      reconcileDetails.background?.dagRuns?.some(
        (run) => run.runRef === stale.ref && run.status === "stale",
      ),
      true,
    );
    assert.equal(
      reconcileDetails.background?.dagRuns?.some(
        (run) => run.runRef === legacy.ref && run.legacyTimedOut,
      ),
      true,
    );

    const acknowledged = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "ack",
    });
    assert.match(toolText(acknowledged), /Acknowledged background problem runs: 2 newly/);
    const ackDetails = acknowledged.details as {
      background?: { acknowledged?: { acknowledged?: string[] }; childRuns?: unknown[] };
    };
    assert.deepEqual(
      ackDetails.background?.acknowledged?.acknowledged?.sort(),
      [legacy.ref, stale.ref].sort(),
    );
    assert.equal(ackDetails.background?.childRuns?.length, 0);

    const dagManager = await executeSparkTool(tools, "spark_dag_manager", ctx, {
      action: "status",
    });
    assert.match(
      toolText(dagManager),
      /Low-level compatibility tool; prefer spark_background_runs/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/run starts the background Spark orchestrator without a second agent turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-run-continuous-dag-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  const previousPath = process.env.PATH;
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
    const first = graph.createTask({
      threadRef: thread.ref,
      name: "run-first",
      title: "Run first task",
      description: "First task in continuous run.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Run first task"),
    });
    const second = graph.createTask({
      threadRef: thread.ref,
      name: "run-second",
      title: "Run second task",
      description: "Second task unblocks after the first task succeeds.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Run second task"),
    });
    graph.addDependency(second.ref, first.ref);
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'done' }) + '\\n');\nprocess.exit(0);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const extension = registerSparkToolsForTest();
    const { tools, commands, messages } = extension;
    await useOnlySparkThread(tools, ctx);
    const runCommand = commands.get("run");
    assert.ok(runCommand, "missing /run command");
    await runCommand.handler("run dependent tasks until done", ctx);
    assert.equal(await tryConsumeSparkModeContext(extension, ctx), undefined);

    await waitFor(async () => {
      const current = await defaultTaskGraphStore(dir).load();
      return current?.getTask(second.ref).status === "done";
    }, 10_000);
    await waitFor(async () => {
      const status = await executeSparkTool(tools, "spark_status", ctx, {});
      return /Spark run mode: done run:/.test(toolText(status));
    }, 10_000);

    const dagStatus = await defaultSparkDagRunStore(dir).status();
    assert.equal(dagStatus.succeeded, 1);
    assert.equal(dagStatus.lastRun?.scheduled, 2);
    assert.equal(dagStatus.lastRun?.completed, 2);
    const reloaded = await defaultTaskGraphStore(dir).load();
    assert.equal(reloaded?.getTask(first.ref).status, "done");
    assert.equal(reloaded?.getTask(second.ref).status, "done");
    assert.doesNotMatch(messages.join("\n"), /Spark DAG run:/);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/run marks run mode blocked when no ready task can run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-run-blocked-"));
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
      name: "blocked-no-plan",
      title: "Blocked no plan",
      description: "No execution-ready plan is present.",
      kind: "implement",
      status: "pending",
    });
    await store.save(graph);

    const { tools, commands } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);
    const runCommand = commands.get("run");
    assert.ok(runCommand, "missing /run command");
    await runCommand.handler("run blocked work", ctx);

    await waitFor(async () => {
      const status = await executeSparkTool(tools, "spark_status", ctx, {});
      return /Spark run mode: blocked run:/.test(toolText(status));
    }, 5_000);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_run_ready_tasks preflights only the current ready frontier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-frontier-preflight-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  const previousPath = process.env.PATH;
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
      name: "ready-worker",
      title: "Ready worker task",
      description: "Only this ready frontier task should be preflighted.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Ready worker task"),
    });
    graph.createTask({
      threadRef: thread.ref,
      name: "blocked-reviewer",
      title: "Blocked reviewer task",
      description: "This future task must not block current frontier dispatch.",
      kind: "review",
      status: "blocked",
      plan: executionReadyPlan("Blocked reviewer task"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--list-models' && args[1] === 'test/model') process.exit(0);",
        "if (args[0] === '--list-models') { process.stdout.write('No models matching ' + args[1] + '\\n'); process.exit(0); }",
        "process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);
    const result = await executeSparkTool(tools, "spark_run_ready_tasks", ctx, { dryRun: false });

    assert.match(toolText(result), /Spark orchestrator started/);
    const bindingFile = JSON.parse(
      await readFile(join(dir, ".agents", "role-model-bindings.json"), "utf8"),
    ) as { bindings: Array<{ roleRef: string }> };
    assert.deepEqual(
      bindingFile.bindings.map((binding) => binding.roleRef),
      ["role:builtin-worker"],
    );
    await waitFor(async () => {
      const dagStatus = await defaultSparkDagRunStore(dir).status();
      return dagStatus.succeeded === 1 || dagStatus.failed > 0;
    }, 10_000);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
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
      name: "ready-role-one",
      title: "Ready role task one",
      description: "Run the first quick fake role-run.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Ready role task one"),
    });
    graph.createTask({
      threadRef: thread.ref,
      name: "ready-role-two",
      title: "Ready role task two",
      description: "Run the second quick fake role-run.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Ready role task two"),
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

    const extension = registerSparkToolsForTest();
    const { tools, messages } = extension;
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
    assert.match(ctx.notifications.at(-1)?.message ?? "", /scheduled 2, completed \d/);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Digest:/);
    assert.equal(dagStatus.lastRun?.completionDigest.length, 2);
    assert.equal(
      dagStatus.lastRun?.completionDigest.every((summary) => summary.status === "succeeded"),
      true,
    );
    assert.equal(
      dagStatus.lastRun?.completionDigest.every((summary) => summary.artifactRefs.length === 1),
      true,
    );
    assert.equal(
      dagStatus.lastRun?.completionDigest.every((summary) => /type.*done/.test(summary.summary)),
      true,
    );

    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    const statusText = toolText(status);
    assert.match(statusText, /Recent role-run completions:/);
    assert.equal((statusText.match(/\[succeeded\] task=task:/gu) ?? []).length, 2);
    assert.equal((statusText.match(/artifacts=artifact:/gu) ?? []).length, 2);
    const statusDetails = status.details as {
      recentRoleRunCompletions?: Array<{ status?: string; artifactRefs?: string[] }>;
    };
    assert.equal(statusDetails.recentRoleRunCompletions?.length, 2);
    assert.equal(
      statusDetails.recentRoleRunCompletions?.every(
        (summary) => summary.status === "succeeded" && summary.artifactRefs?.length === 1,
      ),
      true,
    );

    const hiddenInbox = await consumeSparkModeContext(extension, ctx);
    assert.match(hiddenInbox, /Recent unread background role-run results:/);
    assert.equal((hiddenInbox.match(/\[succeeded\] task=task:/gu) ?? []).length, 2);
    assert.equal((hiddenInbox.match(/artifacts=artifact:/gu) ?? []).length, 2);
    assert.equal(await tryConsumeSparkModeContext(extension, ctx), undefined);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await waitFor(
      () => listActiveSparkRoleRunProcesses().every((process) => process.cwd !== dir),
      5_000,
    ).catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_status renders legacy large role-run artifacts by refs without full body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-status-large-role-run-artifact-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [thread] = graph.threads();
    assert.ok(thread);
    const task = graph.createTask({
      threadRef: thread.ref,
      name: "legacy-large-role-run",
      title: "Legacy large role-run task",
      description: "Represents an old role-run with a large artifact body.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Legacy large role-run task"),
    });
    const legacyBodyMarker = "LEGACY_ROLE_RUN_FULL_BODY_SENTINEL";
    const artifact = await defaultArtifactStore(dir).put({
      kind: "role-run",
      title: "Legacy large role-run artifact",
      format: "text",
      body: legacyBodyMarker.repeat(3_000),
      provenance: { producer: "spark", threadRef: thread.ref, taskRef: task.ref },
    });
    const now = new Date().toISOString();
    const runRef = "run:legacy-large-role-run" as RunRef;
    const roleRef = "role:builtin-worker" as RoleRef;
    graph.recordRun({
      ref: runRef,
      threadRef: thread.ref,
      taskRef: task.ref,
      roleRef,
      runName: "worker-legacy-large",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      outputArtifacts: [artifact.ref],
      completionSummary: {
        runRef,
        taskRef: task.ref,
        roleRef,
        runName: "worker-legacy-large",
        status: "succeeded",
        summary: "Legacy compact summary only",
        artifactRefs: [artifact.ref],
        createdAt: now,
      },
    });
    await store.save(graph);

    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    const text = toolText(status);
    assert.match(text, /Recent role-run completions:/);
    assert.match(text, /Legacy compact summary only/);
    assert.match(text, new RegExp(artifact.ref));
    assert.doesNotMatch(text, new RegExp(legacyBodyMarker));
    assert.doesNotMatch(JSON.stringify(status.details), new RegExp(legacyBodyMarker));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_run_ready_tasks marks Spark orchestrator failed when child role-run fails", async () => {
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

    const extension = registerSparkToolsForTest();
    const { tools, messages } = extension;
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
    assert.match(
      ctx.notifications.at(-1)?.message ?? "",
      /failed: inspect spark_background_runs inspect/,
    );
    const hiddenInbox = await consumeSparkModeContext(extension, ctx);
    assert.match(hiddenInbox, /Recent unread background role-run results:/);
    assert.match(hiddenInbox, /\[failed\] task=task:/);
    assert.match(hiddenInbox, /next=inspect with spark_background_runs inspect runRef=run:/);
    assert.doesNotMatch(hiddenInbox, /full transcript/i);
    assert.equal(await tryConsumeSparkModeContext(extension, ctx), undefined);
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

void test("spark_state cleanup previews and deletes only safe cache files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-cleanup-"));
  try {
    await writeEmptySparkThread(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkThread(tools, ctx);
    const currentSessionScope = ctxSessionStoreScope(ctx);
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000);

    const currentThreadDir = join(dir, ".spark", "current-thread");
    const taskTodoDir = join(dir, ".spark", "todos");
    const sessionTodoDir = join(dir, ".spark", "session-todos");
    const displayNumberDir = join(dir, ".spark", "todo-display-numbers");
    const artifactsDir = join(dir, ".spark", "artifacts");
    await mkdir(currentThreadDir, { recursive: true });
    await mkdir(taskTodoDir, { recursive: true });
    await mkdir(sessionTodoDir, { recursive: true });
    await mkdir(displayNumberDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });

    const missingThreadFile = join(currentThreadDir, "old-owner.json");
    const emptyOtherTaskTodos = join(taskTodoDir, "other-session.json");
    const currentTaskTodos = join(taskTodoDir, `${currentSessionScope}.json`);
    const terminalOtherSessionTodos = join(sessionTodoDir, "other-session.json");
    const staleDisplayNumbers = join(displayNumberDir, "other-session.json");
    const protectedArtifact = join(artifactsDir, "keep.txt");

    await writeFile(missingThreadFile, JSON.stringify({ threadRef: "thread:missing" }), "utf8");
    await writeFile(emptyOtherTaskTodos, JSON.stringify({ version: 1, todos: [] }), "utf8");
    await writeFile(currentTaskTodos, JSON.stringify({ version: 1, todos: [] }), "utf8");
    await writeFile(
      terminalOtherSessionTodos,
      JSON.stringify({ version: 1, todos: [{ content: "done", status: "done" }] }),
      "utf8",
    );
    await writeFile(staleDisplayNumbers, JSON.stringify({ version: 1, entries: [] }), "utf8");
    await writeFile(protectedArtifact, "keep", "utf8");
    await utimes(terminalOtherSessionTodos, oldDate, oldDate);
    await utimes(staleDisplayNumbers, oldDate, oldDate);

    const dryRun = await executeSparkTool(tools, "spark_state", ctx, {
      action: "cleanup",
      olderThanDays: 30,
    });
    const dryRunText = toolText(dryRun);
    assert.match(dryRunText, /Spark state cleanup dry-run: would delete 4 safe cache file\(s\)/);
    assert.match(dryRunText, /old-owner\.json/);
    assert.match(dryRunText, /other-session\.json/);
    assert.equal(existsSync(missingThreadFile), true);
    assert.equal(existsSync(emptyOtherTaskTodos), true);
    assert.equal(existsSync(terminalOtherSessionTodos), true);
    assert.equal(existsSync(staleDisplayNumbers), true);

    const apply = await executeSparkTool(tools, "spark_state", ctx, {
      action: "cleanup",
      dryRun: false,
      olderThanDays: 30,
    });
    assert.match(toolText(apply), /Spark state cleanup apply: deleted 4 safe cache file\(s\)/);
    assert.equal(existsSync(missingThreadFile), false);
    assert.equal(existsSync(emptyOtherTaskTodos), false);
    assert.equal(existsSync(terminalOtherSessionTodos), false);
    assert.equal(existsSync(staleDisplayNumbers), false);
    assert.equal(existsSync(currentTaskTodos), true);
    assert.equal(existsSync(join(dir, ".spark", "thread.json")), true);
    assert.equal(existsSync(protectedArtifact), true);

    const status = await executeSparkTool(tools, "spark_state", ctx, { action: "status" });
    assert.match(toolText(status), /Spark state status:/);
    assert.match(toolText(status), /Protected stores:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state diagnostics reports protected-store candidates without deleting files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-diagnostics-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const terminalThread = graph.createThread({
      title: "Completed diagnostics thread",
      description: "Thread with no unfinished work.",
      status: "done",
    });
    const activeThread = graph.createThread({
      title: "Active diagnostics thread",
      description: "Thread with unfinished work.",
    });
    graph.createTask({
      threadRef: activeThread.ref,
      title: "Active task",
      description: "Keep this thread out of terminal diagnostics.",
      status: "ready",
    });
    await defaultTaskGraphStore(dir).save(graph);

    const now = new Date().toISOString();
    await defaultSparkDagRunStore(dir).save({
      version: 1,
      manager: { status: "idle", updatedAt: now },
      runs: [
        {
          ref: "run:inactive-diagnostics",
          threadRef: terminalThread.ref,
          dryRun: true,
          maxConcurrency: 1,
          timeoutMs: 1_000,
          status: "succeeded",
          startedAt: now,
          updatedAt: now,
          finishedAt: now,
          scheduled: 1,
          completed: 1,
          timedOut: false,
          scheduledTaskRefs: [],
          completedTaskRefs: [],
          taskRunRefs: [],
          completionDigest: [],
        },
      ],
    });

    const artifact = await defaultArtifactStore(dir).put({
      kind: "role-run",
      title: "Large diagnostics artifact",
      format: "text",
      body: "x".repeat(70 * 1024),
      provenance: { producer: "spark", threadRef: terminalThread.ref },
    });
    const orphanBlob = join(dir, ".spark", "artifacts", "blobs", "orphan-diagnostics.txt");
    const noteFile = join(dir, ".spark", "notes", "diagnostics-note.md");
    const roleReportFile = join(dir, ".spark", "role-reports", "diagnostics-report.md");
    await mkdir(join(dir, ".spark", "artifacts", "blobs"), { recursive: true });
    await mkdir(join(dir, ".spark", "notes"), { recursive: true });
    await mkdir(join(dir, ".spark", "role-reports"), { recursive: true });
    await writeFile(orphanBlob, "orphan", "utf8");
    await writeFile(noteFile, "note", "utf8");
    await writeFile(roleReportFile, "role report", "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const diagnostics = await executeSparkTool(tools, "spark_state", ctx, {
      action: "diagnostics",
    });
    const text = toolText(diagnostics);
    assert.match(text, /Spark state diagnostics \(read-only\):/);
    assert.match(text, /Terminal\/no-unfinished threads: 1/);
    assert.match(text, /Completed diagnostics thread/);
    assert.doesNotMatch(text, /Active diagnostics thread/);
    assert.match(text, /Inactive DAG runs: 1/);
    assert.match(text, /run:inactive-diagnostics/);
    assert.match(text, /Large artifacts: 1/);
    assert.match(text, new RegExp(artifact.ref));
    assert.match(text, /Orphan artifact blobs: 1/);
    assert.match(text, /orphan-diagnostics\.txt/);
    assert.match(text, /notes: 1/);
    assert.match(text, /diagnostics-note\.md/);
    assert.match(text, /role reports: 1/);
    assert.match(text, /diagnostics-report\.md/);
    assert.doesNotMatch(text, /x{100}/);

    const details = diagnostics.details as {
      diagnostics?: {
        largeArtifacts: { candidates: Array<Record<string, unknown>> };
        orphanBlobs: { candidates: Array<Record<string, unknown>> };
        terminalThreads: { candidates: Array<Record<string, unknown>> };
      };
    };
    assert.equal(details.diagnostics?.largeArtifacts.candidates[0]?.ref, artifact.ref);
    assert.equal("body" in (details.diagnostics?.largeArtifacts.candidates[0] ?? {}), false);
    assert.equal(
      details.diagnostics?.orphanBlobs.candidates[0]?.path,
      ".spark/artifacts/blobs/orphan-diagnostics.txt",
    );
    assert.equal(details.diagnostics?.terminalThreads.candidates[0]?.ref, terminalThread.ref);

    assert.equal(existsSync(join(dir, ".spark", "thread.json")), true);
    assert.equal(existsSync(defaultArtifactStore(dir).pathFor(artifact.ref)), true);
    assert.equal(existsSync(orphanBlob), true);
    assert.equal(existsSync(noteFile), true);
    assert.equal(existsSync(roleReportFile), true);
    assert.equal(existsSync(join(dir, ".spark", "dag-runs.json")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state compact-role-run-artifacts dry-run lists large role-run candidates and keeps non-role artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-dry-run-"));
  try {
    await writeEmptySparkThread(dir);
    const store = defaultArtifactStore(dir);
    const roleRun = await store.put({
      kind: "role-run",
      title: "Large historical role run",
      format: "json",
      body: largeLegacyRoleRunBody("run:large-retention-dry-run", "worker-large-dry-run", 8 * 1024),
      provenance: {
        producer: "task",
        threadRef: "thread:retention-dry-run" as ThreadRef,
        taskRef: "task:retention-dry-run" as TaskRef,
        roleRef: "role:builtin-worker" as RoleRef,
      },
    });
    const research = await store.put({
      kind: "research",
      title: "Large research artifact",
      format: "text",
      body: "research\n".repeat(2 * 1024),
      provenance: { producer: "spark" },
    });
    const roleRunMetadata = JSON.parse(await readFile(store.pathFor(roleRun.ref), "utf8")) as {
      blobPath: string;
    };
    const researchMetadata = JSON.parse(await readFile(store.pathFor(research.ref), "utf8")) as {
      blobPath: string;
    };
    const roleRunBlob = join(dir, ".spark", "artifacts", roleRunMetadata.blobPath);
    const researchBlob = join(dir, ".spark", "artifacts", researchMetadata.blobPath);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "spark_state", ctx, {
      action: "compact-role-run-artifacts",
      thresholdBytes: 1024,
      tailBytes: 80,
    });

    const text = toolText(result);
    assert.match(text, /Spark role-run artifact retention dry-run/);
    assert.match(text, new RegExp(roleRun.ref));
    assert.doesNotMatch(text, new RegExp(research.ref));
    assert.match(text, /non-role-run=1/);
    assert.equal(existsSync(roleRunBlob), true);
    assert.equal(existsSync(researchBlob), true);

    const details = result.details as {
      retention?: {
        dryRun: boolean;
        candidates: Array<{
          ref: string;
          taskRef?: string;
          runRef?: string;
          candidateReason: string;
          replacementSummary: string;
          transcriptTail?: { tail: string; tailBytes: number };
        }>;
        skipped: Array<{ ref?: string; reason: string }>;
        deleted: unknown[];
      };
    };
    assert.equal(details.retention?.dryRun, true);
    assert.equal(details.retention?.deleted.length, 0);
    assert.equal(details.retention?.candidates.length, 1);
    assert.equal(details.retention?.candidates[0]?.ref, roleRun.ref);
    assert.equal(
      details.retention?.candidates[0]?.candidateReason,
      "large_role-run_transcript_blob",
    );
    assert.equal(details.retention?.candidates[0]?.taskRef, "task:retention-dry-run");
    assert.equal(details.retention?.candidates[0]?.runRef, "run:large-retention-dry-run");
    assert.match(details.retention?.candidates[0]?.replacementSummary ?? "", /compacted from/);
    assert.match(details.retention?.candidates[0]?.transcriptTail?.tail ?? "", /tail-marker/);
    assert.equal(
      details.retention?.skipped.some(
        (entry) => entry.ref === research.ref && entry.reason === "not_role_run_artifact",
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state compact-role-run-artifacts apply writes replacement summary before deleting blob", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-apply-"));
  try {
    await writeEmptySparkThread(dir);
    const store = defaultArtifactStore(dir);
    const roleRun = await store.put({
      kind: "role-run",
      title: "Large historical role run apply",
      format: "json",
      body: largeLegacyRoleRunBody("run:large-retention-apply", "worker-large-apply", 8 * 1024),
      provenance: {
        producer: "task",
        threadRef: "thread:retention-apply" as ThreadRef,
        taskRef: "task:retention-apply" as TaskRef,
        roleRef: "role:builtin-worker" as RoleRef,
      },
    });
    const before = JSON.parse(await readFile(store.pathFor(roleRun.ref), "utf8")) as {
      blobPath: string;
    };
    const blob = join(dir, ".spark", "artifacts", before.blobPath);
    assert.equal(existsSync(blob), true);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const applied = await executeSparkTool(tools, "spark_state", ctx, {
      action: "compact-role-run-artifacts",
      dryRun: false,
      thresholdBytes: 1024,
      tailBytes: 80,
      exportDir: "exports/role-run-transcripts",
    });
    assert.match(toolText(applied), /Apply complete/);
    assert.equal(existsSync(blob), false);

    const after = JSON.parse(await readFile(store.pathFor(roleRun.ref), "utf8")) as {
      body: { summary: string; stdout: { tail: string } };
      bodyTruncated?: boolean;
      blobPath?: string;
      transcriptRetention?: {
        originalBlobPath?: string;
        replacementSummary?: string;
        exportPath?: string;
        fullTranscriptDeletedAt?: string;
      };
    };
    assert.equal(after.bodyTruncated, false);
    assert.equal(after.blobPath, undefined);
    assert.match(after.body.summary, /worker-large-apply/);
    assert.match(after.body.stdout.tail, /tail-marker/);
    assert.equal(after.transcriptRetention?.originalBlobPath, before.blobPath);
    assert.match(after.transcriptRetention?.replacementSummary ?? "", /compacted from/);
    assert.ok(after.transcriptRetention?.fullTranscriptDeletedAt);
    assert.ok(after.transcriptRetention?.exportPath);
    assert.equal(existsSync(join(dir, after.transcriptRetention.exportPath)), true);

    const fetched = await executeSparkTool(tools, "spark_get_artifact", ctx, {
      artifactRef: roleRun.ref,
    });
    assert.match(toolText(fetched), /Historical role-run transcript worker-large-apply/);
    assert.match(toolText(fetched), /transcriptRetention/);
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
    await useOnlySparkThreadInExplicitPlanMode(tools, ctx);

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

async function tryConsumeSparkModeContext(
  run: ReturnType<typeof registerSparkToolsForTest>,
  ctx: TestSparkContext,
): Promise<string | undefined> {
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
  return undefined;
}

async function consumeSparkModeContext(
  run: ReturnType<typeof registerSparkToolsForTest>,
  ctx: TestSparkContext,
): Promise<string> {
  return (
    (await tryConsumeSparkModeContext(run, ctx)) ?? assert.fail("missing hidden Spark mode context")
  );
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

async function useOnlySparkThreadInExplicitPlanMode(
  tools: Map<string, SparkToolConfig>,
  ctx: TestSparkContext,
): Promise<void> {
  await useOnlySparkThread(tools, ctx);
  const statePath = join(ctx.cwd, ".spark", "current-thread", `${ctxSessionStoreScope(ctx)}.json`);
  const state = JSON.parse(await readFile(statePath, "utf8")) as { threadRef?: string };
  assert.ok(state.threadRef);
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        threadRef: state.threadRef,
        planningMode: {
          version: 1,
          threadRef: state.threadRef,
          source: "direct",
          enteredAt: new Date().toISOString(),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
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

function largeLegacyRoleRunBody(runRef: RunRef, runName: string, paddingBytes: number) {
  return {
    record: {
      ref: runRef,
      roleRef: "role:builtin-worker",
      runName,
      instruction: "legacy instruction that should not be preserved in replacement metadata",
      status: "succeeded",
      startedAt: "2026-05-28T00:00:00.000Z",
      finishedAt: "2026-05-28T00:00:01.000Z",
    },
    stdout: `${"x".repeat(paddingBytes)}\ntail-marker ${runName}\n`,
    stderr: "",
    jsonEvents: [],
  };
}
