/**
 * Spark repro tool registration — provides the `repro` tool for managing
 * the milestone-driven reproduction workflow drive.
 */

import { Type } from "typebox";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import {
  createSparkSessionRepro,
  readSessionRepro,
  writeSessionRepro,
  currentReproStage,
  currentPhaseAcceptance,
  isPhaseComplete,
  isStageComplete,
  advanceReproPhase,
  advanceReproStage,
  satisfyAcceptanceCondition,
  passStageGate,
  type SparkSessionRepro,
  type SparkReproStageName,
} from "./spark-session-repro.ts";
import { clearSessionGoal } from "./spark-session-goals.ts";
import { clearSessionLoop } from "./spark-session-loops.ts";
import { sparkSessionOwnerKey } from "./session-identity.ts";

interface SparkReproToolDeps {
  refreshSparkWidget?: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

export function registerSparkReproTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkReproToolDeps,
): void {
  registerSparkTool({
    name: "repro",
    label: "Spark Repro",
    description:
      "Manage the milestone-driven reproduction workflow. Actions: status (show current stage/phase/acceptance), start (begin repro drive), satisfy (mark acceptance condition met), gate (pass stage gate), advance (advance phase or stage), stop (clear repro drive).",
    promptGuidelines: [
      "Use repro action=status to inspect current repro stage, phase, and acceptance checklist.",
      "Use repro action=start to begin the repro drive (clears goal/loop).",
      "Use repro action=satisfy with condition= to mark acceptance conditions met.",
      "Use repro action=gate to pass the current stage's deterministic gate.",
      "Use repro action=advance to advance to next phase or stage when conditions are met.",
      "Use repro action=stop to clear the repro drive.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description: "status | start | satisfy | gate | advance | stop",
        }),
      ),
      condition: Type.Optional(
        Type.String({
          description: "Acceptance condition description to satisfy (for action=satisfy).",
        }),
      ),
      evidenceRef: Type.Optional(
        Type.String({
          description: "Optional artifact ref as evidence for condition satisfaction.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (update: { content: { type: "text"; text: string }[] }) => void,
      ctx: SparkToolContext,
    ) {
      const cwd = ctx.cwd;
      const action = normalizeReproAction(params.action);

      if (action === "status") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro) {
          return {
            content: [{ type: "text" as const, text: "No repro drive is active." }],
            details: { active: false },
          };
        }
        return reproStatusResult(repro);
      }

      if (action === "start") {
        const existing = await readSessionRepro(cwd, ctx);
        if (existing?.status === "active") {
          return {
            content: [{ type: "text" as const, text: "Repro drive is already active." }],
            details: reproDetails(existing),
          };
        }
        // Clear mutually exclusive drives
        await clearSessionGoal(cwd, ctx);
        await clearSessionLoop(cwd, ctx);
        const sessionKey = sparkSessionOwnerKey(ctx);
        const repro = createSparkSessionRepro(sessionKey);
        await writeSessionRepro(cwd, repro, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Repro drive started. Stage: ${repro.stages[0].title}, Phase: ${repro.currentPhase}`,
            },
          ],
          details: reproDetails(repro),
        };
      }

      if (action === "satisfy") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro || repro.status !== "active") {
          return {
            content: [{ type: "text" as const, text: "No active repro drive." }],
            details: {},
          };
        }
        const condition = params.condition;
        if (!condition || typeof condition !== "string") {
          return {
            content: [{ type: "text" as const, text: "condition is required for action=satisfy." }],
            details: { error: "missing_condition" },
          };
        }
        const updated = satisfyAcceptanceCondition(
          repro,
          condition,
          params.evidenceRef as string | undefined,
        );
        if (!updated) {
          return {
            content: [{ type: "text" as const, text: `Condition not found: "${condition}"` }],
            details: { error: "condition_not_found", condition },
          };
        }
        await writeSessionRepro(cwd, updated, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [{ type: "text" as const, text: `Condition satisfied: "${condition}"` }],
          details: reproDetails(updated),
        };
      }

      if (action === "gate") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro || repro.status !== "active") {
          return {
            content: [{ type: "text" as const, text: "No active repro drive." }],
            details: {},
          };
        }
        const updated = passStageGate(repro);
        if (!updated) {
          const stage = currentReproStage(repro);
          return {
            content: [
              {
                type: "text" as const,
                text: stage.gate ? "Gate already passed." : "No gate on current stage.",
              },
            ],
            details: reproDetails(repro),
          };
        }
        await writeSessionRepro(cwd, updated, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        const stage = currentReproStage(updated);
        return {
          content: [{ type: "text" as const, text: `Gate passed: ${stage.gate?.id ?? "none"}` }],
          details: reproDetails(updated),
        };
      }

      if (action === "advance") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro || repro.status !== "active") {
          return {
            content: [{ type: "text" as const, text: "No active repro drive." }],
            details: {},
          };
        }
        // Try phase advance first
        const phaseAdvanced = advanceReproPhase(repro);
        if (phaseAdvanced) {
          await writeSessionRepro(cwd, phaseAdvanced, ctx);
          await deps.refreshSparkWidget?.(cwd, ctx);
          return {
            content: [
              { type: "text" as const, text: `Phase advanced to: ${phaseAdvanced.currentPhase}` },
            ],
            details: reproDetails(phaseAdvanced),
          };
        }
        // Try stage advance
        const stageAdvanced = advanceReproStage(repro);
        if (stageAdvanced) {
          await writeSessionRepro(cwd, stageAdvanced, ctx);
          await deps.refreshSparkWidget?.(cwd, ctx);
          if (stageAdvanced.status === "complete") {
            return {
              content: [
                { type: "text" as const, text: "Repro drive complete! All stages passed." },
              ],
              details: reproDetails(stageAdvanced),
            };
          }
          const stage = currentReproStage(stageAdvanced);
          return {
            content: [
              {
                type: "text" as const,
                text: `Stage advanced to: ${stage.title} (${stage.name}), Phase: ${stageAdvanced.currentPhase}`,
              },
            ],
            details: reproDetails(stageAdvanced),
          };
        }
        // Cannot advance
        const stage = currentReproStage(repro);
        const unsatisfied = stage.acceptance.filter((c) => !c.satisfied);
        const gateBlocking = stage.gate && !stage.gate.passed;
        const reasons: string[] = [];
        if (unsatisfied.length > 0)
          reasons.push(
            `Unsatisfied conditions: ${unsatisfied.map((c) => c.description).join("; ")}`,
          );
        if (gateBlocking) reasons.push(`Gate not passed: ${stage.gate!.description}`);
        return {
          content: [{ type: "text" as const, text: `Cannot advance. ${reasons.join(". ")}` }],
          details: { ...reproDetails(repro), blockingReasons: reasons },
        };
      }

      if (action === "stop") {
        const repro = await readSessionRepro(cwd, ctx);
        if (!repro) {
          return {
            content: [{ type: "text" as const, text: "No repro drive to stop." }],
            details: {},
          };
        }
        await writeSessionRepro(cwd, undefined, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [{ type: "text" as const, text: "Repro drive stopped." }],
          details: { stopped: true },
        };
      }

      throw new Error(`Unknown repro action: ${action}`);
    },
  });
}

function normalizeReproAction(
  value: unknown,
): "status" | "start" | "satisfy" | "gate" | "advance" | "stop" {
  if (value === undefined || value === null || value === "") return "status";
  if (
    value === "status" ||
    value === "start" ||
    value === "satisfy" ||
    value === "gate" ||
    value === "advance" ||
    value === "stop"
  )
    return value;
  throw new Error("repro action must be status, start, satisfy, gate, advance, or stop");
}

function reproStatusResult(repro: SparkSessionRepro) {
  const stage = currentReproStage(repro);
  const phaseConditions = currentPhaseAcceptance(repro);
  const allConditions = stage.acceptance;

  const lines = [
    `Repro drive: ${repro.status}`,
    `Stage: ${stage.title} (${stage.name}) [${repro.currentStageIndex + 1}/${repro.stages.length}]`,
    `Phase: ${repro.currentPhase}`,
    "",
    "Acceptance checklist:",
    ...allConditions.map((c) => `  ${c.satisfied ? "✓" : "○"} [${c.phase}] ${c.description}`),
  ];

  if (stage.gate) {
    lines.push(
      "",
      `Gate: ${stage.gate.id} — ${stage.gate.passed ? "PASSED" : "PENDING"} (${stage.gate.description})`,
    );
  }

  const phaseComplete = isPhaseComplete(repro);
  const stageComplete = isStageComplete(repro);
  lines.push("", `Phase complete: ${phaseComplete}`, `Stage complete: ${stageComplete}`);

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: reproDetails(repro),
  };
}

function reproDetails(repro: SparkSessionRepro): Record<string, unknown> {
  const stage = currentReproStage(repro);
  return {
    status: repro.status,
    reproId: repro.reproId,
    currentStage: stage.name,
    currentStageIndex: repro.currentStageIndex,
    totalStages: repro.stages.length,
    currentPhase: repro.currentPhase,
    phaseComplete: isPhaseComplete(repro),
    stageComplete: isStageComplete(repro),
    gate: stage.gate ? { id: stage.gate.id, passed: stage.gate.passed } : null,
    acceptance: stage.acceptance.map((c) => ({
      description: c.description,
      phase: c.phase,
      satisfied: c.satisfied,
    })),
  };
}

/**
 * Render phase-aware tick instruction for the repro drive.
 * This is shown to the agent at each tick to guide behavior.
 */
export function renderReproTickInstruction(repro: SparkSessionRepro): string {
  const stage = currentReproStage(repro);
  const phaseConditions = currentPhaseAcceptance(repro);
  const unsatisfied = phaseConditions.filter((c) => !c.satisfied);

  const lines = [
    `Repro drive tick — Stage: ${stage.title} (${repro.currentStageIndex + 1}/${repro.stages.length}), Phase: ${repro.currentPhase}`,
    "",
    "Current phase acceptance checklist:",
    ...phaseConditions.map((c) => `  ${c.satisfied ? "✓" : "○"} ${c.description}`),
  ];

  if (unsatisfied.length > 0) {
    lines.push("", `Work toward satisfying: ${unsatisfied[0].description}`);
  } else {
    lines.push(
      "",
      "All current phase conditions satisfied. Call repro({ action: 'advance' }) to proceed.",
    );
  }

  if (stage.gate && !stage.gate.passed) {
    lines.push(
      "",
      `Stage gate (${stage.gate.id}): ${stage.gate.description} — must be passed before stage advances.`,
    );
  }

  return lines.join("\n");
}
