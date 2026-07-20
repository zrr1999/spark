import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SPARK_IDENTITY_PROMPT,
  renderPersistentSessionRolePrompt,
} from "../packages/spark-host/src/system-prompt.ts";

void test("Spark identity prompt does not imply work continues after a final response", () => {
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /Each invocation ends/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /durable background task/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /completed work, active durable work/u);
});

void test("persistent session role prompt keeps work grouped by division of labour", () => {
  const prompt = renderPersistentSessionRolePrompt("质量验证");
  assert.match(prompt, /Persistent session role: 质量验证/u);
  assert.match(prompt, /stable division of labour/u);
  assert.doesNotMatch(prompt, /administrator session/u);
});

void test("administrator role prompt owns coordination without changing task identity", () => {
  const prompt = renderPersistentSessionRolePrompt("管理员");
  assert.match(prompt, /administrator session/u);
  assert.match(prompt, /Before creating a session, list same-workspace local sessions/u);
  assert.match(prompt, /reuse a semantically matching role/u);
  assert.match(prompt, /Create only when no existing division of labour owns/u);
  assert.match(prompt, /user's language and existing naming style/u);
  assert.match(prompt, /never use a task slug/u);
});
