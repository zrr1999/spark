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
  assert.match(instruction, /runnable competitor\/reference baseline/);
  assert.match(instruction, /typically a Megatron implementation/);
  assert.match(instruction, /Do not invent a substitute baseline/);
  assert.match(instruction, /Prefer the main session for scheduling/);
  assert.match(instruction, /call ask immediately with a concrete question/);
  assert.match(instruction, /Do not default to role/);
});

test("repro setup next step prioritizes competitor baseline availability research", () => {
  const instruction = renderReproTickInstruction(createSparkSessionRepro("session:test"));

  assert.match(instruction, /competitor-baseline-availability-researched/);
  assert.match(instruction, /typically Megatron/);
  assert.match(instruction, /failed-lookup evidence/);
});
