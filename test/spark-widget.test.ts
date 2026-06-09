import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  renderSparkWidgetLines,
  SparkWidget,
  type SparkWidgetState,
  type SparkWidgetTheme,
  type SparkWidgetTui,
} from "../packages/spark/src/ui/spark-widget.ts";

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

void test("SparkWidget registers, invalidates renders, clears hidden state, and disposes", () => {
  let state = widgetState();
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
  assert.match(component.render().join("\n"), /◆ Spark UX redesign/);
  component.invalidate();
  assert.match(component.render().join("\n"), /◆ Spark UX redesign/);

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
    independentTodos: [{ content: "New visible TODO", status: "pending" }],
  });
  widget.update();
  assert.equal(registrations.length, 3);
  assert.equal(typeof registrations[2]?.cb, "function");
  assert.match(
    registrations[2]?.cb?.(widgetTui, theme).render().join("\n") ?? "",
    /New visible TODO/,
  );

  widget.dispose();
  assert.equal(registrations.length, 4);
  assert.deepEqual(registrations[3], { key: "spark-status", cb: undefined });

  widget.dispose();
  assert.equal(registrations.length, 4);
});

void test("spark widget hides deleted task TODOs but keeps done task TODOs visible", () => {
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

void test("spark widget shows compact DAG progress above project details", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      dag: {
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

  assert.match(
    lines.join("\n"),
    /◆ Spark UX redesign · Tasks\(total=2 claimed=0\/0\)\n◆ Background work: 1\/3 tasks finished · running · run:abc/,
  );
});

void test("spark widget suppresses duplicate background row when session agent is shown", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      dag: {
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

  assert.match(lines.join("\n"), /◆ Spark UX redesign · Tasks\(running=1: agents worker\)/);
  assert.doesNotMatch(lines.join("\n"), /Background work/);
});

void test("spark widget merges run mode state into background progress", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      run: {
        status: "running",
        runRef: "run:6a2e8150-1234-4cde-9abc-000000000000",
        focus: "Finish the queue",
      },
      dag: {
        status: "failed",
        runRef: "run:9fb95fb0-f08c-41a5-b4a3-bd4e4622034b",
        scheduled: 13,
        completed: 13,
      },
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.match(
    lines.join("\n"),
    /◆ Spark UX redesign\n◆ Background work: 13\/13 tasks finished · failed · run:9fb95fb0/,
  );
  assert.doesNotMatch(lines.join("\n"), /Spark DAG|Spark run/);
});

void test("spark widget renders completed DAG state in plain language", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      dag: {
        status: "failed",
        runRef: "run:9fb95fb0-f08c-41a5-b4a3-bd4e4622034b",
        scheduled: 13,
        completed: 13,
      },
    }),
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.match(
    lines.join("\n"),
    /◆ Background work: 13\/13 tasks finished · failed · run:9fb95fb0/,
  );
  assert.doesNotMatch(lines.join("\n"), /DAG\(failed|Spark DAG/);
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
  assert.match(lines[1] ?? "", /◆ Spark UX redesign · Tasks\(pending=1\)/);
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

void test("spark widget shows project-scoped goal label", () => {
  const lines = renderSparkWidgetLines(
    widgetState({
      goal: {
        status: "active",
        scope: "project",
        projectRef: "proj:example",
        objective: "Finish the selected project goal.",
      },
    }),
    tui,
    theme,
  );

  assert.match(lines[0] ?? "", /◆ Goal\(●\): Finish the selected project goal/);
});

void test("spark widget shows project header with task counts even before claims", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [],
      independentTodos: [],
      taskCountTotal: 5,
      taskCountClaimed: 2,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.match(lines.join("\n"), /◆ Spark UX redesign · Tasks\(total=5 claimed=2\/0\)/);
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

void test("spark widget shows role/title task rows with nested TODOs and independent TODO siblings", () => {
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
  assert.match(text, /#3 Decide project symbol/);
});

void test("spark widget does not expand TODOs for finished tasks", () => {
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
      independentTodos: [{ displayNumber: 2, content: "Independent item", status: "pending" }],
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
  assert.match(lines, /#2 Independent item/);
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
  assert.match(
    header,
    /◆ Spark UX redesign · Tasks\(running=5 pending=1 failed=1: agents worker×2, reviewer\)/,
  );
  assert.doesNotMatch(header, /a1b2c3d4|0c5a1efe|2dd9591d|stale-worker/);
});

void test("spark widget renders task summary on the project header", () => {
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

  assert.match(lines[0] ?? "", /^◆ Spark UX redesign · Tasks\(running=2: agents worker\)/);
  assert.doesNotMatch(lines[0] ?? "", /a1b2c3d4|^├─/);
  assert.match(lines[1] ?? "", /^├─ ⠧/);
});

void test("spark widget hides placeholder-only done TODO state", () => {
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

void test("spark widget renders session TODOs as their own top-level section", () => {
  const lines = renderSparkWidgetLines(
    {
      projectTitle: "Spark UX redesign",
      tasks: [
        { title: "Cancelled task", status: "cancelled", agentLabel: "unassigned", todos: [] },
        { title: "Done task", status: "done", agentLabel: "unassigned", todos: [] },
        { title: "Pending task", status: "pending", agentLabel: "unassigned", todos: [] },
        { title: "Running task", status: "running", agentLabel: "unassigned", todos: [] },
      ],
      independentTodos: [{ displayNumber: 2, content: "Session follow-up", status: "pending" }],
      taskCountTotal: 4,
      taskCountClaimed: 0,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 160 }, requestRender() {} },
    theme,
  );

  const text = lines.join("\n");
  assert.ok(text.indexOf("Session TODOs(pending=1)") < text.indexOf("Spark UX redesign"));
  assert.ok(text.indexOf("Session follow-up") < text.indexOf("Spark UX redesign"));
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
