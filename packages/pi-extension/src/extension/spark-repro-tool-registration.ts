/**
 * Spark repro tool registration — provides the `repro` tool for managing
 * the milestone-driven reproduction workflow drive.
 */

import { Type } from "typebox";
import { nowIso } from "@zendev-lab/spark-extension-api";
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
} from "./spark-session-repro.ts";
import { clearSessionGoal } from "./spark-session-goals.ts";
import { clearSessionLoop } from "./spark-session-loops.ts";
import { sparkActiveLens } from "./spark-drive-state.ts";
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
      "Manage the milestone-driven reproduction workflow. Actions: status (show current stage/phase/acceptance), start (begin repro drive, optionally with objective), satisfy (mark acceptance condition met), gate (pass stage gate), advance (advance phase or stage), stop (clear repro drive).",
    promptGuidelines: [
      "Use repro action=status to inspect current repro stage, phase, and acceptance checklist.",
      "Use repro action=start to begin the repro drive (clears goal/loop); pass objective for user-supplied reproduction focus.",
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
      objective: Type.Optional(
        Type.String({
          description: "Optional user-supplied reproduction objective/focus for action=start.",
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
        const objective = normalizeOptionalReproObjective(params.objective);
        const existing = await readSessionRepro(cwd, ctx);
        if (existing?.status === "active") {
          const repro =
            objective && existing.objective !== objective
              ? { ...existing, objective, updatedAt: nowIso(), retryState: undefined }
              : existing;
          if (repro !== existing) await writeSessionRepro(cwd, repro, ctx);
          await deps.refreshSparkWidget?.(cwd, ctx);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  repro === existing
                    ? "Repro drive is already active."
                    : `Repro drive objective updated: ${objective}`,
              },
            ],
            details: reproDetails(repro),
          };
        }
        // Clear mutually exclusive drives
        await clearSessionGoal(cwd, ctx);
        await clearSessionLoop(cwd, ctx);
        const sessionKey = sparkSessionOwnerKey(ctx);
        const repro = createSparkSessionRepro(sessionKey, undefined, { objective });
        await writeSessionRepro(cwd, repro, ctx);
        ctx.sparkActiveLens = sparkActiveLens(repro.currentPhase, "repro");
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
          ctx.sparkActiveLens = sparkActiveLens(phaseAdvanced.currentPhase, "repro");
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
          if (stageAdvanced.status === "complete") {
            ctx.sparkActiveLens = sparkActiveLens(ctx.sparkActiveLens?.phase ?? "plan", "assist");
            await deps.refreshSparkWidget?.(cwd, ctx);
            return {
              content: [
                { type: "text" as const, text: "Repro drive complete! All stages passed." },
              ],
              details: reproDetails(stageAdvanced),
            };
          }
          ctx.sparkActiveLens = sparkActiveLens(stageAdvanced.currentPhase, "repro");
          await deps.refreshSparkWidget?.(cwd, ctx);
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
        ctx.sparkActiveLens = sparkActiveLens(ctx.sparkActiveLens?.phase ?? "plan", "assist");
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [{ type: "text" as const, text: "Repro drive stopped." }],
          details: { stopped: true },
        };
      }

      return assertNeverReproAction(action);
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

function assertNeverReproAction(_action: never): never {
  throw new Error("Unknown repro action");
}

function normalizeOptionalReproObjective(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("repro objective must be a string");
  return value.trim() || undefined;
}

function reproStatusResult(repro: SparkSessionRepro) {
  const stage = currentReproStage(repro);
  const allConditions = stage.acceptance;

  const lines = [
    `Repro drive: ${repro.status}`,
    repro.objective ? `Objective: ${repro.objective}` : undefined,
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
    content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
    details: reproDetails(repro),
  };
}

function reproDetails(repro: SparkSessionRepro): Record<string, unknown> {
  const stage = currentReproStage(repro);
  return {
    status: repro.status,
    reproId: repro.reproId,
    objective: repro.objective,
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
 * This is delivered to the agent on every foreground repro tick to drive one concrete step.
 */
export function renderReproTickInstruction(repro: SparkSessionRepro): string {
  const stage = currentReproStage(repro);
  const phaseConditions = currentPhaseAcceptance(repro);
  const unsatisfied = phaseConditions.filter((c) => !c.satisfied);
  const gateBlocking = stage.gate && !stage.gate.passed;

  const lines = [
    `Spark repro drive tick — Stage ${repro.currentStageIndex + 1}/${repro.stages.length}: ${stage.title} (${stage.name}), phase=${repro.currentPhase}.`,
    repro.objective ? `Repro objective: ${repro.objective}` : undefined,
    "",
    "Milestone-driven reproduction workflow. Stages are linear (setup → scaffold → reproduce → scale → deliver); do one concrete step per tick.",
    "",
    "Current phase acceptance checklist:",
    ...phaseConditions.map((c) => `  ${c.satisfied ? "[x]" : "[ ]"} ${c.description}`),
  ];

  if (unsatisfied.length > 0) {
    lines.push(
      "",
      `Next: make concrete progress on "${unsatisfied[0].description}", then record it with repro({ action: "satisfy", condition: "${unsatisfied[0].description}", evidenceRef? }).`,
    );
  } else if (gateBlocking) {
    lines.push(
      "",
      `All current-phase acceptance conditions are satisfied. Verify the stage gate deterministically, then call repro({ action: "gate" }) followed by repro({ action: "advance" }).`,
    );
  } else {
    lines.push(
      "",
      'All current-phase conditions are satisfied. Call repro({ action: "advance" }) to move to the next phase or stage.',
    );
  }

  if (gateBlocking) {
    lines.push(
      "",
      `Stage gate (${stage.gate!.id}): ${stage.gate!.description} — this deterministic gate must pass before the stage can advance. Do not mark it passed without real evidence.`,
    );
  }

  lines.push(
    "",
    "Repro drive requirements:",
    `- Operate in the selected phase (${repro.currentPhase}); use its tool policy for plan or implement work.`,
    "- Advance milestones with the repro tool (satisfy/gate/advance); do not silently self-certify gates.",
    "- Before ending every repro turn, leave a verifiable checkpoint. If the turn produced a coherent set of repository changes and committing is authorized and safe, create a small git commit promptly. Never include unrelated pre-existing changes.",
    "- If a safe commit is not appropriate yet, show the work completed in the turn: cite concrete artifact refs or file paths, summarize the relevant diff, report commands/tests and their results, or state the exact blocker. Do not end with only a progress claim.",
    "- If you are blocked on a human decision or an external dependency, report the blocker instead of lowering scope; use /repro stop to end the drive.",
    "- End the turn after one concrete step; the next repro tick is scheduled automatically.",
  );

  // Phase-specific guidance
  if (repro.currentPhase === "plan") {
    lines.push(
      "",
      "Plan-phase guidance:",
      "- Investigate unknowns, read code/docs, and gather evidence needed by the current stage.",
      "- Answer or record findings directly when no durable work is needed.",
      "- Create, decompose, reorder, or update project tasks only when concrete stage work needs durable planning.",
    );
  } else if (repro.currentPhase === "implement") {
    lines.push(
      "",
      "Implement-phase guidance:",
      "- Execute the planned tasks: write code, run tests, fix failures.",
      "- After completing a task, finish it and satisfy the corresponding acceptance condition.",
    );
  }

  return lines.filter((line): line is string => line !== undefined).join("\n");
}
