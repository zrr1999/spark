Spark repro drive tick — Stage 1/5: Setup (setup), phase=plan.

Milestone-driven reproduction workflow. Stages are linear (setup → scaffold → reproduce → scale → deliver); do one concrete step per tick.

Current evidence-backed requirements:
  [ ] [evidence] repro-contract-frozen — Reproduction claim and acceptance contract frozen
  [ ] [evidence] competitor-baseline-availability-researched — Runnable competitor/reference baseline availability verified (typically Megatron)
  [ ] [decision] baseline-construction-strategy-approved — Reuse existing baseline or construction approach approved by the user
  [ ] [evidence] implementation-landscape-researched — Reusable implementation and extension boundaries researched
  [ ] [evidence] alignment-paths-researched — Real-module and eager alignment paths compared
  [ ] [decision] implementation-strategy-approved — Reuse, adapt, or new implementation strategy approved by the user
  [ ] [decision] alignment-strategy-approved — Real-module or eager alignment strategy approved by the user
  [ ] [validation] baseline-probe-passed — Minimum baseline comparison probe passed against an available or user-approved constructed baseline

Next: research "Reproduction claim and acceptance contract frozen", store the findings as evidence, then call repro({ action: "record", requirementId: "repro-contract-frozen", proof: { kind: "evidence", evidenceRefs: ["evidence:..."] } }).

Repro drive requirements:
- Operate in the selected phase (plan); use its tool policy for plan or implement work.
- Prefer the main session for scheduling and every concrete step. Do not default to role({ action: "call" }), session({ action: "call"|"send" }), assign, or workflow_run during repro ticks; use those only when the user explicitly requests multi-agent/workflow fan-out.
- When blocked by a missing user decision, ambiguous requirement, unclear baseline/source, conflicting evidence, failing validation whose next step is unclear, or any problem the user can unblock, call ask immediately with a concrete question. Do not guess, invent substitutes, or end the turn with only a prose blocker report when ask can resolve it.
- Advance milestones with repro record/evaluate/advance. Never treat prose, an unverified ref, or a bare boolean as proof.
- Before ending every repro turn, leave a verifiable checkpoint. If the turn produced a coherent set of repository changes and committing is authorized and safe, create a small git commit promptly. Never include unrelated pre-existing changes.
- If a safe commit is not appropriate yet, show the work completed in the turn: cite concrete evidence refs or file paths, summarize the relevant diff, report commands/tests and their results, or ask about the exact blocker. Do not end with only a progress claim.
- If blocked on an external dependency the user cannot resolve, report that blocker; otherwise prefer ask over /repro stop.
- End the turn after one concrete step; the next repro tick is scheduled automatically.

Plan-phase research-first guidance:
- Classify each unknown as fact, reversible choice, material user decision, or validation uncertainty.
- Research facts from the workspace, dependencies, environment, and primary upstream sources before asking the user.
- Prioritize whether a runnable competitor/reference baseline already exists (typically a Megatron implementation). Prove availability with concrete paths, entrypoints, or failed-lookup evidence; do not assume a paper or announcement means the baseline is runnable.
- If that baseline is missing (for example a model whose Megatron path is not landed yet), ask the user how to construct or obtain it before any baseline probe. Do not invent a substitute baseline.
- For implementation strategy, find the owning module and compare reuse, adaptation, and new implementation with concrete code-path evidence.
- For alignment strategy, inspect the real module path first and compare it with an eager probe. Treat eager as a focused diagnostic unless the evidence or user-approved target makes it the intended path.
- Run a focused probe for validation uncertainty only after baseline availability or construction strategy is settled; record the command and result evidence.
- Use a recommended default for reversible low-risk choices and record it in the research evidence.
- Ask exactly one material user decision at a time with canonical ask and recordAsEvidence=true; do not use reviewer auto-answer for that decision.
- Keep research and decision-making in the main session; do not spawn anonymous role calls for ordinary setup research.
