import { nowIso, type ArtifactRef } from "@zendev-lab/spark-core";

export type SparkSessionPhase = "plan" | "implement";

export type SparkReproStageName = "setup" | "scaffold" | "reproduce" | "scale" | "deliver";

interface SparkReproRequirementBase {
  /** Stable machine identifier; descriptions are presentation only. */
  id: string;
  description: string;
  phase: SparkSessionPhase;
}

export interface SparkReproEvidenceRequirement extends SparkReproRequirementBase {
  kind: "evidence";
  evidenceRefs: ArtifactRef[];
}

export interface SparkReproDecisionRequirement extends SparkReproRequirementBase {
  kind: "decision";
  /** Artifact produced by canonical ask with recordAsEvidence=true. */
  decisionRef?: ArtifactRef;
  selectedValue?: string;
  rationale?: string;
}

export interface SparkReproValidationRequirement extends SparkReproRequirementBase {
  kind: "validation";
  command?: string;
  resultRef?: ArtifactRef;
  passed?: boolean;
}

export type SparkReproRequirement =
  | SparkReproEvidenceRequirement
  | SparkReproDecisionRequirement
  | SparkReproValidationRequirement;

/** @deprecated Use SparkReproRequirement. */
export type SparkReproAcceptanceCondition = SparkReproRequirement;

export type SparkReproRequirementProof =
  | { kind: "evidence"; evidenceRefs: ArtifactRef[] }
  | { kind: "decision"; decisionRef: ArtifactRef; selectedValue: string; rationale?: string }
  | { kind: "validation"; command: string; resultRef: ArtifactRef; passed: boolean };

export interface SparkReproGateEvaluation {
  passed: boolean;
  blockers: string[];
  evidenceRefs: ArtifactRef[];
  evaluatedAt: string;
}

export interface SparkReproGate {
  id: string;
  description: string;
  evaluation?: SparkReproGateEvaluation;
}

export interface SparkReproStage {
  name: SparkReproStageName;
  title: string;
  phases: SparkSessionPhase[];
  acceptance: SparkReproRequirement[];
  gate?: SparkReproGate;
}

export type SparkReproStatus = "active" | "complete";

export interface SparkSessionReproRetryState {
  consecutiveFailures: number;
  lastFailureAt?: string;
  nextDelayMs?: number;
}

export interface SparkSessionRepro {
  version: 3;
  reproId: string;
  sessionKey: string;
  status: SparkReproStatus;
  objective?: string;
  currentStageIndex: number;
  currentPhase: SparkSessionPhase;
  stages: SparkReproStage[];
  retryState?: SparkSessionReproRetryState;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export const DEFAULT_REPRO_STAGES: SparkReproStage[] = [
  {
    name: "setup",
    title: "Setup",
    phases: ["plan"],
    acceptance: [
      evidenceRequirement(
        "repro-contract-frozen",
        "Reproduction claim and acceptance contract frozen",
        "plan",
      ),
      evidenceRequirement(
        "competitor-baseline-availability-researched",
        "Runnable competitor/reference baseline availability verified (typically Megatron)",
        "plan",
      ),
      decisionRequirement(
        "baseline-construction-strategy-approved",
        "Reuse existing baseline or construction approach approved by the user",
        "plan",
      ),
      evidenceRequirement(
        "implementation-landscape-researched",
        "Reusable implementation and extension boundaries researched",
        "plan",
      ),
      evidenceRequirement(
        "alignment-paths-researched",
        "Real-module and eager alignment paths compared",
        "plan",
      ),
      decisionRequirement(
        "implementation-strategy-approved",
        "Reuse, adapt, or new implementation strategy approved by the user",
        "plan",
      ),
      decisionRequirement(
        "alignment-strategy-approved",
        "Real-module or eager alignment strategy approved by the user",
        "plan",
      ),
      validationRequirement(
        "baseline-probe-passed",
        "Minimum baseline comparison probe passed against an available or user-approved constructed baseline",
        "plan",
      ),
    ],
  },
  {
    name: "scaffold",
    title: "Scaffold",
    phases: ["implement"],
    acceptance: [
      evidenceRequirement("project-structure-created", "Project structure created", "implement"),
      validationRequirement(
        "dependencies-buildable",
        "Dependencies installed and buildable",
        "implement",
      ),
    ],
  },
  {
    name: "reproduce",
    title: "Reproduce",
    phases: ["implement"],
    acceptance: [
      validationRequirement(
        "bitwise-pass-20",
        "20+ step BITWISE_PASS reproduction achieved",
        "implement",
      ),
      validationRequirement("bitwise-pass-100", "100-step BITWISE_PASS verified", "implement"),
    ],
    gate: {
      id: "gate-A",
      description: "20+100 step BITWISE_PASS achieved",
    },
  },
  {
    name: "scale",
    title: "Scale",
    phases: ["implement"],
    acceptance: [
      validationRequirement(
        "target-scale-convergence",
        "Convergence verified at target scale",
        "implement",
      ),
      validationRequirement("performance-budget", "Performance metrics within budget", "implement"),
    ],
    gate: {
      id: "gate-B",
      description: "Convergence verified at scale",
    },
  },
  {
    name: "deliver",
    title: "Deliver",
    phases: ["implement"],
    acceptance: [
      evidenceRequirement("pr-submitted", "PR submitted", "implement"),
      validationRequirement("no-runtime-patches", "No runtime patches remain", "implement"),
    ],
    gate: {
      id: "gate-C",
      description: "PR submitted, no runtime patch",
    },
  },
];

export function currentReproStage(repro: SparkSessionRepro): SparkReproStage {
  const stage = repro.stages[repro.currentStageIndex];
  if (!stage) throw new Error(`repro stage index is out of range: ${repro.currentStageIndex}`);
  return stage;
}

export function currentPhaseAcceptance(repro: SparkSessionRepro): SparkReproRequirement[] {
  return currentReproStage(repro).acceptance.filter(
    (requirement) => requirement.phase === repro.currentPhase,
  );
}

export function isReproRequirementSatisfied(requirement: SparkReproRequirement): boolean {
  switch (requirement.kind) {
    case "evidence":
      return requirement.evidenceRefs.length > 0;
    case "decision":
      return Boolean(requirement.decisionRef && requirement.selectedValue?.trim());
    case "validation":
      return Boolean(
        requirement.command?.trim() && requirement.resultRef && requirement.passed === true,
      );
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

export function reproRequirementBlockers(requirement: SparkReproRequirement): string[] {
  if (isReproRequirementSatisfied(requirement)) return [];
  switch (requirement.kind) {
    case "evidence":
      return [`${requirement.id} has no evidence artifact`];
    case "decision":
      return [`${requirement.id} has no recorded user decision`];
    case "validation":
      return [
        `${requirement.id} requires a command, result artifact, and passing validation result`,
      ];
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

export function isPhaseComplete(repro: SparkSessionRepro, phase?: SparkSessionPhase): boolean {
  const targetPhase = phase ?? repro.currentPhase;
  const requirements = currentReproStage(repro).acceptance.filter(
    (requirement) => requirement.phase === targetPhase,
  );
  return requirements.length > 0 && requirements.every(isReproRequirementSatisfied);
}

export function isStageAcceptanceMet(repro: SparkSessionRepro): boolean {
  return currentReproStage(repro).acceptance.every(isReproRequirementSatisfied);
}

export function isStageGatePassed(repro: SparkSessionRepro): boolean {
  const gate = currentReproStage(repro).gate;
  return gate ? gate.evaluation?.passed === true : true;
}

export function isStageComplete(repro: SparkSessionRepro): boolean {
  return isStageAcceptanceMet(repro) && isStageGatePassed(repro);
}

export function recordReproRequirementProof(
  repro: SparkSessionRepro,
  requirementId: string,
  proof: SparkReproRequirementProof,
): SparkSessionRepro | undefined {
  const stage = currentReproStage(repro);
  const index = stage.acceptance.findIndex((requirement) => requirement.id === requirementId);
  if (index < 0) return undefined;
  const current = stage.acceptance[index]!;
  if (current.kind !== proof.kind) {
    throw new Error(
      `repro requirement ${requirementId} expects ${current.kind} proof, received ${proof.kind}`,
    );
  }

  const acceptance = [...stage.acceptance];
  acceptance[index] = requirementWithProof(current, proof);
  const stages = [...repro.stages];
  stages[repro.currentStageIndex] = {
    ...stage,
    acceptance,
    ...(stage.gate ? { gate: { id: stage.gate.id, description: stage.gate.description } } : {}),
  };
  return { ...repro, stages, updatedAt: nowIso() };
}

/**
 * Compatibility helper for legacy callers. It now accepts only evidence
 * requirements and refuses empty evidence instead of writing a satisfied flag.
 */
export function satisfyAcceptanceCondition(
  repro: SparkSessionRepro,
  conditionIdOrDescription: string,
  evidenceRef?: string,
): SparkSessionRepro | undefined {
  if (!evidenceRef) return undefined;
  const requirement = currentReproStage(repro).acceptance.find(
    (candidate) =>
      candidate.id === conditionIdOrDescription ||
      candidate.description === conditionIdOrDescription,
  );
  if (!requirement || requirement.kind !== "evidence") return undefined;
  return recordReproRequirementProof(repro, requirement.id, {
    kind: "evidence",
    evidenceRefs: [artifactRef(evidenceRef, "evidenceRef")],
  });
}

export interface SparkReproGateEvaluationResult {
  repro: SparkSessionRepro;
  passed: boolean;
  blockers: string[];
}

export function evaluateStageGate(repro: SparkSessionRepro): SparkReproGateEvaluationResult {
  const stage = currentReproStage(repro);
  if (!stage.gate) return { repro, passed: true, blockers: [] };
  const blockers = stage.acceptance.flatMap(reproRequirementBlockers);
  const evaluation: SparkReproGateEvaluation = {
    passed: blockers.length === 0,
    blockers,
    evidenceRefs: stage.acceptance.flatMap(reproRequirementEvidenceRefs),
    evaluatedAt: nowIso(),
  };
  const stages = [...repro.stages];
  stages[repro.currentStageIndex] = { ...stage, gate: { ...stage.gate, evaluation } };
  return {
    repro: { ...repro, stages, updatedAt: evaluation.evaluatedAt },
    passed: evaluation.passed,
    blockers,
  };
}

/** @deprecated Use evaluateStageGate; this no longer force-passes a gate. */
export function passStageGate(repro: SparkSessionRepro): SparkSessionRepro | undefined {
  if (!currentReproStage(repro).gate) return undefined;
  const evaluated = evaluateStageGate(repro);
  return evaluated.passed ? evaluated.repro : undefined;
}

export function advanceReproPhase(repro: SparkSessionRepro): SparkSessionRepro | undefined {
  const stage = currentReproStage(repro);
  const currentPhaseIndex = stage.phases.indexOf(repro.currentPhase);
  if (currentPhaseIndex < 0 || !isPhaseComplete(repro)) return undefined;
  const nextPhase = stage.phases[currentPhaseIndex + 1];
  return nextPhase ? { ...repro, currentPhase: nextPhase, updatedAt: nowIso() } : undefined;
}

export function advanceReproStage(repro: SparkSessionRepro): SparkSessionRepro | undefined {
  if (!isStageComplete(repro)) return undefined;
  const nextStage = repro.stages[repro.currentStageIndex + 1];
  if (!nextStage) {
    const completedAt = nowIso();
    return { ...repro, status: "complete", completedAt, updatedAt: completedAt };
  }
  return {
    ...repro,
    currentStageIndex: repro.currentStageIndex + 1,
    currentPhase: nextStage.phases[0]!,
    updatedAt: nowIso(),
  };
}

export function createSparkSessionRepro(
  sessionKey: string,
  stages?: SparkReproStage[],
  options: { objective?: string } = {},
): SparkSessionRepro {
  const resolvedStages = structuredClone(stages ?? DEFAULT_REPRO_STAGES);
  const firstPhase = resolvedStages[0]?.phases[0];
  if (!firstPhase) throw new Error("repro requires at least one stage with one phase");
  const objective = options.objective?.trim();
  const timestamp = nowIso();
  return {
    version: 3,
    reproId: crypto.randomUUID?.() ?? `repro-${Date.now()}`,
    sessionKey,
    status: "active",
    ...(objective ? { objective } : {}),
    currentStageIndex: 0,
    currentPhase: firstPhase,
    stages: resolvedStages,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function isReproComplete(repro: SparkSessionRepro): boolean {
  return repro.status === "complete";
}

export function reproRequirementEvidenceRefs(requirement: SparkReproRequirement): ArtifactRef[] {
  switch (requirement.kind) {
    case "evidence":
      return requirement.evidenceRefs;
    case "decision":
      return requirement.decisionRef ? [requirement.decisionRef] : [];
    case "validation":
      return requirement.resultRef ? [requirement.resultRef] : [];
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

function evidenceRequirement(
  id: string,
  description: string,
  phase: SparkSessionPhase,
): SparkReproEvidenceRequirement {
  return { id, kind: "evidence", description, phase, evidenceRefs: [] };
}

function decisionRequirement(
  id: string,
  description: string,
  phase: SparkSessionPhase,
): SparkReproDecisionRequirement {
  return { id, kind: "decision", description, phase };
}

function validationRequirement(
  id: string,
  description: string,
  phase: SparkSessionPhase,
): SparkReproValidationRequirement {
  return { id, kind: "validation", description, phase };
}

function requirementWithProof(
  requirement: SparkReproRequirement,
  proof: SparkReproRequirementProof,
): SparkReproRequirement {
  switch (proof.kind) {
    case "evidence":
      if (requirement.kind !== "evidence") return requirement;
      if (proof.evidenceRefs.length === 0) throw new Error("evidence proof requires evidenceRefs");
      return {
        ...requirement,
        evidenceRefs: uniqueArtifactRefs([...requirement.evidenceRefs, ...proof.evidenceRefs]),
      };
    case "decision":
      if (requirement.kind !== "decision") return requirement;
      return {
        ...requirement,
        decisionRef: artifactRef(proof.decisionRef, "decisionRef"),
        selectedValue: nonEmpty(proof.selectedValue, "selectedValue"),
        ...(proof.rationale?.trim() ? { rationale: proof.rationale.trim() } : {}),
      };
    case "validation":
      if (requirement.kind !== "validation") return requirement;
      return {
        ...requirement,
        command: nonEmpty(proof.command, "command"),
        resultRef: artifactRef(proof.resultRef, "resultRef"),
        passed: proof.passed,
      };
    default: {
      const exhaustive: never = proof;
      return exhaustive;
    }
  }
}

function uniqueArtifactRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...new Set(refs.map((ref, index) => artifactRef(ref, `evidenceRefs[${index}]`)))];
}

function artifactRef(value: string, field: string): ArtifactRef {
  if (!value.startsWith("artifact:") || value.length === "artifact:".length) {
    throw new Error(`${field} must be an artifact: ref`);
  }
  return value as ArtifactRef;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}
