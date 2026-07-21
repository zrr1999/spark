import assert from "node:assert/strict";
import { test } from "vitest";

import { renderReproTickInstruction } from "../packages/pi-extension/src/extension/spark-repro-tool-registration.ts";
import { createSparkSessionRepro } from "../packages/pi-extension/src/extension/spark-session-repro.ts";

test("repro ticks require a timely commit or visible work evidence", () => {
  const instruction = renderReproTickInstruction(createSparkSessionRepro("session:test"));

  assert.match(instruction, /Before ending every repro turn, leave a verifiable checkpoint/);
  assert.match(instruction, /create a small git commit promptly/);
  assert.match(instruction, /Never include unrelated pre-existing changes/);
  assert.match(instruction, /show the work completed in the turn/);
  assert.match(instruction, /artifact refs or file paths/);
  assert.match(instruction, /commands\/tests and their results/);
  assert.match(instruction, /Do not end with only a progress claim/);
  assert.match(
    instruction,
    /Classify each unknown as fact, reversible choice, material user decision/,
  );
  assert.match(instruction, /compare reuse, adaptation, and new implementation/);
  assert.match(
    instruction,
    /inspect the real module path first and compare it with an eager probe/,
  );
  assert.match(instruction, /Ask exactly one material user decision at a time/);
  assert.match(instruction, /recordAsEvidence=true/);
});
