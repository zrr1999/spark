import type { SparkPromptManifest, SparkPromptManifestToolEffect } from "./prompt-manifest.ts";

export type SparkBehaviorEvalOutcome = "completed" | "blocked" | "aborted" | "failed";

export interface SparkBehaviorEvalToolCall {
  name: string;
  effect?: SparkPromptManifestToolEffect;
  isError?: boolean;
}

export interface SparkBehaviorEvalObservation {
  manifest: SparkPromptManifest;
  toolCalls: readonly SparkBehaviorEvalToolCall[];
  outcome: SparkBehaviorEvalOutcome;
  roundtrips: number;
  evidenceRefs?: readonly string[];
}

export interface SparkBehaviorEvalExpectation {
  id: string;
  allowedTools?: readonly string[];
  requiredTools?: readonly string[];
  forbiddenTools?: readonly string[];
  allowedEffects?: readonly SparkPromptManifestToolEffect[];
  expectedOutcomes?: readonly SparkBehaviorEvalOutcome[];
  maxToolCalls?: number;
  requireEvidence?: boolean;
}

export interface SparkBehaviorEvalCheck {
  id: string;
  passed: boolean;
  message: string;
}

export interface SparkBehaviorEvalResult {
  id: string;
  passed: boolean;
  checks: SparkBehaviorEvalCheck[];
  metrics: {
    toolCalls: number;
    toolErrors: number;
    toolSelectionPrecision: number;
    requiredToolCoverage: number;
    roundtrips: number;
    evidenceRefs: number;
  };
}

/** Score a recorded run without inspecting prompt text or tool arguments. */
export function evaluateSparkBehavior(
  expectation: SparkBehaviorEvalExpectation,
  observation: SparkBehaviorEvalObservation,
): SparkBehaviorEvalResult {
  const calls = observation.toolCalls.map((call) => call.name);
  const allowed = new Set(expectation.allowedTools ?? calls);
  const required = new Set(expectation.requiredTools ?? []);
  const forbidden = new Set(expectation.forbiddenTools ?? []);
  const allowedEffects = new Set(expectation.allowedEffects ?? []);
  const evidenceRefs = observation.evidenceRefs?.filter((ref) => ref.trim()) ?? [];
  const checks: SparkBehaviorEvalCheck[] = [];

  if (expectation.allowedTools) {
    const unexpected = calls.filter((name) => !allowed.has(name));
    checks.push(
      check("allowed_tools", unexpected.length === 0, listMessage("unexpected", unexpected)),
    );
  }
  if (required.size > 0) {
    const missing = [...required].filter((name) => !calls.includes(name));
    checks.push(check("required_tools", missing.length === 0, listMessage("missing", missing)));
  }
  if (forbidden.size > 0) {
    const used = calls.filter((name) => forbidden.has(name));
    checks.push(check("forbidden_tools", used.length === 0, listMessage("forbidden", used)));
  }
  if (expectation.allowedEffects) {
    const violations = observation.toolCalls
      .filter((call) => !allowedEffects.has(call.effect ?? "unknown"))
      .map((call) => `${call.name}:${call.effect ?? "unknown"}`);
    checks.push(
      check("allowed_effects", violations.length === 0, listMessage("effect", violations)),
    );
  }
  if (expectation.expectedOutcomes) {
    checks.push(
      check(
        "outcome",
        expectation.expectedOutcomes.includes(observation.outcome),
        `observed=${observation.outcome}`,
      ),
    );
  }
  if (expectation.maxToolCalls !== undefined) {
    checks.push(
      check(
        "tool_budget",
        calls.length <= expectation.maxToolCalls,
        `observed=${calls.length} maximum=${expectation.maxToolCalls}`,
      ),
    );
  }
  if (expectation.requireEvidence) {
    checks.push(check("evidence", evidenceRefs.length > 0, `observed=${evidenceRefs.length}`));
  }

  const allowedCalls = calls.filter((name) => allowed.has(name)).length;
  const requiredCalls = [...required].filter((name) => calls.includes(name)).length;
  return {
    id: expectation.id,
    passed: checks.every((entry) => entry.passed),
    checks,
    metrics: {
      toolCalls: calls.length,
      toolErrors: observation.toolCalls.filter((call) => call.isError === true).length,
      toolSelectionPrecision: calls.length === 0 ? 1 : allowedCalls / calls.length,
      requiredToolCoverage: required.size === 0 ? 1 : requiredCalls / required.size,
      roundtrips: Math.max(0, Math.floor(observation.roundtrips)),
      evidenceRefs: evidenceRefs.length,
    },
  };
}

function check(id: string, passed: boolean, message: string): SparkBehaviorEvalCheck {
  return { id, passed, message };
}

function listMessage(label: string, values: readonly string[]): string {
  return values.length === 0 ? `${label}=none` : `${label}=${values.join(",")}`;
}
