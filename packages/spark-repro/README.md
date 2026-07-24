# spark-repro

`@zendev-lab/spark-repro` owns the host-neutral reproduction state machine and its
evidence-backed setup contract. Hosts provide persistence, evidence lookup, user
interaction, scheduling, and rendering.

Setup is research-first and separates three requirement kinds:

- `evidence` records facts established by evidence refs;
- `decision` records receipt-backed user-answer evidence and the selected value;
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
