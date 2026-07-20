/** Spark repro tool adapter for the host-neutral reproduction contract. */

import { Type } from "typebox";
import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import { verifyCanonicalAskEvidenceArtifact } from "@zendev-lab/spark-ask";
import { nowIso, type ArtifactRef } from "@zendev-lab/spark-extension-api";
import { clearSessionGoal } from "./spark-session-goals.ts";
import { clearSessionLoop } from "./spark-session-loops.ts";
import { sparkActiveLens } from "./spark-drive-state.ts";
import {
  advanceReproPhase,
  advanceReproStage,
  createSparkSessionRepro,
  currentPhaseAcceptance,
  currentReproStage,
  evaluateStageGate,
  isPhaseComplete,
  isReproRequirementSatisfied,
  isStageComplete,
  recordReproRequirementProof,
  readSessionRepro,
  reproRequirementBlockers,
  writeSessionRepro,
  type SparkReproRequirement,
  type SparkReproRequirementProof,
  type SparkSessionRepro,
} from "./spark-session-repro.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import { sparkSessionOwnerKey } from "./session-identity.ts";

interface SparkReproToolDeps {
  refreshSparkWidget?: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

type SparkReproToolAction =
  | "status"
  | "start"
  | "record"
  | "evaluate"
  | "satisfy"
  | "gate"
  | "advance"
  | "stop";

export function registerSparkReproTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkReproToolDeps,
): void {
  registerSparkTool({
    name: "repro",
    label: "Spark Repro",
    description:
      "Manage the evidence-backed reproduction workflow. Use record to attach typed proof, evaluate to derive a stage gate, and advance only after readiness is satisfied. satisfy/gate remain fail-closed compatibility aliases.",
    promptGuidelines: [
      "Use repro action=status to inspect stable requirement ids, proof kinds, and blockers.",
      "Use repro action=start to begin the repro drive (clears goal/loop); pass objective for user-supplied reproduction focus.",
      "Use repro action=record with requirementId and a matching evidence, decision, or validation proof.",
      "Evidence and validation refs must name existing artifacts. Decision refs must name a user-answered canonical ask artifact created with recordAsEvidence=true.",
      "Use repro action=evaluate to derive the current stage gate from recorded proof; it cannot force-pass a gate.",
      "Use repro action=advance only when requirements and any derived gate are complete.",
      "Use repro action=stop to clear the repro drive.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | start | record | evaluate | advance | stop; satisfy and gate are compatibility aliases",
        }),
      ),
      requirementId: Type.Optional(
        Type.String({ description: "Stable requirement id for action=record." }),
      ),
      proof: Type.Optional(
        Type.Object({
          kind: Type.String({ description: "evidence | decision | validation" }),
          evidenceRefs: Type.Optional(Type.Array(Type.String())),
          decisionRef: Type.Optional(Type.String()),
          selectedValue: Type.Optional(Type.String()),
          rationale: Type.Optional(Type.String()),
          command: Type.Optional(Type.String()),
          resultRef: Type.Optional(Type.String()),
          passed: Type.Optional(Type.Boolean()),
        }),
      ),
      condition: Type.Optional(
        Type.String({ description: "Legacy requirement id/description for action=satisfy." }),
      ),
      evidenceRef: Type.Optional(
        Type.String({ description: "Required existing artifact ref for legacy action=satisfy." }),
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
        return repro
          ? reproStatusResult(repro)
          : {
              content: [{ type: "text" as const, text: "No repro drive is active." }],
              details: { active: false },
            };
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
        await clearSessionGoal(cwd, ctx);
        await clearSessionLoop(cwd, ctx);
        const repro = createSparkSessionRepro(sparkSessionOwnerKey(ctx), undefined, { objective });
        await writeSessionRepro(cwd, repro, ctx);
        ctx.sparkActiveLens = sparkActiveLens(repro.currentPhase, "repro");
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Repro drive started research-first. Stage: ${repro.stages[0]!.title}, Phase: ${repro.currentPhase}`,
            },
          ],
          details: reproDetails(repro),
        };
      }

      if (action === "record" || action === "satisfy") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        const requirementId =
          action === "record"
            ? normalizeRequiredString(params.requirementId, "requirementId")
            : resolveLegacyRequirementId(repro, params.condition);
        const unverifiedProof =
          action === "record"
            ? normalizeReproProof(params.proof)
            : legacyEvidenceProof(params.evidenceRef);
        const proof = await validateReproProofArtifacts(cwd, unverifiedProof);
        const updated = recordReproRequirementProof(repro, requirementId, proof);
        if (!updated) {
          return {
            content: [{ type: "text" as const, text: `Requirement not found: ${requirementId}` }],
            details: { error: "requirement_not_found", requirementId },
          };
        }
        await writeSessionRepro(cwd, updated, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Recorded ${proof.kind} proof for repro requirement: ${requirementId}`,
            },
          ],
          details: reproDetails(updated),
        };
      }

      if (action === "evaluate" || action === "gate") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
        const stage = currentReproStage(repro);
        if (!stage.gate) {
          return {
            content: [{ type: "text" as const, text: "No gate on current stage." }],
            details: reproDetails(repro),
          };
        }
        const evaluated = evaluateStageGate(repro);
        await writeSessionRepro(cwd, evaluated.repro, ctx);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: evaluated.passed
                ? `Gate evaluation passed: ${stage.gate.id}`
                : `Gate evaluation blocked: ${evaluated.blockers.join("; ")}`,
            },
          ],
          details: reproDetails(evaluated.repro),
        };
      }

      if (action === "advance") {
        const repro = await activeRepro(cwd, ctx);
        if (!repro) return noActiveReproResult();
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
          const nextStage = currentReproStage(stageAdvanced);
          return {
            content: [
              {
                type: "text" as const,
                text: `Stage advanced to: ${nextStage.title} (${nextStage.name}), Phase: ${stageAdvanced.currentPhase}`,
              },
            ],
            details: reproDetails(stageAdvanced),
          };
        }
        const stage = currentReproStage(repro);
        const reasons = stage.acceptance.flatMap(reproRequirementBlockers);
        if (stage.gate && stage.gate.evaluation?.passed !== true) {
          reasons.push(`gate not passed: ${stage.gate.description}`);
        }
        return {
          content: [{ type: "text" as const, text: `Cannot advance. ${reasons.join("; ")}` }],
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

function normalizeReproAction(value: unknown): SparkReproToolAction {
  if (value === undefined || value === null || value === "") return "status";
  if (
    value === "status" ||
    value === "start" ||
    value === "record" ||
    value === "evaluate" ||
    value === "satisfy" ||
    value === "gate" ||
    value === "advance" ||
    value === "stop"
  ) {
    return value;
  }
  throw new Error(
    "repro action must be status, start, record, evaluate, satisfy, gate, advance, or stop",
  );
}

function assertNeverReproAction(_action: never): never {
  throw new Error("Unknown repro action");
}

function normalizeOptionalReproObjective(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("repro objective must be a string");
  return value.trim() || undefined;
}

function normalizeReproProof(value: unknown): SparkReproRequirementProof {
  if (!isRecord(value)) throw new Error("proof is required for action=record");
  if (value.kind === "evidence") {
    if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) {
      throw new Error("evidence proof requires a non-empty evidenceRefs array");
    }
    return {
      kind: "evidence",
      evidenceRefs: value.evidenceRefs.map((ref, index) =>
        normalizeArtifactRef(ref, `proof.evidenceRefs[${index}]`),
      ),
    };
  }
  if (value.kind === "decision") {
    return {
      kind: "decision",
      decisionRef: normalizeArtifactRef(value.decisionRef, "proof.decisionRef"),
      selectedValue: normalizeRequiredString(value.selectedValue, "proof.selectedValue"),
      ...(typeof value.rationale === "string" && value.rationale.trim()
        ? { rationale: value.rationale.trim() }
        : {}),
    };
  }
  if (value.kind === "validation") {
    if (typeof value.passed !== "boolean") {
      throw new Error("validation proof requires proof.passed boolean");
    }
    return {
      kind: "validation",
      command: normalizeRequiredString(value.command, "proof.command"),
      resultRef: normalizeArtifactRef(value.resultRef, "proof.resultRef"),
      passed: value.passed,
    };
  }
  throw new Error("proof.kind must be evidence, decision, or validation");
}

function legacyEvidenceProof(value: unknown): SparkReproRequirementProof {
  return { kind: "evidence", evidenceRefs: [normalizeArtifactRef(value, "evidenceRef")] };
}

function resolveLegacyRequirementId(repro: SparkSessionRepro, value: unknown): string {
  const condition = normalizeRequiredString(value, "condition");
  const requirement = currentReproStage(repro).acceptance.find(
    (candidate) => candidate.id === condition || candidate.description === condition,
  );
  if (!requirement) throw new Error(`repro requirement not found: ${condition}`);
  if (requirement.kind !== "evidence") {
    throw new Error(
      `legacy satisfy supports evidence requirements only; use action=record with ${requirement.kind} proof for ${requirement.id}`,
    );
  }
  return requirement.id;
}

async function validateReproProofArtifacts(
  cwd: string,
  proof: SparkReproRequirementProof,
): Promise<SparkReproRequirementProof> {
  const store = defaultArtifactStore(cwd);
  const refs =
    proof.kind === "evidence"
      ? proof.evidenceRefs
      : [proof.kind === "decision" ? proof.decisionRef : proof.resultRef];
  const artifacts = await Promise.all(refs.map((ref) => store.tryGet(ref)));
  for (let index = 0; index < refs.length; index += 1) {
    if (!artifacts[index]) throw new Error(`repro proof artifact not found: ${refs[index]}`);
  }
  if (proof.kind !== "decision") return proof;
  const artifact = artifacts[0]!;
  const verified = await verifyCanonicalAskEvidenceArtifact(cwd, artifact);
  if (!verified) {
    throw new Error(
      "decision proof must reference canonical ask evidence with a valid receipt created by recordAsEvidence=true",
    );
  }
  const selectedValue = verified.selectedValues.find((value) => value === proof.selectedValue);
  if (!selectedValue) {
    throw new Error(
      `decision proof selectedValue does not match the canonical ask answer: ${proof.selectedValue}`,
    );
  }
  return { ...proof, selectedValue };
}

function normalizeArtifactRef(value: unknown, field: string): ArtifactRef {
  if (typeof value !== "string" || !value.startsWith("artifact:") || value.length <= 9) {
    throw new Error(`${field} must be an artifact: ref`);
  }
  return value as ArtifactRef;
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function activeRepro(
  cwd: string,
  ctx: SparkToolContext,
): Promise<SparkSessionRepro | undefined> {
  const repro = await readSessionRepro(cwd, ctx);
  return repro?.status === "active" ? repro : undefined;
}

function noActiveReproResult() {
  return {
    content: [{ type: "text" as const, text: "No active repro drive." }],
    details: {},
  };
}

function reproStatusResult(repro: SparkSessionRepro) {
  const stage = currentReproStage(repro);
  const lines = [
    `Repro drive: ${repro.status}`,
    repro.objective ? `Objective: ${repro.objective}` : undefined,
    `Stage: ${stage.title} (${stage.name}) [${repro.currentStageIndex + 1}/${repro.stages.length}]`,
    `Phase: ${repro.currentPhase}`,
    "",
    "Evidence-backed requirements:",
    ...stage.acceptance.map(
      (requirement) =>
        `  ${isReproRequirementSatisfied(requirement) ? "✓" : "○"} [${requirement.kind}] ${requirement.id} — ${requirement.description}`,
    ),
  ];
  if (stage.gate) {
    lines.push(
      "",
      `Gate: ${stage.gate.id} — ${stage.gate.evaluation?.passed === true ? "PASSED" : "PENDING"} (${stage.gate.description})`,
    );
  }
  lines.push(
    "",
    `Phase complete: ${isPhaseComplete(repro)}`,
    `Stage complete: ${isStageComplete(repro)}`,
  );
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
    gate: stage.gate
      ? {
          id: stage.gate.id,
          passed: stage.gate.evaluation?.passed === true,
          evaluation: stage.gate.evaluation,
        }
      : null,
    acceptance: stage.acceptance.map(requirementDetails),
  };
}

function requirementDetails(requirement: SparkReproRequirement): Record<string, unknown> {
  return {
    id: requirement.id,
    kind: requirement.kind,
    description: requirement.description,
    phase: requirement.phase,
    satisfied: isReproRequirementSatisfied(requirement),
    blockers: reproRequirementBlockers(requirement),
    ...(requirement.kind === "evidence" ? { evidenceRefs: requirement.evidenceRefs } : {}),
    ...(requirement.kind === "decision"
      ? {
          decisionRef: requirement.decisionRef,
          selectedValue: requirement.selectedValue,
          rationale: requirement.rationale,
        }
      : {}),
    ...(requirement.kind === "validation"
      ? {
          command: requirement.command,
          resultRef: requirement.resultRef,
          passed: requirement.passed === true,
        }
      : {}),
  };
}

export function renderReproTickInstruction(repro: SparkSessionRepro): string {
  const stage = currentReproStage(repro);
  const requirements = currentPhaseAcceptance(repro);
  const unsatisfied = requirements.filter(
    (requirement) => !isReproRequirementSatisfied(requirement),
  );
  const gateBlocking = stage.gate && stage.gate.evaluation?.passed !== true;
  const lines = [
    `Spark repro drive tick — Stage ${repro.currentStageIndex + 1}/${repro.stages.length}: ${stage.title} (${stage.name}), phase=${repro.currentPhase}.`,
    repro.objective ? `Repro objective: ${repro.objective}` : undefined,
    "",
    "Milestone-driven reproduction workflow. Stages are linear (setup → scaffold → reproduce → scale → deliver); do one concrete step per tick.",
    "",
    "Current evidence-backed requirements:",
    ...requirements.map(
      (requirement) =>
        `  ${isReproRequirementSatisfied(requirement) ? "[x]" : "[ ]"} [${requirement.kind}] ${requirement.id} — ${requirement.description}`,
    ),
  ];

  const next = unsatisfied[0];
  if (next) lines.push("", renderRequirementNextStep(next));
  else if (gateBlocking) {
    lines.push(
      "",
      'All requirements have proof. Call repro({ action: "evaluate" }); if it passes, call repro({ action: "advance" }).',
    );
  } else {
    lines.push(
      "",
      'All current requirements are satisfied. Call repro({ action: "advance" }) to move to the next phase or stage.',
    );
  }

  if (gateBlocking) {
    lines.push(
      "",
      `Stage gate (${stage.gate!.id}): ${stage.gate!.description} — evaluation is derived from recorded proof and cannot be force-passed.`,
    );
  }

  lines.push(
    "",
    "Repro drive requirements:",
    `- Operate in the selected phase (${repro.currentPhase}); use its tool policy for plan or implement work.`,
    "- Advance milestones with repro record/evaluate/advance. Never treat prose, an unverified ref, or a bare boolean as proof.",
    "- Before ending every repro turn, leave a verifiable checkpoint. If the turn produced a coherent set of repository changes and committing is authorized and safe, create a small git commit promptly. Never include unrelated pre-existing changes.",
    "- If a safe commit is not appropriate yet, show the work completed in the turn: cite concrete artifact refs or file paths, summarize the relevant diff, report commands/tests and their results, or state the exact blocker. Do not end with only a progress claim.",
    "- If blocked on a human decision or external dependency, report the blocker instead of lowering scope; use /repro stop to end the drive.",
    "- End the turn after one concrete step; the next repro tick is scheduled automatically.",
  );

  if (repro.currentPhase === "plan") {
    lines.push(
      "",
      "Plan-phase research-first guidance:",
      "- Classify each unknown as fact, reversible choice, material user decision, or validation uncertainty.",
      "- Research facts from the workspace, dependencies, environment, and primary upstream sources before asking the user.",
      "- For implementation strategy, find the owning module and compare reuse, adaptation, and new implementation with concrete code-path evidence.",
      "- For alignment strategy, inspect the real module path first and compare it with an eager probe. Treat eager as a focused diagnostic unless the evidence or user-approved target makes it the intended path.",
      "- Run a focused probe for validation uncertainty; record the command and result artifact.",
      "- Use a recommended default for reversible low-risk choices and record it in the research artifact.",
      "- Ask exactly one material user decision at a time with canonical ask and recordAsEvidence=true; do not use reviewer auto-answer for that decision.",
    );
  } else {
    lines.push(
      "",
      "Implement-phase guidance:",
      "- Execute the planned tasks: write code, run tests, and fix failures.",
      "- Record the matching artifact-backed requirement proof before advancing.",
    );
  }
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function renderRequirementNextStep(requirement: SparkReproRequirement): string {
  switch (requirement.kind) {
    case "evidence":
      return `Next: research "${requirement.description}", store the findings as an artifact, then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "evidence", evidenceRefs: ["artifact:..."] } }).`;
    case "decision":
      return `Next: after research narrows the options, ask the user one material decision with ask({ mode: "decision", delivery: "blocking", recordAsEvidence: true, questions: [...] }), then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "decision", decisionRef: "artifact:...", selectedValue: "..." } }).`;
    case "validation":
      return `Next: run the smallest real probe for "${requirement.description}", store its command output as an artifact, then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "validation", command: "...", resultRef: "artifact:...", passed: true } }).`;
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}
