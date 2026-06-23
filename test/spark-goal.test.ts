import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  createGoal,
  createLoop,
  evaluateLoopTick,
  goalToolResponse,
  validateObjective,
} from "@zendev-lab/pi-goal";

void test("pi-goal package stays isolated from workflow packages", async () => {
  const pkg = JSON.parse(await readFile("packages/pi-goal/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };

  assert.equal(pkg.dependencies?.["@zendev-lab/pi-loop"], "workspace:^");
  assert.equal(pkg.dependencies?.["spark-workflows"], undefined);

  const sourceFiles = await listTypeScriptFiles("packages/pi-goal/src");
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /(?:from\s+["']|import\(["'])spark-workflows["']/u,
      `${file} must not import workflow packages`,
    );
  }
});

void test("pi-goal helpers create goals and continuation prompts", () => {
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

void test("pi-goal re-exports non-completing pi-loop primitives", () => {
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
