import assert from "node:assert/strict";
import { test } from "vitest";

import type { ProjectRef } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  foregroundUnfinishedTaskMode,
  suggestForegroundGoalMode,
} from "../packages/pi-extension/src/extension/spark-foreground-goal-mode.ts";

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

test("foreground goal mode continues concrete unfinished implement work instead of replanning", () => {
  const graph = graphWith({ tasks: [{ status: "pending", kind: "implement" }] });

  assert.equal(suggestForegroundGoalMode(graph, projectRef, "按 GOAL.md 要求复现"), "implement");
});

test("foreground goal mode plans research/review unfinished work", () => {
  assert.equal(foregroundUnfinishedTaskMode([{ kind: "research" }, { kind: "review" }]), "plan");
});

test("foreground goal mode plans only when no project or no unfinished frontier needs planning", () => {
  assert.equal(suggestForegroundGoalMode(graphWith({}), undefined, "复现"), "plan");
  assert.equal(suggestForegroundGoalMode(graphWith({}), projectRef, "规划一下"), "plan");
});
