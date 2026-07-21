import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "vitest";

import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  createGoal,
  createLoop,
  evaluateLoopTick,
  goalToolResponse,
  validateObjective,
} from "@zendev-lab/spark-loop";

test("spark-loop package owns goal primitives and stays isolated from workflow packages", async () => {
  const pkg = JSON.parse(await readFile("packages/spark-loop/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };

  const dependencyNames = Object.keys(pkg.dependencies ?? {});
  assert.equal(
    dependencyNames.some((name) => name.endsWith("/pi-" + "goal")),
    false,
  );
  assert.equal(pkg.dependencies?.["spark-workflows"], undefined);

  const sourceFiles = await listTypeScriptFiles("packages/spark-loop/src");
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /(?:from\s+["']|import\(["'])spark-workflows["']/u,
      `${file} must not import workflow packages`,
    );
  }
});

test("spark-loop goal helpers create goals and continuation prompts", () => {
  assert.equal(validateObjective("  ship feature  "), null);
  const goal = createGoal("  ship feature  ", 123);
  assert.equal(goal.objective, "ship feature");
  assert.equal(goal.status, "active");

  const prompt = compactContinuationPrompt(goal);
  assert.equal(continuationGoalIdFromPrompt(prompt), goal.goalId);

  const response = goalToolResponse(goal);
  assert.equal(response.goal?.goalId, goal.goalId);
  assert.equal(response.goal?.status, "active");
});

test("spark-loop exposes non-completing loop primitives alongside goal helpers", () => {
  const loop = createLoop("Continue without completing", 123);
  const tick = evaluateLoopTick({ loop, now: 124, reason: "start" });

  assert.equal(tick.decision, "continue");
  assert.equal(tick.loop?.status, "active");
  assert.notEqual(tick.decision, "complete");
  assert.notEqual(tick.loop?.status, "complete");
});

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(path)));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}
