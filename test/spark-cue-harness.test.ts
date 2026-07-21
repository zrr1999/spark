import assert from "node:assert/strict";
import { test } from "vitest";

import { runSparkCueHarness } from "../scripts/spark-cue-harness.mts";

test("spark cue harness reports blockers when cue-tui is missing", async () => {
  const report = await runSparkCueHarness({
    strict: false,
    exercise: false,
    outputPath: "/tmp/spark-cue-harness-unit-test.json",
  });
  assert.equal(report.backend, "cue");
  assert.equal(typeof report.capabilities.cueTuiAvailable, "boolean");
  if (!report.capabilities.cueTuiAvailable) {
    assert.match(report.blockers.join("\n"), /cue-tui is not available/u);
  }
});
