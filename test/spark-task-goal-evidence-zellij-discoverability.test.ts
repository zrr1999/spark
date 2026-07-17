import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSparkWidgetLines,
  type SparkWidgetState,
} from "../packages/spark-host/src/spark-widget.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => text,
};

void test("spark widget does not show static task goal evidence review hint", () => {
  const state: SparkWidgetState = {
    projectTitle: "Spark daemon-first session UX and Pi/Codex parity hardening",
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
    tasks: [{ title: "Expose task/goal/evidence advantage", status: "pending", todos: [] }],
    independentTodos: [],
    taskCountTotal: 16,
    taskCountClaimed: 0,
    taskCountClaimedBySession: 0,
    outputLanguage: "en",
  };
  const lines = renderSparkWidgetLines(
    state,
    { terminal: { columns: 180 }, requestRender() {} },
    theme,
  );
  const rendered = lines.join("\n");
  assert.match(rendered, /Goal\(/u);
  assert.match(rendered, /tasks 14\/16 · ready 2/u);
  assert.doesNotMatch(rendered, /Evidence\/review/u);
  const summaryLines = lines.filter((line) =>
    /Goal\(|Spark daemon-first|Expose task\/goal\/evidence/.test(line),
  );
  assert.equal(summaryLines.length <= 5, true, rendered);
});
