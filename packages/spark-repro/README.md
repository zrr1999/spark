# spark-repro

`@zendev-lab/spark-repro` owns the host-neutral reproduction state machine and its
evidence-backed setup contract. Hosts provide persistence, evidence lookup, user
interaction, scheduling, and rendering.

The `@zendev-lab/spark-repro/instructions` export owns the shared tick policy used
by host adapters. Reproduce and scale ticks require a bounded, falsifiable
diagnostic loop: localize the first divergence, change one variable, preserve raw
runtime evidence, and record a `confirmed`, `rejected`, or `inconclusive` verdict.
Static checks and successful builds do not substitute for runtime validation.
Before an expensive full-training rerun, prefer a captured offline tensor slice
and minimal comparison script when the data path permits it.

Each foreground tick must also update a user-visible product checkpoint: an
existing PR or issue after real progress, or one stable Markdown progress preview
that is reused across ticks. Tool execution triggers evidence collection; reuse
refs returned by tools and materialize one concise evidence entry only when a
requirement otherwise has no durable proof. Human-facing learning documents are
also product artifacts: maintain normally one and at most three stable Markdown
previews for the whole repro, consolidate related findings, and update them in
place. They are managed by `artifact`, never `memory` or internal evidence. The
progress preview may link their titles and refs but does not duplicate their full
content.

Setup is research-first and separates three requirement kinds:

- `evidence` records facts established by evidence refs;
- `decision` records a receipt-backed user-answer evidence ref and selected value;
- `validation` records a command, result evidence ref, and pass/fail result.

Readiness and stage gates are derived from these records. Callers cannot pass a
gate by writing a bare boolean.

The setup stage first verifies whether a runnable competitor/reference baseline
already exists (typically a Megatron implementation). Missing baselines are a
blocking user decision: ask how to construct or obtain them before any baseline
probe, and do not invent a substitute. It then researches reuse/adapt/new
implementation options and real-module/eager alignment paths before recording
the corresponding user decisions. Eager execution is a diagnostic path by
default, not silent evidence that the real module path is aligned.
