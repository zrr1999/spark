import assert from "node:assert/strict";
import test from "node:test";

import { renderReproTickInstruction } from "../packages/pi-extension/src/extension/spark-repro-tool-registration.ts";
import { createSparkSessionRepro } from "../packages/pi-extension/src/extension/spark-session-repro.ts";

void test("repro ticks require a timely commit or visible work evidence", () => {
  const instruction = renderReproTickInstruction(createSparkSessionRepro("session:test"));

  assert.match(instruction, /Before ending every repro turn, leave a verifiable checkpoint/);
  assert.match(instruction, /create a small git commit promptly/);
  assert.match(instruction, /Never include unrelated pre-existing changes/);
  assert.match(instruction, /show the work completed in the turn/);
  assert.match(instruction, /artifact refs or file paths/);
  assert.match(instruction, /commands\/tests and their results/);
  assert.match(instruction, /Do not end with only a progress claim/);
});
