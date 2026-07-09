import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createSparkSessionRepro,
  currentReproStage,
  currentPhaseAcceptance,
  isPhaseComplete,
  isStageAcceptanceMet,
  isStageGatePassed,
  isStageComplete,
  advanceReproPhase,
  advanceReproStage,
  satisfyAcceptanceCondition,
  passStageGate,
  DEFAULT_REPRO_STAGES,
  type SparkSessionRepro,
} from "../packages/pi-extension/src/extension/spark-session-repro.ts";

void describe("SparkSessionRepro state machine", () => {
  function makeRepro(): SparkSessionRepro {
    return createSparkSessionRepro("test-session");
  }

  void it("creates repro with 5 default stages starting at setup/research", () => {
    const repro = makeRepro();
    assert.equal(repro.version, 1);
    assert.equal(repro.status, "active");
    assert.equal(repro.currentStageIndex, 0);
    assert.equal(repro.currentPhase, "research");
    assert.equal(repro.stages.length, 5);
    assert.equal(repro.stages[0].name, "setup");
    assert.equal(repro.stages[1].name, "scaffold");
    assert.equal(repro.stages[2].name, "reproduce");
    assert.equal(repro.stages[3].name, "scale");
    assert.equal(repro.stages[4].name, "deliver");
  });

  void it("preserves an optional user-supplied reproduction objective", () => {
    const repro = createSparkSessionRepro("test-session", undefined, {
      objective: "进行正经的复现对齐工作",
    });
    assert.equal(repro.objective, "进行正经的复现对齐工作");
  });

  void it("currentReproStage returns the active stage", () => {
    const repro = makeRepro();
    const stage = currentReproStage(repro);
    assert.equal(stage.name, "setup");
    assert.deepEqual(stage.phases, ["research", "plan"]);
  });

  void it("currentPhaseAcceptance filters by current phase", () => {
    const repro = makeRepro();
    const conditions = currentPhaseAcceptance(repro);
    assert.equal(conditions.length, 1);
    assert.equal(conditions[0].phase, "research");
    assert.equal(conditions[0].satisfied, false);
  });

  void it("isPhaseComplete returns false when conditions unsatisfied", () => {
    const repro = makeRepro();
    assert.equal(isPhaseComplete(repro), false);
  });

  void it("satisfyAcceptanceCondition marks a condition satisfied", () => {
    const repro = makeRepro();
    const updated = satisfyAcceptanceCondition(repro, "Problem statement documented", "art:123");
    assert.ok(updated);
    const stage = currentReproStage(updated!);
    assert.equal(stage.acceptance[0].satisfied, true);
    assert.equal(stage.acceptance[0].evidenceRef, "art:123");
  });

  void it("isPhaseComplete returns true after satisfying all conditions for that phase", () => {
    const repro = makeRepro();
    const updated = satisfyAcceptanceCondition(repro, "Problem statement documented");
    assert.ok(updated);
    assert.equal(isPhaseComplete(updated!), true);
  });

  void it("advanceReproPhase moves from research to plan in setup stage", () => {
    let repro = makeRepro();
    repro = satisfyAcceptanceCondition(repro, "Problem statement documented")!;
    const advanced = advanceReproPhase(repro);
    assert.ok(advanced);
    assert.equal(advanced!.currentPhase, "plan");
    assert.equal(advanced!.currentStageIndex, 0); // Still in setup
  });

  void it("advanceReproPhase returns undefined when phase conditions not met", () => {
    const repro = makeRepro();
    const result = advanceReproPhase(repro);
    assert.equal(result, undefined);
  });

  void it("isStageAcceptanceMet requires all conditions in all phases", () => {
    let repro = makeRepro();
    repro = satisfyAcceptanceCondition(repro, "Problem statement documented")!;
    assert.equal(isStageAcceptanceMet(repro), false); // plan condition still unsatisfied
    repro = satisfyAcceptanceCondition(repro, "Reproduction strategy planned")!;
    assert.equal(isStageAcceptanceMet(repro), true);
  });

  void it("isStageGatePassed returns true when no gate defined", () => {
    const repro = makeRepro(); // setup has no gate
    assert.equal(isStageGatePassed(repro), true);
  });

  void it("isStageComplete checks both acceptance and gate", () => {
    let repro = makeRepro();
    repro = satisfyAcceptanceCondition(repro, "Problem statement documented")!;
    repro = satisfyAcceptanceCondition(repro, "Reproduction strategy planned")!;
    assert.equal(isStageComplete(repro), true); // No gate on setup
  });

  void it("advanceReproStage moves to next stage", () => {
    let repro = makeRepro();
    repro = satisfyAcceptanceCondition(repro, "Problem statement documented")!;
    repro = satisfyAcceptanceCondition(repro, "Reproduction strategy planned")!;
    const advanced = advanceReproStage(repro);
    assert.ok(advanced);
    assert.equal(advanced!.currentStageIndex, 1);
    assert.equal(advanced!.currentPhase, "implement");
    assert.equal(currentReproStage(advanced!).name, "scaffold");
  });

  void it("advanceReproStage returns undefined when stage not complete", () => {
    const repro = makeRepro();
    assert.equal(advanceReproStage(repro), undefined);
  });

  void it("passStageGate marks gate as passed", () => {
    let repro = makeRepro();
    // Move to reproduce stage (index 2) which has gate-A
    repro = { ...repro, currentStageIndex: 2, currentPhase: "implement" };
    const withGate = passStageGate(repro);
    assert.ok(withGate);
    assert.equal(withGate!.stages[2].gate!.passed, true);
    assert.ok(withGate!.stages[2].gate!.passedAt);
  });

  void it("passStageGate returns undefined when no gate exists", () => {
    const repro = makeRepro(); // setup stage, no gate
    assert.equal(passStageGate(repro), undefined);
  });

  void it("advanceReproStage at last stage marks repro complete", () => {
    let repro = makeRepro();
    // Move to deliver stage (index 4)
    repro = { ...repro, currentStageIndex: 4, currentPhase: "implement" };
    // Satisfy deliver acceptance
    repro = satisfyAcceptanceCondition(repro, "PR submitted")!;
    repro = satisfyAcceptanceCondition(repro, "No runtime patches remain")!;
    // Pass gate-C
    repro = passStageGate(repro)!;
    // Advance should complete
    const completed = advanceReproStage(repro);
    assert.ok(completed);
    assert.equal(completed!.status, "complete");
    assert.ok(completed!.completedAt);
  });

  void it("DEFAULT_REPRO_STAGES has correct structure", () => {
    assert.equal(DEFAULT_REPRO_STAGES.length, 5);
    // setup has no gate
    assert.equal(DEFAULT_REPRO_STAGES[0].gate, undefined);
    // reproduce has gate-A
    assert.equal(DEFAULT_REPRO_STAGES[2].gate!.id, "gate-A");
    // scale has gate-B
    assert.equal(DEFAULT_REPRO_STAGES[3].gate!.id, "gate-B");
    // deliver has gate-C
    assert.equal(DEFAULT_REPRO_STAGES[4].gate!.id, "gate-C");
  });

  void it("stages have correct phase configurations", () => {
    assert.deepEqual(DEFAULT_REPRO_STAGES[0].phases, ["research", "plan"]);
    assert.deepEqual(DEFAULT_REPRO_STAGES[1].phases, ["implement"]);
    assert.deepEqual(DEFAULT_REPRO_STAGES[2].phases, ["implement"]);
    assert.deepEqual(DEFAULT_REPRO_STAGES[3].phases, ["implement"]);
    assert.deepEqual(DEFAULT_REPRO_STAGES[4].phases, ["implement"]);
  });
});
