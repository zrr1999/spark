/**
 * Persistence adapter for the host-neutral @zendev-lab/spark-repro state machine.
 * Legacy v1/v2 snapshots are migrated fail-closed into evidence-backed v3 requirements.
 */

import type { EvidenceRef } from "@zendev-lab/spark-core";
import {
  DEFAULT_REPRO_STAGES,
  isReproRequirementSatisfied,
  type SparkReproRequirement,
  type SparkReproStage,
  type SparkSessionPhase,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import {
  rebuildSessionIndex,
  sessionReproStorePathV2,
  type SparkSessionContext,
} from "@zendev-lab/spark-loop";
import { readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";

export * from "@zendev-lab/spark-repro";

interface SparkSessionReproSnapshotV3 {
  version: 3;
  repro?: SparkSessionRepro;
  [key: string]: unknown;
}

interface LegacySparkReproAcceptanceCondition {
  description: string;
  phase: SparkSessionPhase | "research";
  satisfied: boolean;
  evidenceRef?: string;
}

interface LegacySparkReproGate {
  id: string;
  description: string;
  passed: boolean;
  passedAt?: string;
}

interface LegacySparkReproStage {
  name: SparkReproStage["name"];
  title: string;
  phases: Array<SparkSessionPhase | "research">;
  acceptance: LegacySparkReproAcceptanceCondition[];
  gate?: LegacySparkReproGate;
}

interface LegacySparkSessionRepro extends Omit<
  SparkSessionRepro,
  "version" | "currentPhase" | "stages"
> {
  version: 1 | 2;
  currentPhase: SparkSessionPhase | "research";
  stages: LegacySparkReproStage[];
}

interface LegacySparkSessionReproSnapshot {
  version: 1 | 2;
  repro?: LegacySparkSessionRepro;
  [key: string]: unknown;
}

type StoredSparkSessionReproSnapshot =
  | SparkSessionReproSnapshotV3
  | LegacySparkSessionReproSnapshot;

export function sessionReproStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return sessionReproStorePathV2(cwd, ctx);
}

export async function readSessionRepro(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionRepro | undefined> {
  const path = sessionReproStorePath(cwd, ctx);
  const snapshot = await readJsonFileOptional<StoredSparkSessionReproSnapshot>(path);
  if (!snapshot) return undefined;
  if (snapshot.version === 3) {
    const repro = sanitizeStoredSessionRepro(snapshot.repro);
    if (JSON.stringify(repro) !== JSON.stringify(snapshot.repro)) {
      await writeJsonFileAtomic(path, { version: 3, repro } satisfies SparkSessionReproSnapshotV3);
      await rebuildSessionIndex(cwd);
    }
    return repro;
  }
  if (snapshot.version !== 1 && snapshot.version !== 2) return undefined;

  const repro = snapshot.repro ? migrateLegacySessionRepro(snapshot.repro) : undefined;
  await writeJsonFileAtomic(path, { version: 3, repro } satisfies SparkSessionReproSnapshotV3);
  await rebuildSessionIndex(cwd);
  return repro;
}

export async function writeSessionRepro(
  cwd: string,
  repro: SparkSessionRepro | undefined,
  ctx?: SparkSessionContext,
): Promise<void> {
  const path = sessionReproStorePath(cwd, ctx);
  const snapshot: SparkSessionReproSnapshotV3 = {
    version: 3,
    repro: repro ? withoutReproRuntimeState(repro) : undefined,
  };
  await writeJsonFileAtomic(path, snapshot);
  await rebuildSessionIndex(cwd);
}

function withoutReproRuntimeState(repro: SparkSessionRepro): SparkSessionRepro {
  const { retryState: _retryState, ...canonical } = repro as SparkSessionRepro & {
    retryState?: unknown;
  };
  return canonical;
}

export async function clearSessionRepro(cwd: string, ctx?: SparkSessionContext): Promise<void> {
  await writeSessionRepro(cwd, undefined, ctx);
}

function migrateLegacySessionRepro(legacy: LegacySparkSessionRepro): SparkSessionRepro {
  const defaultStages = structuredClone(DEFAULT_REPRO_STAGES);
  const stages = defaultStages.map((template) => {
    const legacyStage = legacy.stages.find((stage) => stage.name === template.name);
    return legacyStage ? migrateLegacyStage(legacyStage, template) : template;
  });
  const legacyStageIndex = Math.min(
    Math.max(0, legacy.currentStageIndex),
    Math.max(0, stages.length - 1),
  );
  const firstIncompleteStageIndex = stages.findIndex((stage) => !isMigratedStageComplete(stage));
  const mustReopen = legacy.status === "complete" && firstIncompleteStageIndex >= 0;
  const currentStageIndex = mustReopen ? firstIncompleteStageIndex : legacyStageIndex;
  const activeStage = stages[currentStageIndex]!;
  const normalizedPhase = normalizeLegacyPhase(legacy.currentPhase);
  const currentPhase = activeStage.phases.includes(normalizedPhase)
    ? normalizedPhase
    : activeStage.phases[0]!;
  const { completedAt, ...legacyWithoutCompletion } = legacy;
  return {
    ...legacyWithoutCompletion,
    version: 3,
    status: mustReopen ? "active" : legacy.status,
    currentStageIndex,
    currentPhase,
    stages,
    ...(!mustReopen && completedAt ? { completedAt } : {}),
  };
}

function isMigratedStageComplete(stage: SparkReproStage): boolean {
  return (
    stage.acceptance.every(isReproRequirementSatisfied) &&
    (!stage.gate || stage.gate.evaluation?.passed === true)
  );
}

function migrateLegacyStage(
  legacy: LegacySparkReproStage,
  template: SparkReproStage,
): SparkReproStage {
  const acceptance = template.acceptance.map((requirement) =>
    migrateLegacyRequirement(requirement, legacy.acceptance),
  );
  return {
    ...template,
    title: legacy.title || template.title,
    acceptance,
    ...(template.gate
      ? { gate: { id: template.gate.id, description: template.gate.description } }
      : {}),
  };
}

function migrateLegacyRequirement(
  requirement: SparkReproRequirement,
  legacyAcceptance: readonly LegacySparkReproAcceptanceCondition[],
): SparkReproRequirement {
  const legacyDescriptions = legacyDescriptionsFor(requirement.id, requirement.description);
  const legacy = legacyAcceptance.find((candidate) =>
    legacyDescriptions.includes(candidate.description),
  );
  const evidenceRef = legacy?.satisfied ? legacyEvidenceRef(legacy.evidenceRef) : undefined;
  if (!evidenceRef) return requirement;
  switch (requirement.kind) {
    case "evidence":
      return { ...requirement, evidenceRefs: [evidenceRef] };
    case "validation":
      // Preserve the old pointer for inspection, but do not certify a missing
      // command or pass result during migration.
      return { ...requirement, resultRef: evidenceRef };
    case "decision":
      // A legacy agent-authored strategy condition is not a user decision.
      return requirement;
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

function legacyDescriptionsFor(id: string, description: string): string[] {
  switch (id) {
    case "repro-contract-frozen":
      return [description, "Problem statement documented"];
    case "project-structure-created":
      return [description, "Project structure created"];
    case "dependencies-buildable":
      return [description, "Dependencies installed and buildable"];
    case "bitwise-pass-20":
      return [description, "20+ step BITWISE_PASS reproduction achieved"];
    case "bitwise-pass-100":
      return [description, "100-step BITWISE_PASS verified"];
    case "target-scale-convergence":
      return [description, "Convergence verified at target scale"];
    case "performance-budget":
      return [description, "Performance metrics within budget"];
    case "pr-submitted":
      return [description, "PR submitted"];
    case "no-runtime-patches":
      return [description, "No runtime patches remain"];
    default:
      return [description];
  }
}

function normalizeLegacyPhase(phase: SparkSessionPhase | "research"): SparkSessionPhase {
  return phase === "research" ? "plan" : phase;
}

function legacyEvidenceRef(value: string | undefined): EvidenceRef | undefined {
  return value?.startsWith("evidence:") && value.length > "evidence:".length
    ? (value as EvidenceRef)
    : undefined;
}

function sanitizeStoredSessionRepro(
  repro: SparkSessionRepro | undefined,
): SparkSessionRepro | undefined {
  if (!repro) return undefined;
  return {
    ...repro,
    stages: repro.stages.map((stage) => {
      let invalidProofRemoved = false;
      const acceptance = stage.acceptance.map((requirement): SparkReproRequirement => {
        if (requirement.kind === "evidence") {
          const evidenceRefs = requirement.evidenceRefs.filter(isEvidenceRef);
          invalidProofRemoved ||= evidenceRefs.length !== requirement.evidenceRefs.length;
          return { ...requirement, evidenceRefs };
        }
        if (
          requirement.kind === "decision" &&
          requirement.decisionRef &&
          !isEvidenceRef(requirement.decisionRef)
        ) {
          invalidProofRemoved = true;
          const {
            decisionRef: _decisionRef,
            selectedValue: _selectedValue,
            rationale: _rationale,
            ...pending
          } = requirement;
          return pending;
        }
        if (
          requirement.kind === "validation" &&
          requirement.resultRef &&
          !isEvidenceRef(requirement.resultRef)
        ) {
          invalidProofRemoved = true;
          const { resultRef: _resultRef, passed: _passed, ...pending } = requirement;
          return pending;
        }
        return requirement;
      });
      if (!stage.gate) return { ...stage, acceptance };
      const gateHasLegacyRefs = stage.gate.evaluation?.evidenceRefs.some(
        (ref) => !isEvidenceRef(ref),
      );
      if (!invalidProofRemoved && !gateHasLegacyRefs) return { ...stage, acceptance };
      const { evaluation: _evaluation, ...gate } = stage.gate;
      return { ...stage, acceptance, gate };
    }),
  };
}

function isEvidenceRef(value: string): value is EvidenceRef {
  return value.startsWith("evidence:") && value.length > "evidence:".length;
}
