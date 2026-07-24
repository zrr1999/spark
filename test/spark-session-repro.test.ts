import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";

import type { EvidenceRef } from "@zendev-lab/spark-core";
import {
  DEFAULT_REPRO_STAGES,
  advanceReproStage,
  createSparkSessionRepro,
  currentPhaseAcceptance,
  currentReproStage,
  evaluateStageGate,
  isPhaseComplete,
  isReproRequirementSatisfied,
  isStageComplete,
  passStageGate,
  readSessionRepro,
  recordReproRequirementProof,
  satisfyAcceptanceCondition,
  sessionReproStorePath,
  type SparkReproRequirementProof,
  type SparkSessionRepro,
} from "../packages/spark-extension/src/extension/spark-session-repro.ts";

const artifactRef = (id: string) => `evidence:${id}` as EvidenceRef;

describe("SparkSessionRepro evidence-backed state machine", () => {
  function makeRepro(): SparkSessionRepro {
    return createSparkSessionRepro("test-session");
  }

  it("starts a v3 research-first setup with stable typed requirements", () => {
    const repro = makeRepro();
    const setup = currentReproStage(repro);

    assert.equal(repro.version, 3);
    assert.equal(repro.status, "active");
    assert.equal(repro.currentStageIndex, 0);
    assert.equal(repro.currentPhase, "plan");
    assert.deepEqual(
      repro.stages.map((stage) => stage.name),
      ["setup", "scaffold", "reproduce", "scale", "deliver"],
    );
    assert.deepEqual(
      setup.acceptance.map(({ id, kind }) => [id, kind]),
      [
        ["repro-contract-frozen", "evidence"],
        ["competitor-baseline-availability-researched", "evidence"],
        ["baseline-construction-strategy-approved", "decision"],
        ["implementation-landscape-researched", "evidence"],
        ["alignment-paths-researched", "evidence"],
        ["implementation-strategy-approved", "decision"],
        ["alignment-strategy-approved", "decision"],
        ["baseline-probe-passed", "validation"],
      ],
    );
    assert.equal(currentPhaseAcceptance(repro).length, 8);
    assert.equal(
      setup.acceptance.every((item) => !isReproRequirementSatisfied(item)),
      true,
    );
  });

  it("preserves an optional user-supplied reproduction objective", () => {
    const repro = createSparkSessionRepro("test-session", undefined, {
      objective: "进行正经的复现对齐工作",
    });
    assert.equal(repro.objective, "进行正经的复现对齐工作");
  });

  it("derives readiness from evidence, user decisions, and validation proof", () => {
    let repro = makeRepro();
    repro = record(repro, "repro-contract-frozen", {
      kind: "evidence",
      evidenceRefs: [artifactRef("contract")],
    });
    repro = record(repro, "competitor-baseline-availability-researched", {
      kind: "evidence",
      evidenceRefs: [artifactRef("baseline-availability")],
    });
    repro = record(repro, "baseline-construction-strategy-approved", {
      kind: "decision",
      decisionRef: artifactRef("baseline-construction-ask"),
      selectedValue: "reuse-existing",
    });
    repro = record(repro, "implementation-landscape-researched", {
      kind: "evidence",
      evidenceRefs: [artifactRef("reuse-research")],
    });
    repro = record(repro, "alignment-paths-researched", {
      kind: "evidence",
      evidenceRefs: [artifactRef("alignment-research")],
    });
    repro = record(repro, "implementation-strategy-approved", {
      kind: "decision",
      decisionRef: artifactRef("implementation-ask"),
      selectedValue: "reuse",
    });
    repro = record(repro, "alignment-strategy-approved", {
      kind: "decision",
      decisionRef: artifactRef("alignment-ask"),
      selectedValue: "real-module",
    });
    assert.equal(isPhaseComplete(repro), false);

    repro = record(repro, "baseline-probe-passed", {
      kind: "validation",
      command: "pnpm test baseline",
      resultRef: artifactRef("baseline-output"),
      passed: true,
    });

    assert.equal(isPhaseComplete(repro), true);
    assert.equal(isStageComplete(repro), true);
    const scaffold = advanceReproStage(repro);
    assert.equal(scaffold?.currentStageIndex, 1);
    assert.equal(scaffold?.currentPhase, "implement");
  });

  it("rejects proof kinds that do not match the stable requirement", () => {
    const repro = makeRepro();
    assert.throws(
      () =>
        recordReproRequirementProof(repro, "implementation-strategy-approved", {
          kind: "evidence",
          evidenceRefs: [artifactRef("research")],
        }),
      /expects decision proof, received evidence/u,
    );
  });

  it("keeps the legacy satisfy helper fail-closed", () => {
    const repro = makeRepro();
    assert.equal(satisfyAcceptanceCondition(repro, "repro-contract-frozen"), undefined);
    assert.equal(
      satisfyAcceptanceCondition(
        repro,
        "implementation-strategy-approved",
        artifactRef("decision"),
      ),
      undefined,
    );
    const updated = satisfyAcceptanceCondition(
      repro,
      "repro-contract-frozen",
      artifactRef("contract"),
    );
    assert.equal(updated?.stages[0]?.acceptance[0]?.kind, "evidence");
    assert.equal(isReproRequirementSatisfied(updated!.stages[0]!.acceptance[0]!), true);
  });

  it("derives gates from proof and cannot force-pass an incomplete stage", () => {
    const repro = { ...makeRepro(), currentStageIndex: 2, currentPhase: "implement" as const };
    const blocked = evaluateStageGate(repro);
    assert.equal(blocked.passed, false);
    assert.deepEqual(blocked.blockers, [
      "bitwise-pass-20 requires a command, result evidence ref, and passing validation result",
      "bitwise-pass-100 requires a command, result evidence ref, and passing validation result",
    ]);
    assert.equal(passStageGate(repro), undefined);

    let proved = record(repro, "bitwise-pass-20", validation("20", true));
    proved = record(proved, "bitwise-pass-100", validation("100", true));
    const passed = evaluateStageGate(proved);
    assert.equal(passed.passed, true);
    assert.equal(passed.repro.stages[2]?.gate?.evaluation?.passed, true);
    assert.deepEqual(passed.repro.stages[2]?.gate?.evaluation?.evidenceRefs, [
      artifactRef("result-20"),
      artifactRef("result-100"),
    ]);
  });

  it("migrates legacy state without trusting artifact-backed facts or agent-authored decisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-phase-migration-"));
    try {
      const current = makeRepro();
      const legacy: any = {
        ...current,
        version: 1,
        currentPhase: "research",
        stages: current.stages.map((stage) => ({
          name: stage.name,
          title: stage.title,
          phases: stage.name === "setup" ? ["research", "plan"] : stage.phases,
          acceptance: stage.acceptance.map((requirement) => ({
            description: requirement.description,
            phase: requirement.phase,
            satisfied: false,
          })),
          ...(stage.gate
            ? {
                gate: {
                  id: stage.gate.id,
                  description: stage.gate.description,
                  passed: true,
                },
              }
            : {}),
        })),
      };
      legacy.stages[0]!.acceptance = [
        {
          description: "Problem statement documented",
          phase: "research",
          satisfied: true,
          evidenceRef: "artifact:legacy-problem",
        },
        {
          description: "Reproduction strategy planned",
          phase: "plan",
          satisfied: true,
        },
      ];
      const path = sessionReproStorePath(dir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 1, repro: legacy })}\n`, "utf8");

      const migrated = await readSessionRepro(dir);
      assert.equal(migrated?.version, 3);
      assert.equal(migrated?.currentPhase, "plan");
      assert.deepEqual(migrated?.stages[0]?.phases, ["plan"]);
      assert.deepEqual(migrated?.stages[0]?.acceptance[0], {
        id: "repro-contract-frozen",
        kind: "evidence",
        description: "Reproduction claim and acceptance contract frozen",
        phase: "plan",
        evidenceRefs: [],
      });
      assert.equal(
        isReproRequirementSatisfied(
          migrated!.stages[0]!.acceptance.find(
            (requirement) => requirement.id === "implementation-strategy-approved",
          )!,
        ),
        false,
        "a legacy strategy boolean is not a recorded user decision",
      );
      assert.equal(migrated?.stages[2]?.gate?.evaluation, undefined);

      const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      assert.equal(persisted.version, 3);
      assert.doesNotMatch(JSON.stringify(persisted), /"research"/u);
      assert.doesNotMatch(JSON.stringify(persisted), /"satisfied"/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes artifact-backed proof and stale gates from stored v3 snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-v3-evidence-hard-cut-"));
    try {
      const repro = makeRepro();
      const setup = repro.stages[0]!;
      setup.acceptance[0] = {
        ...setup.acceptance[0]!,
        kind: "evidence",
        evidenceRefs: ["artifact:legacy-contract" as unknown as EvidenceRef],
      };
      const reproduce = repro.stages[2]!;
      reproduce.gate!.evaluation = {
        passed: true,
        blockers: [],
        evidenceRefs: ["artifact:legacy-validation" as unknown as EvidenceRef],
        evaluatedAt: new Date().toISOString(),
      };
      const path = sessionReproStorePath(dir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 3, repro })}\n`, "utf8");

      const sanitized = await readSessionRepro(dir);
      assert.deepEqual(sanitized?.stages[0]?.acceptance[0], {
        id: "repro-contract-frozen",
        kind: "evidence",
        description: "Reproduction claim and acceptance contract frozen",
        phase: "plan",
        evidenceRefs: [],
      });
      assert.equal(sanitized?.stages[2]?.gate?.evaluation, undefined);
      assert.doesNotMatch(await readFile(path, "utf8"), /artifact:legacy/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const version of [1, 2] as const) {
    it(`reopens incomplete legacy v${version} snapshots that claimed completion`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `spark-repro-v${version}-fail-closed-`));
      try {
        const current = makeRepro();
        const completedAt = "2026-01-02T03:04:05.000Z";
        const legacy: any = {
          ...current,
          version,
          status: "complete",
          currentStageIndex: current.stages.length - 1,
          currentPhase: "implement",
          completedAt,
          stages: current.stages.map((stage) => ({
            name: stage.name,
            title: stage.title,
            phases: stage.phases,
            acceptance: stage.acceptance.map((requirement) => ({
              description: requirement.description,
              phase: requirement.phase,
              satisfied: true,
              evidenceRef: `artifact:legacy-${requirement.id}`,
            })),
            ...(stage.gate
              ? {
                  gate: {
                    id: stage.gate.id,
                    description: stage.gate.description,
                    passed: true,
                    passedAt: completedAt,
                  },
                }
              : {}),
          })),
        };
        const path = sessionReproStorePath(dir);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify({ version, repro: legacy })}\n`, "utf8");

        const migrated = await readSessionRepro(dir);
        assert.equal(migrated?.version, 3);
        assert.equal(migrated?.status, "active");
        assert.equal(migrated?.completedAt, undefined);
        assert.equal(migrated?.currentStageIndex, 0);
        assert.equal(migrated?.currentPhase, "plan");
        assert.equal(
          isReproRequirementSatisfied(
            migrated!.stages[0]!.acceptance.find(
              (requirement) => requirement.id === "baseline-construction-strategy-approved",
            )!,
          ),
          false,
          "legacy satisfied booleans and evidence refs cannot forge a v3 user decision",
        );
        assert.equal(
          isReproRequirementSatisfied(
            migrated!.stages[0]!.acceptance.find(
              (requirement) => requirement.id === "baseline-probe-passed",
            )!,
          ),
          false,
          "a legacy evidence ref cannot certify a v3 validation command and pass result",
        );
        assert.equal(migrated?.stages[2]?.gate?.evaluation, undefined);

        const persisted = JSON.parse(await readFile(path, "utf8")) as {
          version: number;
          repro?: Record<string, unknown>;
        };
        assert.equal(persisted.version, 3);
        assert.equal(persisted.repro?.status, "active");
        assert.equal(Object.hasOwn(persisted.repro ?? {}, "completedAt"), false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("keeps the five-stage gate topology", () => {
    assert.equal(DEFAULT_REPRO_STAGES.length, 5);
    assert.equal(DEFAULT_REPRO_STAGES[0]?.gate, undefined);
    assert.equal(DEFAULT_REPRO_STAGES[2]?.gate?.id, "gate-A");
    assert.equal(DEFAULT_REPRO_STAGES[3]?.gate?.id, "gate-B");
    assert.equal(DEFAULT_REPRO_STAGES[4]?.gate?.id, "gate-C");
  });
});

function record(
  repro: SparkSessionRepro,
  requirementId: string,
  proof: SparkReproRequirementProof,
): SparkSessionRepro {
  const updated = recordReproRequirementProof(repro, requirementId, proof);
  assert.ok(updated, `requirement should exist: ${requirementId}`);
  return updated;
}

function validation(id: string, passed: boolean): SparkReproRequirementProof {
  return {
    kind: "validation",
    command: `run ${id}`,
    resultRef: artifactRef(`result-${id}`),
    passed,
  };
}
