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
    threadTitle: "Spark UX redesign",
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
        roleLabel: "me",
        todos: [],
      },
    ],
  });
  widget.update();
  assert.equal(registrations.length, 1);
  assert.equal(renderRequests, 1);
  assert.match(component.render().join("\n"), /→ @me Refresh task row/);

  state = widgetState({ threadTitle: undefined });
  widget.update();
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations[1], { key: "spark-status", cb: undefined });
  assert.deepEqual(component.render(), []);

  state = widgetState({
    threadTitle: undefined,
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
          roleLabel: "me",
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

void test("spark widget shows thread header with task counts even before claims", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
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

  assert.match(lines.join("\n"), /◆ Tasks\(total=5 claimed=2\/0\)\n◆ Spark UX redesign/);
});

void test("spark widget shows role/title task rows with nested TODOs and independent TODO siblings", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Redesign task and TODO display",
          status: "running",
          claim: "mine",
          roleLabel: "me",
          todos: [
            { displayNumber: 7, content: "Update widget layout", status: "in_progress" },
            { displayNumber: 12, content: "Update docs", status: "pending" },
          ],
        },
      ],
      independentTodos: [{ displayNumber: 3, content: "Decide thread symbol", status: "pending" }],
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
  assert.match(text, /#3 Decide thread symbol/);
});

void test("spark widget does not expand TODOs for finished tasks", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Completed task",
          status: "done",
          roleLabel: "unassigned",
          todos: [{ displayNumber: 1, content: "Finished child TODO", status: "done" }],
        },
        {
          title: "Cancelled task",
          status: "cancelled",
          roleLabel: "unassigned",
          todos: [{ displayNumber: 2, content: "Cancelled child TODO", status: "pending" }],
        },
        {
          title: "Active task",
          status: "running",
          claim: "mine",
          roleLabel: "me",
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
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Stable numbering",
          status: "running",
          claim: "mine",
          roleLabel: "me",
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
          roleLabel: "worker",
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
          roleLabel: "worker",
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
          roleLabel: "reviewer",
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
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Review initial direction",
          status: "cancelled",
          roleLabel: "unassigned",
          todos: [],
        },
        {
          title: "Broken task",
          status: "failed",
          roleLabel: "unassigned",
          todos: [],
        },
        {
          title: "Role task",
          status: "running",
          claim: "role-run",
          roleLabel: "worker-a1b2c3d4",
          backgroundOwner: "session",
          todos: [],
        },
        {
          title: "Other session task",
          status: "running",
          claim: "other",
          roleLabel: "reviewer",
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

  assert.match(lines, /⊘ Review initial direction/);
  assert.match(lines, /✗ Broken task/);
  assert.match(lines, /⠧ @me\/worker-a1b2c3d4 Role task/);
  assert.match(lines, /◼ @reviewer Other session task/);
});

void test("spark widget keeps role labels before truncatable task titles", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title:
            "This is a deliberately long task title that should be truncated after the role identity remains visible",
          status: "running",
          claim: "role-run",
          roleLabel: "worker-a1b2c3d4",
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

  assert.match(lines, /@me\/worker-a1b2c3d4 This is a delibe/);
});

void test("spark widget summarizes tasks and current-session in-memory running role-runs in header", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Harden ask gates",
          status: "running",
          claim: "role-run",
          roleLabel: "worker-a1b2c3d4",
          backgroundOwner: "session",
          todos: [],
        },
        {
          title: "Other session worker",
          status: "running",
          claim: "role-run",
          roleLabel: "reviewer",
          todos: [],
        },
        {
          title: "Persisted but not in-memory running",
          status: "running",
          claim: "role-run",
          roleLabel: "stale-worker",
          todos: [],
        },
        { title: "Pending task", status: "pending", roleLabel: "unassigned", todos: [] },
        { title: "Failed task", status: "failed", roleLabel: "worker-failed", todos: [] },
      ],
      independentTodos: [],
      taskCountTotal: 5,
      taskCountClaimed: 2,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  ).join("\n");

  const header = lines.split("\n")[0] ?? "";
  assert.match(header, /◆ Tasks\(running=3 pending=1 failed=1: @worker-a1b2c3d4\)/);
  assert.doesNotMatch(header, /reviewer|stale-worker/);
});

void test("spark widget renders task summary on the thread header", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Background task",
          status: "running",
          claim: "role-run",
          roleLabel: "worker-a1b2c3d4",
          backgroundOwner: "session",
          todos: [],
        },
        {
          title: "Foreground task",
          status: "running",
          claim: "mine",
          roleLabel: "me",
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

  assert.match(lines[0] ?? "", /^◆ Tasks\(running=2: @worker-a1b2c3d4\)/);
  assert.doesNotMatch(lines[0] ?? "", /^├─/);
  assert.match(lines[1] ?? "", /^◆ Spark UX redesign/);
  assert.match(lines[2] ?? "", /^├─ ⠧/);
});

void test("spark widget hides placeholder-only done TODO state", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: undefined,
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

void test("spark widget prioritizes unfinished rows before done or cancelled rows", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        { title: "Cancelled task", status: "cancelled", roleLabel: "unassigned", todos: [] },
        { title: "Done task", status: "done", roleLabel: "unassigned", todos: [] },
        { title: "Pending task", status: "pending", roleLabel: "unassigned", todos: [] },
        { title: "Running task", status: "running", roleLabel: "unassigned", todos: [] },
      ],
      independentTodos: [],
      taskCountTotal: 4,
      taskCountClaimed: 0,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 160 }, requestRender() {} },
    theme,
  );

  const text = lines.join("\n");
  assert.ok(text.indexOf("Running task") < text.indexOf("Pending task"));
  assert.ok(text.indexOf("Pending task") < text.indexOf("Done task"));
  assert.ok(text.indexOf("Done task") < text.indexOf("Cancelled task"));
});

void test("spark widget truncates wide rendered rows", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark ask 中文宽字符宽度回归测试".repeat(4),
      tasks: [
        {
          title: "处理很长的 ask_flow 中文任务标题，避免 widget 行超过终端宽度".repeat(3),
          status: "running",
          claim: "mine",
          roleLabel: "me",
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
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Redesign task and TODO display",
          status: "running",
          claim: "mine",
          roleLabel: "me",
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
