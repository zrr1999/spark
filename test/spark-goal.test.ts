import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  createSparkGoal,
  formatSparkBudgetLines,
  goalToolResponse,
  validateObjective,
} from "spark-goal";

void test("spark-goal package stays isolated from workflow packages", async () => {
  const pkg = JSON.parse(await readFile("packages/spark-goal/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };

  assert.equal(pkg.dependencies?.["spark-workflows"], undefined);

  const sourceFiles = await listTypeScriptFiles("packages/spark-goal/src");
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /(?:from\s+["']|import\(["'])spark-workflows["']/u,
      `${file} must not import workflow packages`,
    );
  }
});

void test("spark-goal helpers create Spark-owned goals and continuation prompts", () => {
  assert.equal(validateObjective("  ship feature  "), null);
  const goal = createSparkGoal("  ship feature  ", 1000, 123);
  assert.equal(goal.objective, "ship feature");
  assert.equal(goal.status, "active");
  assert.equal(goal.tokenBudget, 1000);

  const prompt = compactContinuationPrompt(goal);
  assert.match(prompt, /<spark_goal_continuation/);
  assert.match(prompt, /get_spark_goal/);
  assert.match(prompt, /update_spark_goal/);
  assert.equal(continuationGoalIdFromPrompt(prompt), goal.goalId);

  const response = goalToolResponse(goal);
  assert.equal(response.goal?.goalId, goal.goalId);
  assert.equal(response.remainingTokens, 1000);

  assert.deepEqual(
    formatSparkBudgetLines({ timeSpentSeconds: 61, tokensUsed: 250, tokenBudget: 1000 }),
    [
      "- Time spent pursuing goal: 1m",
      "- Tokens used: 250",
      "- Token budget: 1,000",
      "- Tokens remaining: 750",
    ],
  );
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
