import { describe, expect, it } from "vitest";

import type { ArtifactRef } from "@zendev-lab/spark-core";
import {
  createSparkSessionRepro,
  evaluateStageGate,
  isPhaseComplete,
  recordReproRequirementProof,
  type SparkReproRequirementProof,
  type SparkSessionRepro,
} from "./index.ts";

const ref = (id: string) => `artifact:${id}` as ArtifactRef;

describe("spark-repro", () => {
  it("requires research, explicit decisions, and a passing probe during setup", () => {
    let repro = createSparkSessionRepro("session:test");
    const proofs: Array<[string, SparkReproRequirementProof]> = [
      ["repro-contract-frozen", { kind: "evidence", evidenceRefs: [ref("contract")] }],
      [
        "implementation-landscape-researched",
        { kind: "evidence", evidenceRefs: [ref("implementation-research")] },
      ],
      [
        "alignment-paths-researched",
        { kind: "evidence", evidenceRefs: [ref("alignment-research")] },
      ],
      [
        "implementation-strategy-approved",
        { kind: "decision", decisionRef: ref("implementation-ask"), selectedValue: "reuse" },
      ],
      [
        "alignment-strategy-approved",
        { kind: "decision", decisionRef: ref("alignment-ask"), selectedValue: "real-module" },
      ],
    ];

    for (const [id, proof] of proofs) {
      repro = recordReproRequirementProof(repro, id, proof)!;
    }
    expect(isPhaseComplete(repro)).toBe(false);

    repro = recordReproRequirementProof(repro, "baseline-probe-passed", {
      kind: "validation",
      command: "run baseline probe",
      resultRef: ref("baseline-result"),
      passed: true,
    })!;
    expect(isPhaseComplete(repro)).toBe(true);
  });

  it("derives a gate failure and clears a stale evaluation when proof changes", () => {
    let repro: SparkSessionRepro = {
      ...createSparkSessionRepro("session:test"),
      currentStageIndex: 2,
      currentPhase: "implement" as const,
    };
    repro = evaluateStageGate(repro).repro;
    expect(repro.stages[2]?.gate?.evaluation?.passed).toBe(false);

    repro = recordReproRequirementProof(repro, "bitwise-pass-20", {
      kind: "validation",
      command: "run 20",
      resultRef: ref("20-result"),
      passed: true,
    })!;
    expect(repro.stages[2]?.gate?.evaluation).toBeUndefined();
  });
});
