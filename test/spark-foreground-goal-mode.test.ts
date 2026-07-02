import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectRef } from "@zendev-lab/spark-extension-api";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  foregroundUnfinishedTaskMode,
  suggestForegroundGoalMode,
} from "../packages/spark-extension/src/extension/spark-foreground-goal-mode.ts";

const projectRef = "proj:test" as ProjectRef;

function graphWith(input: {
  ready?: Array<{ status: string; kind: string }>;
  tasks?: Array<{ status: string; kind: string }>;
}): TaskGraph {
  return {
    readyTasks: () => input.ready ?? [],
    tasks: () => input.tasks ?? [],
  } as unknown as TaskGraph;
}

void test("foreground goal mode continues concrete unfinished implement work instead of replanning", () => {
  const graph = graphWith({ tasks: [{ status: "pending", kind: "implement" }] });

  assert.equal(suggestForegroundGoalMode(graph, projectRef, "按 GOAL.md 要求复现"), "implement");
});

void test("foreground goal mode keeps research for only research/review unfinished work", () => {
  assert.equal(
    foregroundUnfinishedTaskMode([{ kind: "research" }, { kind: "review" }]),
    "research",
  );
});

void test("foreground goal mode plans only when no project or no unfinished frontier needs planning", () => {
  assert.equal(suggestForegroundGoalMode(graphWith({}), undefined, "复现"), "plan");
  assert.equal(suggestForegroundGoalMode(graphWith({}), projectRef, "规划一下"), "plan");
});
