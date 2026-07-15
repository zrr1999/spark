import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SPARK_IDENTITY_PROMPT } from "../packages/spark-host/src/system-prompt.ts";

void test("Spark identity prompt does not imply work continues after a final response", () => {
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /Each invocation ends/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /durable background task/u);
  assert.match(DEFAULT_SPARK_IDENTITY_PROMPT, /completed work, active durable work/u);
});
