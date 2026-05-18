# Spark Package Architecture

## Naming rule

Use the dependency boundary as the naming boundary:

- `spark-*` packages depend on `spark-core` and participate in Spark-specific workflow state.
- `pi-*` packages do **not** depend on `spark-core`; they are reusable Pi infrastructure primitives.

`pi-cue` is infrastructure, not Spark-specific workflow logic. Future packages like `pi-warp` should follow the same rule.

## Dependency direction

```text
pi-cue                 # independent Pi infrastructure
pi-ask                 # independent ask infrastructure

spark-core
  ↑
  ├─ spark-artifacts
  ├─ spark-ask ───────→ pi-ask
  ├─ spark-agents
  ├─ spark-review
  └─ spark-tasks
        ↑
   spark-runtime ─────→ spark-agents, spark-artifacts
        ↑
       spark  ───────→ pi-cue, pi-ask
```

Allowed high-level usage:

- `spark` may orchestrate every Spark primitive and may use `pi-cue` / `pi-ask`.
- `spark-runtime` may combine `spark-tasks`, `spark-agents`, and `spark-artifacts` to run claimed tasks.
- `spark-tasks` owns DAGs, TODOs, scheduling state, task names, and claim leases. It must not run agents.
- `spark-agents` owns only builtin/managed agent specs, registry lookup, and managed-agent creation. It must not schedule tasks or implement multi-agent interaction.
- `spark-review` may call agents and artifacts, but must not own task scheduling.
- `spark-ask` may depend on `pi-ask`, but it should only provide Spark presets and copy.
- `pi-*` packages must remain generic and usable outside Spark mode.

Forbidden dependencies:

```text
pi-cue -> spark-core
pi-ask -> spark-core
pi-cue -> spark-tasks
spark-artifacts -> spark-tasks
spark-agents -> spark-tasks
spark-tasks -> spark-agents
spark-tasks -> spark-artifacts
spark-review -> spark-tasks
pi-* -> spark-*
```

## Public mental model

- Users know `/spark`.
- Agent registry/creation is `spark-agents`.
- Long-lived work and claim scheduling are `spark-tasks`.
- Agent execution/runtime orchestration is `spark-runtime`.
- Durable context is `spark-artifacts`.
- Execution is `pi-cue`.
- Generic human/supervisor ask mechanics are `pi-ask`.
- Spark-specific ask presets are `spark-ask`.
- Quality gates are `spark-review`.

`subagents` is not a public product concept in this repo.
