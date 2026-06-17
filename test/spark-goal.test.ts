import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  createGoal,
  goalToolResponse,
  validateObjective,
} from "@zendev-lab/pi-goal";

void test("pi-goal package stays isolated from workflow packages", async () => {
  const pkg = JSON.parse(await readFile("packages/pi-goal/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };

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
  assert.match(prompt, /<spark_goal_continuation/);
  assert.match(prompt, /goal\(\{ action: "status" \}\)/);
  assert.match(prompt, /goal\(\{ action: "complete" \}\)/);
  assert.match(prompt, /requesting reviewer-gated completion/);
  assert.equal(continuationGoalIdFromPrompt(prompt), goal.goalId);

  const response = goalToolResponse(goal);
  assert.equal(response.goal?.goalId, goal.goalId);
  assert.equal(response.goal?.status, "active");
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
