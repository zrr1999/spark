# spark-agents

Builtin and project agent spec registry for Spark.

This is currently a Spark-named spec package. Target direction: extract generic spec definitions, registry, and stores into `pi-agent-spec`; keep Spark-specific wrappers here or in `spark-runtime`. See [`../../docs/agent-boundaries.md`](../../docs/agent-boundaries.md).

Responsibilities:

- define builtin agent specs
- validate/register/select agent specs
- persist and hydrate project agent specs
- create project agent specs from approved proposals

Non-responsibilities:

- no task scheduling
- no task claim/lease state
- no `runTask` orchestration
- no multi-agent interaction protocol

Runtime execution currently belongs in `spark-runtime`; scheduling and assignment-as-claim belongs in `spark-tasks`. Generic runtime launch mechanics should move to `pi-agent-run` with explicit `fresh | forked` modes.
