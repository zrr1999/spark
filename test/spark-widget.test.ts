import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { visibleWidth } from "@zendev-lab/spark-tui/text";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";

import {
  renderSparkWidgetLines,
  SparkWidget,
  type SparkWidgetState,
  type SparkWidgetTheme,
  type SparkWidgetTui,
} from "../packages/spark-host/src/spark-widget.ts";
import { SparkWidgetController } from "../packages/pi-extension/src/extension/spark-widget-controller.ts";
import { defaultSparkDynamicWorkflowEventStore } from "../packages/spark-workflows/src/index.ts";
import {
  createSparkSessionRepro,
  writeSessionRepro,
} from "../packages/pi-extension/src/extension/spark-session-repro.ts";
import {
  loadSessionLoop,
  scheduleSessionLoopTick,
  setSessionGoal,
  setSessionLoop,
} from "../packages/spark-loop/src/index.ts";
import { saveCurrentProjectRef } from "../packages/pi-extension/src/extension/session-state.ts";

const theme: SparkWidgetTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

const tui: SparkWidgetTui = {
  terminal: { columns: 120 },
  requestRender() {},
};

type SparkWidgetRegistration = {
  key: string;
  cb:
    | ((tui: SparkWidgetTui, theme: SparkWidgetTheme) => { render(): string[]; invalidate(): void })
    | undefined;
};

function widgetState(patch: Partial<SparkWidgetState> = {}): SparkWidgetState {
  return {
    projectTitle: "Spark UX redesign",
    tasks: [],
    independentTodos: [],
    taskCountTotal: 0,
    taskCountClaimed: 0,
    taskCountClaimedBySession: 0,
    outputLanguage: "en",
    ...patch,
  };
}

function assertLineIncludes(line: string | undefined, fragments: string[]): void {
  assert.ok(line, "expected rendered line to exist");
  for (const fragment of fragments) {
    assert.ok(line.includes(fragment), line);
  }
}

void test("SparkWidget registers, invalidates renders, clears hidden state, and disposes", () => {
  let state = widgetState({
    projects: [
      {
        title: "Initial non-empty project",
        totalTasks: 1,
        doneTasks: 0,
        readyTasks: 0,
      },
    ],
  });
  const registrations: SparkWidgetRegistration[] = [];
  let renderRequests = 0;
  const widgetTui: SparkWidgetTui = {
    terminal: { columns: 120 },
    requestRender() {
      renderRequests += 1;
    },
  };
  const widget = new SparkWidget(
    () => state,
    (key, cb) => registrations.push({ key, cb }),
  );

  widget.update();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.key, "spark-status");
  assert.equal(typeof registrations[0]?.cb, "function");

  const component = registrations[0]?.cb?.(widgetTui, theme);
  assert.ok(component);
  assert.match(component.render().join("\n"), /Initial non-empty project/);
  component.invalidate();
  assert.match(component.render().join("\n"), /Initial non-empty project/);

  state = widgetState({
    tasks: [
      {
        title: "Refresh task row",
        status: "running",
        claim: "mine",
        agentLabel: "me",
        todos: [],
      },
    ],
  });
  widget.update();
  assert.equal(registrations.length, 1);
  assert.equal(renderRequests, 1);
  assert.match(component.render().join("\n"), /→ @me Refresh task row/);

  state = widgetState({ projectTitle: undefined });
  widget.update();
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations[1], { key: "spark-status", cb: undefined });
  assert.deepEqual(component.render(), []);

  state = widgetState({
    projectTitle: undefined,
    independentTodos: [{ content: "Finished hidden TODO", status: "done" }],
  });
  widget.update();
  assert.equal(registrations.length, 2);

  state = widgetState({
    projectTitle: undefined,
    independentTodos: [{ content: "Legacy hidden item", status: "pending" }],
  });
  widget.update();
  assert.equal(registrations.length, 2);

  widget.dispose();
  assert.equal(registrations.length, 2);

  widget.dispose();
  assert.equal(registrations.length, 2);
});

void test("spark widget hides deleted task plan items but keeps done task plan items visible", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      tasks: [
        {
          title: "Task-centric row",
          status: "running",
          claim: "mine",
          agentLabel: "me",
          todos: [
            { displayNumber: 2, content: "Completed child TODO", status: "done" },
            { displayNumber: 3, content: "Deleted child TODO", status: "deleted" },
          ],
        },
      ],
      taskCountTotal: 1,
      taskCountClaimed: 1,
      taskCountClaimedBySession: 1,
    }),
    tui,
    theme,
  ).join("\n");

  assert.match(lines, /Completed child TODO/);
  assert.doesNotMatch(lines, /Deleted child TODO/);
});

void test("spark widget shows compact workflow-run progress above project details", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      workflowRun: {
        status: "running",
        runRef: "run:abc",
        scheduled: 3,
        completed: 1,
        active: true,
      },
      taskCountTotal: 2,
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assertLineIncludes(lines[0], ["Spark UX redesign", "Phase: research"]);
  assert.ok(!lines[0]?.includes("Tasks("), lines[0]);
  assert.ok(!lines[0]?.includes("total="), lines[0]);
  assert.ok(!lines[0]?.includes("claimed="), lines[0]);
  assertLineIncludes(lines[1], ["Background work:", "1/3", "running", "run:abc"]);
});

void test("spark widget keeps goal/project summary free of static evidence review hints", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      goal: { status: "active", objective: "replace pi from zellij" },
      projects: [
        {
          title: "Spark daemon-first session UX and Pi/Codex parity hardening",
          totalTasks: 16,
          doneTasks: 14,
          readyTasks: 2,
          active: true,
        },
      ],
      tasks: [
        {
          title: "Expose task/goal/evidence advantage",
          status: "pending",
          todos: [],
        },
      ],
      taskCountTotal: 16,
    }),
    { terminal: { columns: 180 }, requestRender() {} },
    theme,
  );
  const rendered = lines.join("\n");
  assert.match(rendered, /Goal\(/u);
  assert.match(rendered, /tasks 14\/16 · ready 2/u);
  assert.doesNotMatch(rendered, /Evidence\/review/u);
  const summaryLineCount = lines.filter((line) =>
    /Goal\(|Spark daemon-first|Expose task\/goal\/evidence/.test(line),
  ).length;
  assert.ok(summaryLineCount <= 5, `summaryLineCount=${summaryLineCount}\n${rendered}`);
});

void test("spark widget shows active dynamic workflow snapshot progress", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      dynamicWorkflowRun: {
        status: "running",
        runRef: "run:abcdef12-live",
        name: "live bridge",
        completedNodes: 1,
        totalNodes: 3,
        active: true,
      },
      taskCountTotal: 2,
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assertLineIncludes(lines[0], ["Spark UX redesign", "Phase: research"]);
  assert.ok(!lines[0]?.includes("Tasks("), lines[0]);
  assert.ok(!lines[0]?.includes("total="), lines[0]);
  assertLineIncludes(lines[1], [
    "Dynamic workflow:",
    "live bridge",
    "running",
    "1/3 nodes",
    "run:abcdef12",
  ]);
});

void test("spark widget shows undelivered dynamic workflow result inbox entry", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      dynamicWorkflowRun: {
        status: "succeeded",
        runRef: "run:12345678-result",
        name: "result bridge",
        completedNodes: 3,
        totalNodes: 3,
        delivery: "result",
      },
      taskCountTotal: 1,
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assertLineIncludes(lines[1], [
    "Dynamic workflow result:",
    "result bridge",
    "succeeded",
    "3/3 nodes",
    "run:12345678",
  ]);
});

void test("spark widget suppresses duplicate background row when session agent is shown", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      workflowRun: {
        status: "running",
        runRef: "run:abc",
        scheduled: 1,
        completed: 0,
        active: true,
      },
      tasks: [
        {
          title: "Running worker task",
          status: "running",
          claim: "role-run",
          agentLabel: "worker",
          backgroundOwner: "session",
          todos: [],
        },
      ],
      taskCountTotal: 1,
      taskCountClaimed: 1,
      taskCountClaimedBySession: 1,
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.match(lines.join("\n"), /◆ Spark UX redesign · Phase: research/);
  assert.doesNotMatch(lines.join("\n"), /Tasks\(/);
  assert.doesNotMatch(lines.join("\n"), /Background work/);
});

void test("spark widget hides terminal workflow-run history", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      workflowRun: {
        status: "failed",
        runRef: "run:9fb95fb0-f08c-41a5-b4a3-bd4e4622034b",
        scheduled: 13,
        completed: 13,
      },
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.deepEqual(lines, []);
});

void test("spark widget requires an active running workflow-run for background progress", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      workflowRun: {
        status: "running",
        runRef: "run:9fb95fb0-f08c-41a5-b4a3-bd4e4622034b",
        scheduled: 13,
        completed: 7,
      },
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.deepEqual(lines, []);
});

void test("spark widget shows session goal before project task state", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      goal: {
        status: "active",
        objective: "Advance Spark mode-as-state UX rework to completion.",
      },
      tasks: [
        {
          title: "Ready goal task",
          status: "pending",
          todos: [],
        },
      ],
      taskCountTotal: 1,
    }),
    tui,
    theme,
  );

  assert.match(lines[0] ?? "", /◆ Goal\(●\): Advance Spark mode-as-state UX rework/);
  assert.match(lines[1] ?? "", /◆ Spark UX redesign · Phase: research/);
  assert.doesNotMatch(lines[1] ?? "", /Tasks\(/);
  assert.doesNotMatch(lines[1] ?? "", /Goal\(●\):/);
});

void test("spark widget pulses active session goal symbol", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      goal: {
        status: "active",
        objective: "Keep working toward the session goal.",
      },
      animationFrame: 2,
    }),
    tui,
    theme,
  );

  assert.match(lines[0] ?? "", /◆ Goal\(◉\): Keep working toward the session goal/);
});

void test("spark widget shows session goal label when no project target", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      goal: {
        status: "active",
        objective: "Finish the selected project goal.",
      },
    }),
    tui,
    theme,
  );

  assert.match(lines[0] ?? "", /◆ Goal\(●\): Finish the selected project goal/);
});

void test("spark widget renders active loop progress in the foreground slot", () => {
  const active = renderSparkWidgetLines(
    widgetState({
      loop: {
        status: "active",
        objective: "Continue loop progress.",
      },
    }),
    tui,
    theme,
  );
  assert.match(active[0] ?? "", /◆ Loop\(●\): Continue loop progress/);

  const scheduled = renderSparkWidgetLines(
    widgetState({
      loop: {
        status: "active",
        objective: "Echo periodically.",
        schedule: {
          label: "30m",
          scheduledAtMs: 0,
          nextRunAtMs: 1,
        },
      },
    }),
    tui,
    theme,
  );
  assert.match(scheduled[0] ?? "", /◆ Loop\(▰▰▰▰▰ 30m\): Echo periodically/);
});

void test("spark widget renders active repro drive in the foreground slot above goal and loop", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      repro: {
        status: "active",
        stageName: "reproduce",
        stageIndex: 2,
        totalStages: 5,
        phase: "implement",
        acceptance: [
          { description: "20+ step BITWISE_PASS reproduction achieved", satisfied: true },
          { description: "100-step BITWISE_PASS verified", satisfied: false },
        ],
        gate: { id: "gate-A", passed: false },
      },
      goal: { status: "active", objective: "Should be hidden while repro is active" },
      loop: { status: "active", objective: "Should also be hidden" },
    }),
    tui,
    theme,
  );
  assertLineIncludes(lines[0], [
    "◆ Repro(",
    "reproduce 3/5",
    "100-step BITWISE_PASS verified",
    "gate:○",
  ]);
  assert.doesNotMatch(lines.join("\n"), /Should be hidden while repro is active/);
  assert.doesNotMatch(lines.join("\n"), /Should also be hidden/);
});

void test("spark widget controller lets active loop use the foreground slot instead of a completed goal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-widget-loop-completed-goal-"));
  try {
    await setSessionGoal(dir, undefined, {
      objective: "Completed old goal",
      source: "explicit",
      status: "complete",
    });
    const loop = await setSessionLoop(dir, undefined, {
      objective: "Active loop should be visible",
      source: "explicit",
      status: "active",
    });
    await scheduleSessionLoopTick(dir, undefined, {
      delayMs: 1_800_000,
      reason: "show widget cadence",
      expectedLoopId: loop.loopId,
    });
    let component: ReturnType<NonNullable<SparkWidgetRegistration["cb"]>> | undefined;
    const controller = new SparkWidgetController();
    await controller.refresh(dir, {
      ui: {
        setWidget(_key: string, cb: SparkWidgetRegistration["cb"] | undefined) {
          component = cb?.(tui, theme);
        },
      },
    });

    const lines = component?.render() ?? [];
    assert.match(lines[0] ?? "", /◆ Loop\(▱▱▱▱▱ 30m\): Active loop should be visible/);
    assert.doesNotMatch(lines.join("\n"), /Completed old goal/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark widget controller clears legacy paused loop state instead of rendering it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-widget-loop-legacy-paused-"));
  try {
    await setSessionLoop(dir, undefined, {
      objective: "Legacy paused loop should be cleared",
      source: "explicit",
      status: "paused",
    });
    let component: ReturnType<NonNullable<SparkWidgetRegistration["cb"]>> | undefined;
    const controller = new SparkWidgetController();
    await controller.refresh(dir, {
      ui: {
        setWidget(_key: string, cb: SparkWidgetRegistration["cb"] | undefined) {
          component = cb?.(tui, theme);
        },
      },
    });

    const lines = component?.render() ?? [];
    assert.doesNotMatch(lines.join("\n"), /Loop\(⏸\)|Legacy paused loop/);
    assert.equal(await loadSessionLoop(dir, undefined), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark widget controller renders an active repro drive above goal and loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-widget-repro-drive-"));
  try {
    await setSessionGoal(dir, undefined, {
      objective: "Goal hidden behind repro",
      source: "explicit",
      status: "active",
    });
    await setSessionLoop(dir, undefined, {
      objective: "Loop hidden behind repro",
      source: "explicit",
      status: "active",
    });
    await writeSessionRepro(dir, createSparkSessionRepro("session:test"), undefined);
    let component: ReturnType<NonNullable<SparkWidgetRegistration["cb"]>> | undefined;
    const controller = new SparkWidgetController();
    await controller.refresh(dir, {
      ui: {
        setWidget(_key: string, cb: SparkWidgetRegistration["cb"] | undefined) {
          component = cb?.(tui, theme);
        },
      },
    });

    const lines = component?.render() ?? [];
    assertLineIncludes(lines[0], ["◆ Repro(", "setup 1/5", "Problem statement documented"]);
    assert.doesNotMatch(lines.join("\n"), /Goal hidden behind repro/);
    assert.doesNotMatch(lines.join("\n"), /Loop hidden behind repro/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark widget controller projects active dynamic workflow snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-widget-dynamic-workflow-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Dynamic workflow widget project",
      description: "Exercise active dynamic workflow widget state.",
      outputLanguage: "en",
    });
    await defaultTaskGraphStore(dir).save(graph);
    await saveCurrentProjectRef(dir, undefined, project.ref);
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const runRef = "run:abcdef12-widget" as const;
    await store.startRun({
      runRef,
      source: { kind: "inline", label: "inline workflow" },
      script:
        "export const meta = { name: 'widget live', description: 'widget live workflow' }\nreturn 'ok'",
      meta: { name: "widget live", description: "widget live workflow" },
      options: {},
      now: "2026-06-23T00:00:00.000Z",
    });
    await store.appendEvent(runRef, {
      type: "stage_started",
      nodeId: "stage:Scan",
      parentId: "run",
      nodeKind: "stage",
      title: "Scan",
      stage: "Scan",
      timestamp: "2026-06-23T00:00:01.000Z",
    });

    let component: ReturnType<NonNullable<SparkWidgetRegistration["cb"]>> | undefined;
    const controller = new SparkWidgetController();
    await controller.refresh(dir, {
      ui: {
        setWidget(_key: string, cb: SparkWidgetRegistration["cb"] | undefined) {
          component = cb?.(tui, theme);
        },
      },
    });

    const text = component?.render().join("\n") ?? "";
    assert.match(text, /Dynamic workflow: widget live · running · 0\/2 nodes · run:abcdef12/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark widget controller projects undelivered dynamic workflow results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-widget-dynamic-workflow-result-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Dynamic workflow result widget project",
      description: "Exercise dynamic workflow result widget state.",
      outputLanguage: "en",
    });
    await defaultTaskGraphStore(dir).save(graph);
    await saveCurrentProjectRef(dir, undefined, project.ref);
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const run = await store.start({
      source: { kind: "inline", label: "inline result workflow" },
      script:
        "export const meta = { name: 'widget result', description: 'widget result workflow' }\nreturn 'ok'",
      meta: { name: "widget result", description: "widget result workflow" },
      options: {},
      now: "2026-06-23T00:00:00.000Z",
    });
    await store.finish(run.ref, {
      meta: { name: "widget result", description: "widget result workflow" },
      result: { report: "ready" },
      stages: [],
      phases: [],
      agentCount: 0,
      journal: [],
    });

    let component: ReturnType<NonNullable<SparkWidgetRegistration["cb"]>> | undefined;
    const controller = new SparkWidgetController();
    await controller.refresh(dir, {
      ui: {
        setWidget(_key: string, cb: SparkWidgetRegistration["cb"] | undefined) {
          component = cb?.(tui, theme);
        },
      },
    });

    const text = component?.render().join("\n") ?? "";
    assert.match(
      text,
      new RegExp(
        `Dynamic workflow result: widget result · succeeded · 1/1 nodes · ${run.ref.slice(0, 12)}`,
      ),
    );

    await store.acknowledge(run.ref);
    await controller.refresh(dir, {
      ui: {
        setWidget(_key: string, cb: SparkWidgetRegistration["cb"] | undefined) {
          component = cb?.(tui, theme);
        },
      },
    });
    assert.doesNotMatch(component?.render().join("\n") ?? "", /Dynamic workflow result:/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark widget controller hides unclaimed task plan items before rendering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-widget-claim-gated-controller-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Claim gated widget project",
      description: "Exercise controller-side claim gating.",
      outputLanguage: "en",
    });
    graph.createTask({
      projectRef: project.ref,
      name: "unclaimed-widget-details",
      title: "Unclaimed widget task",
      description: "Plan-item content must not enter widget state before claim.",
      status: "ready",
      todos: [{ content: "Hidden widget plan item", status: "pending" }],
    });
    const claimed = graph.createTask({
      projectRef: project.ref,
      name: "claimed-widget-details",
      title: "Claimed widget task",
      description: "Claimed plan-item content should render.",
      status: "ready",
      todos: [{ content: "Visible widget plan item", status: "pending" }],
    });
    graph.claimTask(claimed.ref, {
      kind: "main",
      claimedBy: "session:ephemeral",
      sessionId: "session:ephemeral",
      leaseMs: 60_000,
    });
    await defaultTaskGraphStore(dir).save(graph);
    await saveCurrentProjectRef(dir, undefined, project.ref);

    let component: ReturnType<NonNullable<SparkWidgetRegistration["cb"]>> | undefined;
    const controller = new SparkWidgetController();
    await controller.refresh(dir, {
      ui: {
        setWidget(_key: string, cb: SparkWidgetRegistration["cb"] | undefined) {
          component = cb?.(tui, theme);
        },
      },
    });

    const text = component?.render().join("\n") ?? "";
    assert.match(text, /Unclaimed widget task/);
    assert.doesNotMatch(text, /Hidden widget plan item/);
    assert.match(text, /Visible widget plan item/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark widget shows project overview rows when no current project is selected", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      projectTitle: undefined,
      projects: [
        {
          title: "Planner project",
          ref: "project:planner",
          totalTasks: 3,
          doneTasks: 1,
          readyTasks: 2,
        },
        {
          title: "Empty project",
          ref: "project:empty",
          totalTasks: 0,
          doneTasks: 0,
          readyTasks: 0,
        },
      ],
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  const text = lines.join("\n");
  assert.match(text, /Planner project · tasks 1\/3 · ready 2/);
  assert.doesNotMatch(text, /Empty project/);
});

void test("spark widget controller registers project overview without a selected current project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-widget-project-overview-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Unselected project",
      description: "Exercise project overview widget state.",
      outputLanguage: "en",
    });
    graph.createTask({
      projectRef: project.ref,
      name: "ready-overview-task",
      title: "Ready overview task",
      description: "Visible through project overview counts.",
      status: "ready",
    });
    await defaultTaskGraphStore(dir).save(graph);

    let component: ReturnType<NonNullable<SparkWidgetRegistration["cb"]>> | undefined;
    const controller = new SparkWidgetController();
    await controller.refresh(dir, {
      ui: {
        setWidget(_key: string, cb: SparkWidgetRegistration["cb"] | undefined) {
          component = cb?.(tui, theme);
        },
      },
    });

    const text = component?.render().join("\n") ?? "";
    assert.match(text, /Unselected project · tasks 0\/1/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark widget hides empty project phase placeholders", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [],
      independentTodos: [],
      taskCountTotal: 0,
      taskCountClaimed: 0,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.deepEqual(lines, []);
});

void test("spark widget only shows missing plan marker on task rows", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      tasks: [
        {
          title: "Refine planned task",
          status: "pending",
          agentLabel: "worker",
          todos: [],
        },
        {
          title: "Refine underspecified task",
          status: "pending",
          agentLabel: "worker",
          planSummary: "missing",
          todos: [],
        },
      ],
    }),
    tui,
    theme,
  ).join("\n");

  assert.match(lines, /Refine planned task/);
  assert.doesNotMatch(lines, /Refine planned task plan:/);
  assert.match(lines, /Refine underspecified task plan:missing/);
  assert.doesNotMatch(lines, /missing-success|missing-evidence/);
});

void test("spark widget hides task plan items until a task is claimed", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Planned but unclaimed task",
          status: "pending",
          agentLabel: "unassigned",
          todos: [{ displayNumber: 4, content: "Hidden pre-claim plan item", status: "pending" }],
        },
        {
          title: "Claimed foreground task",
          status: "running",
          claim: "mine",
          agentLabel: "me",
          todos: [{ displayNumber: 5, content: "Visible claimed plan item", status: "pending" }],
        },
        {
          title: "Claimed background task",
          status: "running",
          claim: "role-run",
          agentLabel: "worker-a1b2c3",
          backgroundOwner: "session",
          todos: [{ displayNumber: 6, content: "Visible role-run plan item", status: "pending" }],
        },
        {
          title: "Other session claimed task",
          status: "running",
          claim: "other",
          agentLabel: "other",
          todos: [
            { displayNumber: 7, content: "Hidden other-session plan item", status: "pending" },
          ],
        },
      ],
      independentTodos: [],
      taskCountTotal: 4,
      taskCountClaimed: 3,
      taskCountClaimedBySession: 1,
      outputLanguage: "en",
    },
    { terminal: { columns: 160 }, requestRender() {} },
    theme,
  ).join("\n");

  assert.match(lines, /Planned but unclaimed task/);
  assert.doesNotMatch(lines, /Hidden pre-claim plan item/);
  assert.match(lines, /Visible claimed plan item/);
  assert.match(lines, /Visible role-run plan item/);
  assert.doesNotMatch(lines, /Hidden other-session plan item/);
});

void test("spark widget shows role/title task rows with nested task plan items", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Redesign task and TODO display",
          status: "running",
          claim: "mine",
          agentLabel: "me",
          todos: [
            { displayNumber: 7, content: "Update widget layout", status: "in_progress" },
            { displayNumber: 12, content: "Update docs", status: "pending" },
          ],
        },
      ],
      independentTodos: [{ displayNumber: 3, content: "Decide project symbol", status: "pending" }],
      taskCountTotal: 3,
      taskCountClaimed: 2,
      taskCountClaimedBySession: 1,
      outputLanguage: "en",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  const text = lines.join("\n");
  assert.match(text, /→ @me Redesign task and TODO display/);
  assert.doesNotMatch(text, /Implementation details are hidden in the widget/);
  assert.match(text, /#7 Update widget layout/);
  assert.match(text, /#12 Update docs/);
  assert.doesNotMatch(text, /Decide project symbol/);
});

void test("spark widget does not expand plan items for finished tasks", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Completed task",
          status: "done",
          agentLabel: "unassigned",
          todos: [{ displayNumber: 1, content: "Finished child TODO", status: "done" }],
        },
        {
          title: "Cancelled task",
          status: "cancelled",
          agentLabel: "unassigned",
          todos: [{ displayNumber: 2, content: "Cancelled child TODO", status: "pending" }],
        },
        {
          title: "Active task",
          status: "running",
          claim: "mine",
          agentLabel: "me",
          todos: [{ displayNumber: 3, content: "Active child TODO", status: "pending" }],
        },
      ],
      independentTodos: [],
      taskCountTotal: 3,
      taskCountClaimed: 1,
      taskCountClaimedBySession: 1,
      outputLanguage: "en",
    },
    { terminal: { columns: 160 }, requestRender() {} },
    theme,
  ).join("\n");

  assert.match(lines, /Completed task/);
  assert.match(lines, /Cancelled task/);
  assert.match(lines, /Active child TODO/);
  assert.doesNotMatch(lines, /Finished child TODO/);
  assert.doesNotMatch(lines, /Cancelled child TODO/);
});

void test("spark widget uses stable TODO display numbers instead of sorted row ordinals", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Stable numbering",
          status: "running",
          claim: "mine",
          agentLabel: "me",
          todos: [
            { displayNumber: 4, content: "Pending item created first", status: "pending" },
            { displayNumber: 9, content: "Active item created later", status: "in_progress" },
          ],
        },
      ],
      independentTodos: [
        { displayNumber: 2, content: "Legacy independent item", status: "pending" },
      ],
      taskCountTotal: 1,
      taskCountClaimed: 1,
      taskCountClaimedBySession: 1,
      outputLanguage: "en",
    },
    { terminal: { columns: 160 }, requestRender() {} },
    theme,
  ).join("\n");

  assert.match(lines, /#9 Active item created later/);
  assert.match(lines, /#4 Pending item created first/);
  assert.doesNotMatch(lines, /Legacy independent item/);
  assert.ok(lines.indexOf("#9 Active") < lines.indexOf("#4 Pending"));
});

void test("spark widget animates only current-session role-runs and keeps others static", () => {
  const animated = renderSparkWidgetLines(
    widgetState({
      tasks: [
        {
          title: "Animated work",
          status: "running",
          claim: "role-run",
          agentLabel: "worker",
          backgroundOwner: "session",
          animationFrame: 7,
          todos: [],
        },
      ],
      taskCountTotal: 1,
      taskCountClaimed: 1,
    }),
    tui,
    theme,
  ).join("\n");
  const waiting = renderSparkWidgetLines(
    widgetState({
      tasks: [
        {
          title: "Waiting for input",
          status: "running",
          claim: "role-run",
          agentLabel: "worker",
          backgroundOwner: "session",
          animationFrame: 3,
          waitingForInput: true,
          todos: [],
        },
      ],
      taskCountTotal: 1,
      taskCountClaimed: 1,
    }),
    tui,
    theme,
  ).join("\n");
  const otherSession = renderSparkWidgetLines(
    widgetState({
      tasks: [
        {
          title: "Other session task",
          status: "running",
          claim: "other",
          agentLabel: "reviewer",
          animationFrame: 7,
          todos: [],
        },
      ],
      taskCountTotal: 1,
      taskCountClaimed: 1,
      taskCountClaimedBySession: 0,
    }),
    tui,
    theme,
  ).join("\n");

  assert.match(animated, /⠼ @me\/worker Animated work/);
  assert.match(waiting, /◼ @me\/worker Waiting for input/);
  assert.match(otherSession, /◼ @reviewer Other session task/);
});

void test("spark widget distinguishes cancelled, failed, and role labels", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Cancelled review task",
          status: "cancelled",
          agentLabel: "unassigned",
          todos: [],
        },
        {
          title: "Broken task",
          status: "failed",
          agentLabel: "unassigned",
          todos: [],
        },
        {
          title: "Role task",
          status: "running",
          claim: "role-run",
          agentLabel: "worker-a1b2c3d4",
          backgroundOwner: "session",
          todos: [],
        },
        {
          title: "Other session task",
          status: "running",
          claim: "other",
          agentLabel: "reviewer",
          todos: [],
        },
      ],
      independentTodos: [],
      taskCountTotal: 4,
      taskCountClaimed: 3,
      taskCountClaimedBySession: 1,
      outputLanguage: "en",
    },
    { terminal: { columns: 160 }, requestRender() {} },
    theme,
  ).join("\n");

  assert.match(lines, /⊘ Cancelled review task/);
  assert.match(lines, /✗ Broken task/);
  assert.match(lines, /⠧ @me\/worker Role task/);
  assert.doesNotMatch(lines, /worker-a1b2c3d4/);
  assert.match(lines, /◼ @reviewer Other session task/);
});

void test("spark widget keeps role labels before truncatable task titles", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        {
          title:
            "This is a deliberately long task title that should be truncated after the role identity remains visible",
          status: "running",
          claim: "role-run",
          agentLabel: "worker-a1b2c3d4",
          backgroundOwner: "session",
          todos: [],
        },
      ],
      independentTodos: [],
      taskCountTotal: 1,
      taskCountClaimed: 1,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 48 }, requestRender() {} },
    theme,
  ).join("\n");

  assert.match(lines, /@me\/worker This is a deliberately/);
  assert.doesNotMatch(lines, /worker-a1b2c3d4/);
});

void test("spark widget summarizes tasks and current-session in-memory running role-runs in header", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Harden ask gates",
          status: "running",
          claim: "role-run",
          agentLabel: "worker-a1b2c3d4",
          backgroundOwner: "session",
          todos: [],
        },
        {
          title: "Update docs",
          status: "running",
          claim: "role-run",
          agentLabel: "worker-0c5a1efe",
          backgroundOwner: "session",
          todos: [],
        },
        {
          title: "Review dirty changes",
          status: "running",
          claim: "role-run",
          agentLabel: "reviewer-2dd9591d",
          backgroundOwner: "session",
          todos: [],
        },
        {
          title: "Other session worker",
          status: "running",
          claim: "role-run",
          agentLabel: "reviewer",
          todos: [],
        },
        {
          title: "Persisted but not in-memory running",
          status: "running",
          claim: "role-run",
          agentLabel: "stale-worker",
          todos: [],
        },
        { title: "Pending task", status: "pending", agentLabel: "unassigned", todos: [] },
        { title: "Failed task", status: "failed", agentLabel: "worker-failed", todos: [] },
      ],
      independentTodos: [],
      taskCountTotal: 7,
      taskCountClaimed: 4,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  ).join("\n");

  const header = lines.split("\n")[0] ?? "";
  assert.match(header, /◆ Spark UX redesign · Phase: research/);
  assert.doesNotMatch(header, /Tasks\(|a1b2c3d4|0c5a1efe|2dd9591d|stale-worker/);
});

void test("spark widget renders phase on the project header", () => {
  const planLines = renderSparkWidgetLines(
    widgetState({
      activeLens: { phase: "plan", drive: "assist" },
      tasks: [{ title: "Planned task", status: "pending", todos: [] }],
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );
  assert.match(planLines[0] ?? "", /^◆ Spark UX redesign · Phase: plan/);

  const researchLines = renderSparkWidgetLines(
    widgetState({
      activeLens: { phase: "research", drive: "assist" },
      tasks: [{ title: "Research task", status: "pending", todos: [] }],
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );
  assert.match(researchLines[0] ?? "", /^◆ Spark UX redesign · Phase: research/);
  assert.doesNotMatch(researchLines[0] ?? "", /Lens:/);
});

void test("spark widget renders declarative project kind panels", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      projectKind: {
        kind: "demo",
        title: "Demo",
        badge: "demo",
        panels: [
          { label: "Target", render: "text", text: "CLI smoke" },
          { label: "Metrics", render: "progress", text: "1/2" },
        ],
      },
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.match(lines[0] ?? "", /^◆ Spark UX redesign · Phase: research/);
  assert.match(lines[1] ?? "", /^◇ \[demo\] Target: CLI smoke/);
  assert.match(lines[2] ?? "", /^◇ \[demo\] Metrics: 1\/2/);
});

void test("spark widget keeps task summary out of the project header", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Background task",
          status: "running",
          claim: "role-run",
          agentLabel: "worker-a1b2c3d4",
          backgroundOwner: "session",
          todos: [],
        },
        {
          title: "Foreground task",
          status: "running",
          claim: "mine",
          agentLabel: "me",
          todos: [],
        },
      ],
      independentTodos: [],
      taskCountTotal: 2,
      taskCountClaimed: 2,
      taskCountClaimedBySession: 1,
      outputLanguage: "en",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.match(lines[0] ?? "", /^◆ Spark UX redesign · Phase: research/);
  assert.doesNotMatch(lines[0] ?? "", /Tasks\(/);
  assert.doesNotMatch(lines[0] ?? "", /a1b2c3d4|^├─/);
  assert.ok(
    lines.some((line) => /^├─ ⠧/.test(line)),
    lines.join("\n"),
  );
});

void test("spark widget hides placeholder-only done plan item state", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: undefined,
      tasks: [],
      independentTodos: [{ content: "Old coordination TODO", status: "done" }],
      taskCountTotal: 9,
      taskCountClaimed: 0,
      taskCountClaimedBySession: 0,
      outputLanguage: "zh",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.deepEqual(lines, []);
});

void test("spark widget hides legacy independent items and renders project tasks", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        { title: "Cancelled task", status: "cancelled", agentLabel: "unassigned", todos: [] },
        { title: "Done task", status: "done", agentLabel: "unassigned", todos: [] },
        { title: "Pending task", status: "pending", agentLabel: "unassigned", todos: [] },
        { title: "Running task", status: "running", agentLabel: "unassigned", todos: [] },
      ],
      independentTodos: [{ displayNumber: 2, content: "Legacy follow-up", status: "pending" }],
      taskCountTotal: 4,
      taskCountClaimed: 0,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 160 }, requestRender() {} },
    theme,
  );

  const text = lines.join("\n");
  assert.doesNotMatch(text, /Legacy follow-up/);
  assert.ok(text.indexOf("Spark UX redesign") < text.indexOf("Running task"));
  assert.ok(text.indexOf("Running task") < text.indexOf("Pending task"));
  assert.ok(text.indexOf("Pending task") < text.indexOf("Done task"));
  assert.ok(text.indexOf("Done task") < text.indexOf("Cancelled task"));
});

void test("spark widget truncates wide rendered rows", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark ask 中文宽字符宽度回归测试".repeat(4),
      tasks: [
        {
          title: "处理很长的 ask_flow 中文任务标题，避免 widget 行超过终端宽度".repeat(3),
          status: "running",
          claim: "mine",
          agentLabel: "me",
          todos: [
            {
              content: "一个很长的中文 TODO，用来确认 Spark widget 使用 Pi TUI 宽度算法截断".repeat(
                3,
              ),
              status: "in_progress",
            },
          ],
        },
      ],
      independentTodos: [],
      taskCountTotal: 1,
      taskCountClaimed: 1,
      taskCountClaimedBySession: 1,
      outputLanguage: "zh",
    },
    { terminal: { columns: 40 }, requestRender() {} },
    theme,
  );

  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 40, `widget line too wide: ${visibleWidth(line)} > 40`);
  }
});

void test("spark widget collapses overflowing rows", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Redesign task and TODO display",
          status: "running",
          claim: "mine",
          agentLabel: "me",
          todos: Array.from({ length: 12 }, (_, index) => ({
            content: `Todo ${index + 1}`,
            status: index === 0 ? "in_progress" : index > 8 ? "done" : "pending",
          })),
        },
      ],
      independentTodos: [],
      taskCountTotal: 1,
      taskCountClaimed: 1,
      taskCountClaimedBySession: 1,
      outputLanguage: "en",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.ok(lines.length <= 13);
  assert.match(lines.join("\n"), /\+\d+ more/);
});
