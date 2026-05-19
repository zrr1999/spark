import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSparkWidgetLines,
  type SparkWidgetTheme,
} from "../packages/spark/src/ui/spark-widget.ts";

const theme: SparkWidgetTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

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

  assert.match(lines.join("\n"), /◆ Spark UX redesign \(Tasks: 5\/2\/0\)/);
});

void test("spark widget shows agent/title task rows with nested TODOs and independent TODO siblings", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
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
  assert.match(text, /@me Redesign task and TODO display/);
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
      threadTitle: "Spark UX redesign",
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

void test("spark widget distinguishes cancelled, failed, and agent labels", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Review initial direction",
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
          title: "Agent task",
          status: "running",
          claim: "subagent",
          agentLabel: "worker-a1b2c3d4",
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
      taskCountClaimed: 2,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 160 }, requestRender() {} },
    theme,
  ).join("\n");

  assert.match(lines, /⊘ @unassigned Review initial direction/);
  assert.match(lines, /✗ @unassigned Broken task/);
  assert.match(lines, /→ @worker-a1b2c3d4 Agent task/);
  assert.match(lines, /→ @reviewer Other session task/);
});

void test("spark widget keeps agent labels before truncatable task titles", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title:
            "This is a deliberately long task title that should be truncated after the agent identity remains visible",
          status: "running",
          claim: "subagent",
          agentLabel: "worker-a1b2c3d4",
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

  assert.match(lines, /@worker-a1b2c3d4 This is a deliberately/);
});

void test("spark widget summarizes current-session background subagents", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Harden ask gates",
          status: "running",
          claim: "subagent",
          agentLabel: "worker-a1b2c3d4",
          backgroundOwner: "session",
          todos: [],
        },
        {
          title: "Other session worker",
          status: "running",
          claim: "subagent",
          agentLabel: "reviewer",
          todos: [],
        },
      ],
      independentTodos: [],
      taskCountTotal: 2,
      taskCountClaimed: 2,
      taskCountClaimedBySession: 0,
      outputLanguage: "en",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  ).join("\n");

  assert.match(lines, /◆ Overview: background subagents \(1\): @worker-a1b2c3d4/);
  assert.doesNotMatch(lines, /background subagents.*reviewer/);
});

void test("spark widget renders overview as a top-level line above the thread header", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          title: "Background task",
          status: "running",
          claim: "subagent",
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

  assert.match(lines[0] ?? "", /^◆ Overview:/);
  assert.doesNotMatch(lines[0] ?? "", /^├─/);
  assert.match(lines[1] ?? "", /^◆ Spark UX redesign/);
  assert.match(lines[2] ?? "", /^├─ →/);
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
        { title: "Cancelled task", status: "cancelled", agentLabel: "unassigned", todos: [] },
        { title: "Done task", status: "done", agentLabel: "unassigned", todos: [] },
        { title: "Pending task", status: "pending", agentLabel: "unassigned", todos: [] },
        { title: "Running task", status: "running", agentLabel: "unassigned", todos: [] },
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

void test("spark widget collapses overflowing rows", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
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
