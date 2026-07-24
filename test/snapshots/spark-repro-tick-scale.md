Spark repro drive tick — Stage 4/5: Scale (scale), phase=implement.

Milestone-driven reproduction workflow. Stages are linear (setup → scaffold → reproduce → scale → deliver); do one concrete step per tick.

Current evidence-backed requirements:
  [ ] [validation] target-scale-convergence — Convergence verified at target scale
  [ ] [validation] performance-budget — Performance metrics within budget

Next: run the smallest real probe for "Convergence verified at target scale", store its command output as evidence, then call repro({ action: "record", requirementId: "target-scale-convergence", proof: { kind: "validation", command: "...", resultRef: "evidence:...", passed: true } }).

Stage gate (gate-B): Convergence verified at scale — evaluation is derived from recorded proof and cannot be force-passed.

Repro drive requirements:
- Operate in the selected phase (implement); use its tool policy for plan or implement work.
- Prefer the main session for scheduling and every concrete step. Do not default to role({ action: "call" }), session({ action: "call"|"send" }), assign, or workflow_run during repro ticks; use those only when the user explicitly requests multi-agent/workflow fan-out.
- When blocked by a missing user decision, ambiguous requirement, unclear baseline/source, conflicting evidence, failing validation whose next step is unclear, or any problem the user can unblock, call ask immediately with a concrete question. Do not guess, invent substitutes, or end the turn with only a prose blocker report when ask can resolve it.
- Advance milestones with repro record/evaluate/advance. Never treat prose, an unverified ref, or a bare boolean as proof.
- Before ending every repro turn, leave a verifiable checkpoint. If the turn produced a coherent set of repository changes and committing is authorized and safe, create a small git commit promptly. Never include unrelated pre-existing changes.
- If a safe commit is not appropriate yet, show the work completed in the turn: cite concrete evidence refs or file paths, summarize the relevant diff, report commands/tests and their results, or ask about the exact blocker. Do not end with only a progress claim.
- If blocked on an external dependency the user cannot resolve, report that blocker; otherwise prefer ask over /repro stop.
- End the turn after one concrete step; the next repro tick is scheduled automatically.

Implement-phase guidance:
- Execute the planned tasks in the main session: write code, run tests, and fix failures.
- If a failure, missing credential, unclear expected behavior, or ambiguous fix path needs a user decision, call ask before inventing a workaround.
- Record the matching evidence-backed requirement proof before advancing.

Selective Fusion policy (reproduce/scale only):
- If the fusion tool is available, consider fusion({ action: "deliberate", question: "...", context: "..." }) only after the first divergence has been localized with durable runtime evidence and at least one condition holds: at least two plausible falsifiable hypotheses remain, the evidence conflicts, or the latest runtime_verdict is inconclusive.
- Skip Fusion when the next single-variable experiment is already clear and cheap.
- Pass only a bounded summary of the current first divergence, active hypotheses, constraints, and observed evidence with their original evidence: refs. Never pass the full transcript, raw logs, or stale context.
- Do not repeat a Fusion consultation unless the evidence or active hypotheses materially changed.
- If Fusion is unavailable, partial, or failed, continue SOLO; consultation must never block reproduction.
- Ask Fusion only to recommend the cheapest single-variable experiment that discriminates the active hypotheses. The main repro session remains the sole writer and executor: it must run the experiment and derive runtime_verdict=confirmed | rejected | inconclusive from new runtime evidence.
- Fusion is advisory: it must not write code, execute experiments, confirm or reject hypotheses or causality, emit a runtime verdict, satisfy repro proof or a gate, or create/register a Product Artifact.
- A Fusion call or result is neither internal evidence nor a Product Artifact. Product Artifact kinds remain exactly issue, pr, and preview.
