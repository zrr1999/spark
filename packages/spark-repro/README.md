# spark-repro

`@zendev-lab/spark-repro` owns the host-neutral reproduction state machine and its
evidence-backed setup contract. Hosts provide persistence, artifact lookup, user
interaction, scheduling, and rendering.

Setup is research-first and separates three requirement kinds:

- `evidence` records facts established by research artifacts;
- `decision` records a user-answer artifact and selected value;
- `validation` records a command, result artifact, and pass/fail result.

Readiness and stage gates are derived from these records. Callers cannot pass a
gate by writing a bare boolean.

The setup stage explicitly researches reuse/adapt/new implementation options and
real-module/eager alignment paths before recording the corresponding user
decisions. Eager execution is a diagnostic path by default, not silent evidence
that the real module path is aligned.
