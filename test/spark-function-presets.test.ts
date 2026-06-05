import assert from "node:assert/strict";
import test from "node:test";

import {
  SPARK_PATCHER_GRAFT_TOOLS,
  SPARK_PATCHER_PRESET_ID,
  createSparkFunctionPresets,
} from "../packages/spark/src/extension/spark-function-presets.ts";

void test("Spark patcher is a Graft-only function preset over the worker role", () => {
  const presets = createSparkFunctionPresets();
  const patcher = presets.find((preset) => preset.id === SPARK_PATCHER_PRESET_ID);

  assert.equal(patcher?.kind, "function");
  assert.equal(patcher?.baseRoleRef, "role:builtin-worker");
  assert.deepEqual(patcher?.allowedTools, [...SPARK_PATCHER_GRAFT_TOOLS]);
  assert.ok(patcher?.allowedTools.every((tool) => tool.startsWith("graft_")));
  assert.equal(
    (patcher?.allowedTools as readonly string[] | undefined)?.includes("graft_cli_exec"),
    false,
  );
  assert.match(patcher?.runGuidance ?? "", /Do not edit the working tree directly/);
});
