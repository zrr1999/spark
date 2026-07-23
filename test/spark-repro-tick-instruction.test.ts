import assert from "node:assert/strict";
import { test } from "vitest";

import { renderReproTickInstruction } from "../packages/pi-extension/src/extension/spark-repro-tool-registration.ts";
import {
  createSparkSessionRepro,
  type SparkReproStageName,
} from "../packages/pi-extension/src/extension/spark-session-repro.ts";

function instructionForStage(stageName: SparkReproStageName): string {
  const repro = createSparkSessionRepro(`session:${stageName}`);
  const currentStageIndex = repro.stages.findIndex((stage) => stage.name === stageName);
  const stage = repro.stages[currentStageIndex];
  if (!stage) throw new Error(`missing repro stage: ${stageName}`);
  return renderReproTickInstruction({
    ...repro,
    currentStageIndex,
    currentPhase: stage.phases[0]!,
  });
}

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

test("reproduce and scale ticks apply the selective evidence-gated Fusion policy", () => {
  for (const stageName of ["reproduce", "scale"] as const) {
    const instruction = instructionForStage(stageName);

    assert.match(instruction, /Selective Fusion policy \(reproduce\/scale only\)/);
    assert.match(instruction, /fusion\(\{ action: "deliberate"/);
    assert.match(instruction, /first divergence has been localized with durable runtime evidence/);
    assert.match(instruction, /at least two plausible falsifiable hypotheses remain/);
    assert.match(instruction, /the evidence conflicts/);
    assert.match(instruction, /latest runtime_verdict is inconclusive/);
    assert.match(instruction, /Skip Fusion when the next single-variable experiment is already clear and cheap/);
    assert.match(instruction, /bounded summary/);
    assert.match(instruction, /original evidence: refs/);
    assert.match(instruction, /Never pass the full transcript, raw logs, or stale context/);
    assert.match(instruction, /unless the evidence or active hypotheses materially changed/);
    assert.match(instruction, /unavailable, partial, or failed, continue SOLO/);
    assert.match(instruction, /cheapest single-variable experiment/);
    assert.match(instruction, /main repro session remains the sole writer and executor/);
    assert.match(instruction, /must not write code, execute experiments/);
    assert.match(instruction, /emit a runtime verdict, satisfy repro proof or a gate/);
    assert.match(instruction, /neither internal evidence nor a Product Artifact/);
    assert.match(instruction, /Product Artifact kinds remain exactly issue, pr, and preview/);
  }
});

test("setup, scaffold, and deliver ticks do not suggest Fusion", () => {
  for (const stageName of ["setup", "scaffold", "deliver"] as const) {
    const instruction = instructionForStage(stageName);

    assert.doesNotMatch(instruction, /Selective Fusion policy/);
    assert.doesNotMatch(instruction, /fusion\(\{ action: "deliberate"/);
  }
});
