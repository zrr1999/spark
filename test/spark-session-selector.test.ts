import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@zendev-lab/spark-tui/text";
import type { Component } from "../apps/spark-tui/src/tui/pi-tui-adapter.ts";
import {
  CREATE_SPARK_SESSION_SELECTION,
  createSparkSessionSelectorComponent,
  selectSparkSessionFromCustomUi,
} from "../apps/spark-tui/src/tui/session-selector.ts";
import type {
  SparkModelSelectorCustomUi,
  SparkModelSelectorTheme,
  SparkModelSelectorTuiLike,
} from "../apps/spark-tui/src/tui/model-selector.ts";

const sessions = [
  {
    sessionId: "session-recent",
    title: "Recent conversation",
    scope: { kind: "workspace" as const, workspaceId: "workspace-1" },
    workspaceId: "workspace-1",
    status: "ready" as const,
    model: { providerName: "openai", modelId: "gpt-5" },
    thinkingLevel: "high" as const,
    bindings: [],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z",
  },
];

void test("Spark session selector renders new and daemon-managed session choices", () => {
  const selected: string[] = [];
  const component = createSparkSessionSelectorComponent({
    sessions,
    workspaceLabel: "spark • /workspace/spark",
    onSelect: (value) => selected.push(value),
  });

  const lines = component.render(72);
  assert.equal(
    lines.some((line) => line.includes("Open Spark Session")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("+ New session")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Recent conversation")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("openai/gpt-5")),
    true,
  );
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 72),
    true,
  );

  component.handleInput?.("\r");
  assert.deepEqual(selected, [CREATE_SPARK_SESSION_SELECTION]);
});

void test("Spark session selector custom UI returns an existing daemon session", async () => {
  let overlayEnabled = false;
  let rendered = false;
  const customUi: SparkModelSelectorCustomUi = {
    custom<T>(
      factory: (
        tui: SparkModelSelectorTuiLike,
        theme: SparkModelSelectorTheme,
        keybindings: unknown,
        done: (value: T) => void,
      ) => Component,
      options?: unknown,
    ): T {
      overlayEnabled =
        typeof options === "object" &&
        options !== null &&
        (options as { overlay?: unknown }).overlay === true;
      const component = factory(
        { requestRender: () => undefined },
        {},
        undefined,
        (_value: T) => undefined,
      );
      rendered = component.render(72).some((line) => line.includes("Recent conversation"));
      return "session-recent" as T;
    },
  };

  const selection = await selectSparkSessionFromCustomUi(customUi, {
    sessions,
    workspaceLabel: "spark • /workspace/spark",
  });
  assert.equal(rendered, true);
  assert.equal(overlayEnabled, true);
  assert.equal(selection, "session-recent");
});
