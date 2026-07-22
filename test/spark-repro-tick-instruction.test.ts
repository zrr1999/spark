import assert from "node:assert/strict";
import { test } from "vitest";

import { createSparkSessionRepro } from "@zendev-lab/spark-repro";
import { renderReproTickInstruction } from "@zendev-lab/spark-repro/instructions";

test("repro ticks require a product checkpoint and a bounded productive slice", () => {
  const instruction = renderReproTickInstruction(createSparkSessionRepro("session:test"));

  assert.match(instruction, /bounded productive slice/);
  assert.match(instruction, /complete as many adjacent requirements/);
  assert.match(instruction, /Before ending every foreground repro turn, call artifact/);
  assert.match(instruction, /existing PR or ISSUE/);
  assert.match(instruction, /create one Markdown repro-progress preview once/);
  assert.match(instruction, /update that same artifact on later turns/);
  assert.match(instruction, /Internal evidence records, chat messages, unchanged syncs/);
  assert.match(instruction, /what changed, the validation result or exact blocker/);
  assert.match(instruction, /Real tool calls trigger evidence collection/);
  assert.match(instruction, /reuse returned evidence refs/);
  assert.match(instruction, /do not proactively write a separate evidence record/);
  assert.match(instruction, /only when the current requirement otherwise has no durable proof ref/);
  assert.match(instruction, /create a small git commit promptly/);
  assert.match(instruction, /Never include unrelated pre-existing changes/);
  assert.match(instruction, /Do not create a learning document every turn/);
  assert.match(instruction, /artifact kind="preview" with Markdown/);
  assert.match(instruction, /normally one, at most three/);
  assert.match(instruction, /owned by artifact, never memory or internal evidence/);
  assert.match(instruction, /update the same artifacts/);
  assert.doesNotMatch(instruction, /canonical learning-document store/);
  assert.doesNotMatch(instruction, /memory\(\{ action: "search", kind: "learning"/);
  assert.match(
    instruction,
    /Continue through adjacent requirements, evaluation, and phase\/stage advancement/,
  );
  assert.doesNotMatch(instruction, /do one concrete step per tick/);
  assert.doesNotMatch(instruction, /End the turn after one concrete step/);
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

test("reproduce ticks require a falsifiable runtime diagnostic loop", () => {
  const repro = createSparkSessionRepro("session:test");
  repro.currentStageIndex = 2;
  repro.currentPhase = "implement";

  const instruction = renderReproTickInstruction(repro);

  assert.match(instruction, /one bounded diagnostic loop per tick, not merely one command/);
  assert.match(instruction, /first_bad_step → first_bad_layer → suspected_boundary/);
  assert.match(instruction, /claim, supporting_refs, expected_if_true, and falsifier/);
  assert.match(instruction, /Change one variable at a time/);
  assert.match(instruction, /exact command, relevant config and environment/);
  assert.match(instruction, /runtime_verdict=confirmed \| rejected \| inconclusive/);
  assert.match(instruction, /cannot stand in for runtime validation/);
  assert.match(instruction, /offline \.npy\/\.safetensors slice/);
  assert.match(instruction, /sole writer and executor/);
});
