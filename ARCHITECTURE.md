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
  └─ spark-agents
        ↑
      spark-review
        ↑
      spark-tasks
        ↑
       spark  ───────→ pi-cue, pi-ask
```

Allowed high-level usage:

- `spark` may orchestrate every Spark primitive and may use `pi-cue`.
- `spark-tasks` may call agents, artifacts, and review gates.
- `spark-review` may call agents and artifacts.
- `spark-agents`, `spark-ask`, and `spark-artifacts` must not depend on tasks.
- `spark-ask` may depend on `pi-ask`, but it should only provide Spark presets and copy.
- Other subrepos may depend on `pi-cue` directly.

Forbidden dependencies:

```text
pi-cue -> spark-core
pi-ask -> spark-core
pi-cue -> spark-tasks
spark-artifacts -> spark-tasks
spark-agents -> spark-tasks
spark-review -> spark-tasks
```

## Public mental model

- Users know `/spark`.
- Agent runtime is `spark-agents`.
- Long-lived work is `spark-tasks`.
- Durable context is `spark-artifacts`.
- Execution is `pi-cue`.
- Generic human/supervisor ask mechanics are `pi-ask`.
- Spark-specific ask presets are `spark-ask`.
- Quality gates are `spark-review`.

`subagents` is not a public product concept in this repo.
