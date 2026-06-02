import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  createSparkGoal,
  formatSparkBudgetLines,
  goalToolResponse,
  validateObjective,
} from "../packages/spark-workflows/src/index.ts";

void test("spark-workflows goal helpers create Spark-owned goals and continuation prompts", () => {
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
