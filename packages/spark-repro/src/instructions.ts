import {
  currentPhaseAcceptance,
  currentReproStage,
  isReproRequirementSatisfied,
  type SparkReproRequirement,
  type SparkSessionRepro,
} from "./index.ts";

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
    "Milestone-driven reproduction workflow. Stages are linear (setup → scaffold → reproduce → scale → deliver). Use this turn for a bounded productive slice and complete as many adjacent requirements as the available evidence and validation allow.",
    "",
    "Current evidence-backed requirements:",
    ...requirements.map(
      (requirement) =>
        `  ${isReproRequirementSatisfied(requirement) ? "[x]" : "[ ]"} [${requirement.kind}] ${requirement.id} — ${requirement.description}`,
    ),
  ];

  const next = unsatisfied[0];
  if (next) {
    lines.push(
      "",
      renderRequirementNextStep(next),
      unsatisfied.length > 1
        ? `After recording it, continue with the next ready requirement in this turn when no user decision, external wait, or unresolved validation blocks progress (${unsatisfied.length - 1} requirement(s) remain after this one).`
        : "After recording it, evaluate and advance in this turn when the stage is ready.",
    );
  } else if (gateBlocking) {
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
    '- Prefer the main session for scheduling and every concrete step. Do not default to role({ action: "call" }), session({ action: "call"|"send" }), assign, or workflow_run during repro ticks; use those only when the user explicitly requests multi-agent/workflow fan-out.',
    "- When blocked by a missing user decision, ambiguous requirement, unclear baseline/source, conflicting evidence, failing validation whose next step is unclear, or any problem the user can unblock, call ask immediately with a concrete question. Do not guess, invent substitutes, or end the turn with only a prose blocker report when ask can resolve it.",
    "- Advance milestones with repro record/evaluate/advance. Never treat prose, an unverified ref, or a bare boolean as proof.",
    "- Real tool calls trigger evidence collection. Inspect their results and reuse returned evidence refs; do not proactively write a separate evidence record for every command, observation, or status update. Record one concise evidence entry only when the current requirement otherwise has no durable proof ref.",
    '- Before ending every foreground repro turn, call artifact({ action: "create"|"update"|"sync", ... }) so this turn changes at least one valid product artifact. Prefer an existing PR or ISSUE after real repository/forge progress; otherwise create one Markdown repro-progress preview once and update that same artifact on later turns.',
    "- The product artifact must state what changed, the validation result or exact blocker, and the next gate. Internal evidence records, chat messages, unchanged syncs, duplicate previews, and placeholder-only edits do not satisfy the per-turn product checkpoint.",
    "- If a user decision blocks the slice, update the product artifact with the narrowed decision and evidence before calling ask. If an external dependency blocks it, update the artifact with the exact dependency and retry condition.",
    "- If the turn produced a coherent set of repository changes and committing is authorized and safe, also create a small git commit promptly. Never include unrelated pre-existing changes.",
    '- Do not create a learning document every turn. Only for durable, surprising, reusable knowledge: use artifact kind="preview" with Markdown to maintain a small, stable set of human-facing learning documents for the whole repro (normally one, at most three). Search/list first, consolidate related findings, update the same artifacts, and attach real evidence refs.',
    "- Human-facing learning documents are owned by artifact, never memory or internal evidence. Keep each document concise. The stable repro-progress preview may link their titles and refs, but must not duplicate their full content.",
    "- If blocked on an external dependency the user cannot resolve, report that blocker; otherwise prefer ask over /repro stop.",
    "- Continue through adjacent requirements, evaluation, and phase/stage advancement in this turn. Stop the slice only at a material user decision, external wait, unresolved validation ambiguity, or a natural context/tool budget boundary; the next repro tick is scheduled automatically.",
  );

  if (repro.currentPhase === "plan") {
    lines.push(
      "",
      "Plan-phase research-first guidance:",
      "- Classify each unknown as fact, reversible choice, material user decision, or validation uncertainty.",
      "- Research facts from the workspace, dependencies, environment, and primary upstream sources before asking the user.",
      "- Prioritize whether a runnable competitor/reference baseline already exists (typically a Megatron implementation). Prove availability with concrete paths, entrypoints, or failed-lookup evidence; do not assume a paper or announcement means the baseline is runnable.",
      "- If that baseline is missing (for example a model whose Megatron path is not landed yet), ask the user how to construct or obtain it before any baseline probe. Do not invent a substitute baseline.",
      "- For implementation strategy, find the owning module and compare reuse, adaptation, and new implementation with concrete code-path evidence.",
      "- For alignment strategy, inspect the real module path first and compare it with an eager probe. Treat eager as a focused diagnostic unless the evidence or user-approved target makes it the intended path.",
      "- Run a focused probe for validation uncertainty only after baseline availability or construction strategy is settled; reuse the tool result evidence ref, or record one concise result entry if the tool returned no durable evidence ref.",
      "- Use a recommended default for reversible low-risk choices and record it in the research evidence.",
      "- Ask exactly one material user decision at a time with canonical ask and recordAsEvidence=true; do not use reviewer auto-answer for that decision.",
      "- Keep research and decision-making in the main session; do not spawn anonymous role calls for ordinary setup research.",
    );
  } else {
    lines.push(
      "",
      "Implement-phase guidance:",
      "- Execute the planned tasks in the main session: write code, run tests, and fix failures.",
      "- If a failure, missing credential, unclear expected behavior, or ambiguous fix path needs a user decision, call ask before inventing a workaround.",
      "- Record the matching evidence-backed requirement proof before advancing.",
    );

    if (stage.name === "reproduce" || stage.name === "scale") {
      lines.push(
        "",
        "Evidence-driven diagnostic-loop guidance:",
        "- Complete or materially advance one bounded diagnostic loop per tick, not merely one command. A long experiment may remain running only when its exact invocation, current status, durable checkpoint, and next observation point are recorded.",
        "- Localize the first divergence in order: first_bad_step → first_bad_layer → suspected_boundary. Do not jump to a broad fix before narrowing the earliest failing boundary.",
        "- State one falsifiable hypothesis with claim, supporting_refs, expected_if_true, and falsifier before changing the implementation.",
        "- Change one variable at a time and run the smallest experiment or probe that can distinguish the hypothesis from its falsifier.",
        "- Preserve the exact command, relevant config and environment, and raw runtime output in durable evidence; finish with runtime_verdict=confirmed | rejected | inconclusive.",
        "- Static analysis, a successful build, or a diff check cannot stand in for runtime validation. Treat missing or ambiguous runtime diagnostics as inconclusive, never passed.",
        "- Before an expensive full-training rerun, prefer an offline .npy/.safetensors slice captured immediately before the suspicious node plus a minimal comparison script, when the data path permits it.",
        "- The main repro session remains the sole writer and executor for the diagnostic loop; use read-only consultation only when explicitly requested, and do not let another session mutate the workspace or certify the verdict.",
      );
    }
  }
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function renderRequirementNextStep(requirement: SparkReproRequirement): string {
  switch (requirement.id) {
    case "competitor-baseline-availability-researched":
      return `Next: verify whether a runnable competitor/reference baseline already exists (typically Megatron). Record concrete entrypoints/paths if found, or explicit failed-lookup evidence if not (for example the model has no landed Megatron implementation yet). Reuse an evidence ref returned by the research tools; only if they provide no durable ref, record one concise evidence entry. Then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }).`;
    case "baseline-construction-strategy-approved":
      return `Next: if a runnable baseline exists, ask the user to confirm reuse (or an alternate source); if it does not exist, ask how to construct or obtain it before probing. Use ask({ mode: "decision", delivery: "blocking", recordAsEvidence: true, questions: [...] }), then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "decision", decisionRef: "evidence:...", selectedValue: "..." } }).`;
    case "baseline-probe-passed":
      return `Next: only after baseline availability or construction strategy is settled, run the smallest real probe for "${requirement.description}". Reuse its returned evidence ref; only if the tool provides no durable ref, record one concise result entry. Then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "validation", command: "...", resultRef: "evidence:...", passed: true } }).`;
    default:
      break;
  }
  switch (requirement.kind) {
    case "evidence":
      return `Next: research "${requirement.description}" with real tools and reuse any returned evidence ref. Only if the tools provide no durable ref, record one concise evidence entry at this requirement boundary. Then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }).`;
    case "decision":
      return `Next: after research narrows the options, ask the user one material decision with ask({ mode: "decision", delivery: "blocking", recordAsEvidence: true, questions: [...] }), then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "decision", decisionRef: "evidence:...", selectedValue: "..." } }).`;
    case "validation":
      return `Next: run the smallest real probe for "${requirement.description}" and reuse its returned evidence ref. Only if the tool provides no durable ref, record one concise result entry. Then call repro({ action: "record", requirementId: "${requirement.id}", proof: { kind: "validation", command: "...", resultRef: "evidence:...", passed: true } }).`;
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}
