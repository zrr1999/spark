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

void test("spark widget shows claimed tasks with nested TODOs and independent TODO siblings", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          name: "overlay-ui",
          title: "Redesign task and TODO display",
          description: "Implementation details are hidden in the widget",
          status: "running",
          claimedByCurrentSession: true,
          todos: [
            { content: "Update widget layout", status: "in_progress" },
            { content: "Update docs", status: "pending" },
          ],
        },
      ],
      independentTodos: [{ content: "Decide thread symbol", status: "pending" }],
      taskCountTotal: 3,
      taskCountClaimed: 2,
      taskCountClaimedBySession: 1,
      outputLanguage: "en",
    },
    { terminal: { columns: 120 }, requestRender() {} },
    theme,
  );

  assert.match(lines.join("\n"), /@overlay-ui: Redesign task and TODO display/);
  assert.match(lines.join("\n"), /#1 Update widget layout/);
  assert.match(lines.join("\n"), /#2 Update docs/);
  assert.match(lines.join("\n"), /#3 Decide thread symbol/);
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

void test("spark widget collapses overflowing rows", () => {
  const lines = renderSparkWidgetLines(
    {
      threadTitle: "Spark UX redesign",
      tasks: [
        {
          name: "overlay-ui",
          title: "Redesign task and TODO display",
          description: "Implementation details are hidden in the widget",
          status: "running",
          claimedByCurrentSession: true,
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
