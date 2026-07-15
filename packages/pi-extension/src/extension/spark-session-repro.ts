/**
 * SparkSessionRepro — 5-stage linear state machine for milestone-driven reproduction workflow.
 *
 * Stages: setup → scaffold → reproduce → scale → deliver
 * Each stage declares ordered phases and optional acceptance gates.
 * Phase auto-advances within a stage when current-phase acceptance is satisfied.
 */

import { nowIso } from "@zendev-lab/spark-extension-api";
import { readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import { rebuildSessionIndex, sessionReproStorePathV2 } from "./session-directory-store.ts";
import type { SparkSessionContext } from "./session-identity.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SparkSessionPhase = "plan" | "implement";

export type SparkReproStageName = "setup" | "scaffold" | "reproduce" | "scale" | "deliver";

export interface SparkReproAcceptanceCondition {
  /** Human-readable description of what must be true. */
  description: string;
  /** Phase this condition applies to. */
  phase: SparkSessionPhase;
  /** Whether this condition is currently satisfied. */
  satisfied: boolean;
  /** Optional evidence ref backing satisfaction. */
  evidenceRef?: string;
}

export interface SparkReproGate {
  /** Gate identifier (e.g., "gate-A", "gate-B", "gate-C"). */
  id: string;
  /** Human-readable gate description. */
  description: string;
  /** Whether the gate has been passed. */
  passed: boolean;
  /** When the gate was passed. */
  passedAt?: string;
}

export interface SparkReproStage {
  /** Stage name — unique within the stage list. */
  name: SparkReproStageName;
  /** Human-readable title. */
  title: string;
  /** Ordered phases within this stage. */
  phases: SparkSessionPhase[];
  /** Acceptance conditions grouped by phase. */
  acceptance: SparkReproAcceptanceCondition[];
  /** Optional deterministic gate at stage completion. */
  gate?: SparkReproGate;
}

export type SparkReproStatus = "active" | "complete";

export interface SparkSessionReproRetryState {
  consecutiveFailures: number;
  lastFailureAt?: string;
  nextDelayMs?: number;
}

export interface SparkSessionRepro {
  version: 2;
  reproId: string;
  sessionKey: string;
  status: SparkReproStatus;
  /** User-supplied reproduction objective/focus, when started from /repro <prompt>. */
  objective?: string;
  /** Index into stages array for the current stage. */
  currentStageIndex: number;
  /** Current phase within the current stage. */
  currentPhase: SparkSessionPhase;
  /** The full stage configuration. */
  stages: SparkReproStage[];
  /** Foreground tick retry accounting. */
  retryState?: SparkSessionReproRetryState;
  /** When repro was started. */
  createdAt: string;
  /** Last modification timestamp. */
  updatedAt: string;
  /** When repro completed (all stages passed). */
  completedAt?: string;
}

interface SparkSessionReproSnapshot {
  version: 2;
  repro?: SparkSessionRepro;
  [key: string]: unknown;
}

interface StoredSparkSessionRepro extends Omit<
  SparkSessionRepro,
  "version" | "currentPhase" | "stages"
> {
  version: 1 | 2;
  currentPhase: SparkSessionPhase | "research";
  stages: Array<
    Omit<SparkReproStage, "phases" | "acceptance"> & {
      phases: Array<SparkSessionPhase | "research">;
      acceptance: Array<
        Omit<SparkReproAcceptanceCondition, "phase"> & {
          phase: SparkSessionPhase | "research";
        }
      >;
    }
  >;
}

interface StoredSparkSessionReproSnapshot {
  version: 1 | 2;
  repro?: StoredSparkSessionRepro;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Default Stages Template
// ---------------------------------------------------------------------------

export const DEFAULT_REPRO_STAGES: SparkReproStage[] = [
  {
    name: "setup",
    title: "Setup",
    phases: ["plan"],
    acceptance: [
      { description: "Problem statement documented", phase: "plan", satisfied: false },
      { description: "Reproduction strategy planned", phase: "plan", satisfied: false },
    ],
  },
  {
    name: "scaffold",
    title: "Scaffold",
    phases: ["implement"],
    acceptance: [
      { description: "Project structure created", phase: "implement", satisfied: false },
      { description: "Dependencies installed and buildable", phase: "implement", satisfied: false },
    ],
  },
  {
    name: "reproduce",
    title: "Reproduce",
    phases: ["implement"],
    acceptance: [
      {
        description: "20+ step BITWISE_PASS reproduction achieved",
        phase: "implement",
        satisfied: false,
      },
      {
        description: "100-step BITWISE_PASS verified",
        phase: "implement",
        satisfied: false,
      },
    ],
    gate: {
      id: "gate-A",
      description: "20+100 step BITWISE_PASS achieved",
      passed: false,
    },
  },
  {
    name: "scale",
    title: "Scale",
    phases: ["implement"],
    acceptance: [
      { description: "Convergence verified at target scale", phase: "implement", satisfied: false },
      { description: "Performance metrics within budget", phase: "implement", satisfied: false },
    ],
    gate: {
      id: "gate-B",
      description: "Convergence verified at scale",
      passed: false,
    },
  },
  {
    name: "deliver",
    title: "Deliver",
    phases: ["implement"],
    acceptance: [
      { description: "PR submitted", phase: "implement", satisfied: false },
      { description: "No runtime patches remain", phase: "implement", satisfied: false },
    ],
    gate: {
      id: "gate-C",
      description: "PR submitted, no runtime patch",
      passed: false,
    },
  },
];

// ---------------------------------------------------------------------------
// State Machine Logic
// ---------------------------------------------------------------------------

/** Get the current stage from a repro state. */
export function currentReproStage(repro: SparkSessionRepro): SparkReproStage {
  return repro.stages[repro.currentStageIndex];
}

/** Get acceptance conditions for the current phase in the current stage. */
export function currentPhaseAcceptance(repro: SparkSessionRepro): SparkReproAcceptanceCondition[] {
  const stage = currentReproStage(repro);
  return stage.acceptance.filter((c) => c.phase === repro.currentPhase);
}

/** Check if all acceptance conditions for a given phase in the current stage are satisfied. */
export function isPhaseComplete(repro: SparkSessionRepro, phase?: SparkSessionPhase): boolean {
  const stage = currentReproStage(repro);
  const targetPhase = phase ?? repro.currentPhase;
  const conditions = stage.acceptance.filter((c) => c.phase === targetPhase);
  return conditions.length > 0 && conditions.every((c) => c.satisfied);
}

/** Check if all acceptance conditions in the current stage are satisfied. */
export function isStageAcceptanceMet(repro: SparkSessionRepro): boolean {
  const stage = currentReproStage(repro);
  return stage.acceptance.every((c) => c.satisfied);
}

/** Check if the stage gate (if any) is passed. */
export function isStageGatePassed(repro: SparkSessionRepro): boolean {
  const stage = currentReproStage(repro);
  if (!stage.gate) return true; // No gate means auto-pass
  return stage.gate.passed;
}

/** Check if the current stage is fully complete (acceptance + gate). */
export function isStageComplete(repro: SparkSessionRepro): boolean {
  return isStageAcceptanceMet(repro) && isStageGatePassed(repro);
}

/**
 * Advance the phase within the current stage.
 * Returns the updated repro state if phase advances, or undefined if no advance possible.
 */
export function advanceReproPhase(repro: SparkSessionRepro): SparkSessionRepro | undefined {
  const stage = currentReproStage(repro);
  const currentPhaseIndex = stage.phases.indexOf(repro.currentPhase);
  if (currentPhaseIndex < 0) return undefined;

  // Check if current phase acceptance is met
  if (!isPhaseComplete(repro)) return undefined;

  // Try to advance to next phase in stage
  const nextPhaseIndex = currentPhaseIndex + 1;
  if (nextPhaseIndex >= stage.phases.length) return undefined; // At last phase in stage

  return {
    ...repro,
    currentPhase: stage.phases[nextPhaseIndex],
    updatedAt: nowIso(),
  };
}

/**
 * Advance to the next stage.
 * Returns the updated repro state if stage advances, or undefined if at the last stage or stage not complete.
 */
export function advanceReproStage(repro: SparkSessionRepro): SparkSessionRepro | undefined {
  if (!isStageComplete(repro)) return undefined;

  const nextStageIndex = repro.currentStageIndex + 1;
  if (nextStageIndex >= repro.stages.length) {
    // All stages complete — mark repro as complete
    return {
      ...repro,
      status: "complete",
      completedAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  const nextStage = repro.stages[nextStageIndex];
  return {
    ...repro,
    currentStageIndex: nextStageIndex,
    currentPhase: nextStage.phases[0],
    updatedAt: nowIso(),
  };
}

/**
 * Mark an acceptance condition as satisfied.
 * Returns updated repro or undefined if condition not found.
 */
export function satisfyAcceptanceCondition(
  repro: SparkSessionRepro,
  conditionDescription: string,
  evidenceRef?: string,
): SparkSessionRepro | undefined {
  const stage = currentReproStage(repro);
  const conditionIndex = stage.acceptance.findIndex((c) => c.description === conditionDescription);
  if (conditionIndex < 0) return undefined;

  const updatedAcceptance = [...stage.acceptance];
  updatedAcceptance[conditionIndex] = {
    ...updatedAcceptance[conditionIndex],
    satisfied: true,
    ...(evidenceRef ? { evidenceRef } : {}),
  };

  const updatedStages = [...repro.stages];
  updatedStages[repro.currentStageIndex] = { ...stage, acceptance: updatedAcceptance };

  return {
    ...repro,
    stages: updatedStages,
    updatedAt: nowIso(),
  };
}

/**
 * Mark the current stage's gate as passed.
 */
export function passStageGate(repro: SparkSessionRepro): SparkSessionRepro | undefined {
  const stage = currentReproStage(repro);
  if (!stage.gate) return undefined;
  if (stage.gate.passed) return repro; // Already passed

  const updatedStages = [...repro.stages];
  updatedStages[repro.currentStageIndex] = {
    ...stage,
    gate: { ...stage.gate, passed: true, passedAt: nowIso() },
  };

  return {
    ...repro,
    stages: updatedStages,
    updatedAt: nowIso(),
  };
}

/**
 * Create a new SparkSessionRepro with default stages.
 */
export function createSparkSessionRepro(
  sessionKey: string,
  stages?: SparkReproStage[],
  options: { objective?: string } = {},
): SparkSessionRepro {
  const resolvedStages = stages ?? structuredClone(DEFAULT_REPRO_STAGES);
  const reproId = crypto.randomUUID?.() ?? `repro-${Date.now()}`;
  const objective = options.objective?.trim();
  return {
    version: 2,
    reproId,
    sessionKey,
    status: "active",
    ...(objective ? { objective } : {}),
    currentStageIndex: 0,
    currentPhase: resolvedStages[0].phases[0],
    stages: resolvedStages,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function sessionReproStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return sessionReproStorePathV2(cwd, ctx);
}

export async function readSessionRepro(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionRepro | undefined> {
  const path = sessionReproStorePath(cwd, ctx);
  const snapshot = await readJsonFileOptional<StoredSparkSessionReproSnapshot>(path);
  if (!snapshot || (snapshot.version !== 1 && snapshot.version !== 2)) return undefined;
  const repro = snapshot.repro ? normalizeReproPhases(snapshot.repro) : undefined;
  if (snapshot.version === 1 || snapshot.repro?.version === 1) {
    await writeJsonFileAtomic(path, { version: 2, repro } satisfies SparkSessionReproSnapshot);
    await rebuildSessionIndex(cwd);
  }
  return repro;
}

export async function writeSessionRepro(
  cwd: string,
  repro: SparkSessionRepro | undefined,
  ctx?: SparkSessionContext,
): Promise<void> {
  const path = sessionReproStorePath(cwd, ctx);
  const snapshot: SparkSessionReproSnapshot = { version: 2, repro };
  await writeJsonFileAtomic(path, snapshot);
  await rebuildSessionIndex(cwd);
}

function normalizeReproPhases(repro: StoredSparkSessionRepro): SparkSessionRepro {
  const normalizePhase = (phase: SparkSessionPhase | "research"): SparkSessionPhase =>
    phase === "research" ? "plan" : phase;
  return {
    ...repro,
    version: 2,
    currentPhase: normalizePhase(repro.currentPhase),
    stages: repro.stages.map((stage) => ({
      ...stage,
      phases: [...new Set(stage.phases.map(normalizePhase))],
      acceptance: stage.acceptance.map((condition) => ({
        ...condition,
        phase: normalizePhase(condition.phase),
      })),
    })),
  };
}

export async function clearSessionRepro(cwd: string, ctx?: SparkSessionContext): Promise<void> {
  await writeSessionRepro(cwd, undefined, ctx);
}

/** True when the repro drive has advanced through every stage. */
export function isReproComplete(repro: SparkSessionRepro): boolean {
  return repro.status === "complete";
}

/**
 * Update the active repro's foreground retry accounting.
 * Returns the updated repro, or undefined when the id no longer matches an active repro.
 */
export async function updateSessionReproRetryState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  retryState: SparkSessionReproRetryState | null,
  options: { expectedReproId?: string } = {},
): Promise<SparkSessionRepro | undefined> {
  const existing = await readSessionRepro(cwd, ctx);
  if (!existing || existing.status !== "active") return undefined;
  if (options.expectedReproId && existing.reproId !== options.expectedReproId) return undefined;
  const updated: SparkSessionRepro = {
    ...existing,
    retryState: retryState ?? undefined,
    updatedAt: nowIso(),
  };
  await writeSessionRepro(cwd, updated, ctx);
  return updated;
}
