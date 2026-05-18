# spark-agents

Builtin and managed agent registry for Spark.

Responsibilities:

- define builtin agent specs
- validate/register/select agent specs
- persist and hydrate managed agent specs
- create managed agent specs from approved proposals

Non-responsibilities:

- no task scheduling
- no task claim/lease state
- no `runTask` orchestration
- no multi-agent interaction protocol

Runtime execution belongs in `spark-runtime`; scheduling and assignment-as-claim belongs in `spark-tasks`.
