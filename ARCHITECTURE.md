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
pi-agent-spec          # planned: reusable agent spec registry/store
pi-agent-run           # planned: reusable fresh/forked Pi agent runner

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
- `spark-runtime` may combine `spark-tasks`, agent specs, agent runs, and `spark-artifacts` to run claimed tasks. Target direction: generic spec/run mechanics move to `pi-agent-spec` / `pi-agent-run`, while Spark keeps task/DAG adaptation.
- `spark-tasks` owns DAGs, TODOs, scheduling state, task names, and claim leases. It must not run agents.
- `spark-agents` currently owns only builtin/project agent specs, registry lookup, and project spec creation. This is a transitional Spark-named package; see [agent-boundaries.md](./docs/agent-boundaries.md) and [pi-agent-spec-api.md](./docs/pi-agent-spec-api.md) for the target `pi-agent-spec` split and terminology cleanup.
- `spark-review` may call agents and artifacts, but must not own task scheduling.
- `spark-ask` may depend on `pi-ask`, but it should only provide Spark presets and copy.
- `pi-*` packages must remain generic and usable outside Spark mode.
- Agent specs are definition-layer objects; runtime launch mode is `fresh | forked`. Do not expose `managed` as a runtime-facing mode. See [agent-run-modes.md](./docs/agent-run-modes.md) for when to use reusable specs, fresh/spec-based subagent runs, and forked-context subagent runs.

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
pi-agent-spec -> spark-core
pi-agent-run -> spark-core
```

## Public mental model

- Users know `/spark`.
- Agent registry/creation is currently `spark-agents`; target generic ownership is `pi-agent-spec` with Spark wrappers.
- Long-lived work and claim scheduling are `spark-tasks`.
- Agent execution/runtime orchestration is currently `spark-runtime`; target generic process launching is `pi-agent-run`, with Spark DAG/task adaptation remaining in `spark-runtime`.
- Durable context is `spark-artifacts`.
- Execution is `pi-cue`.
- Generic human/supervisor ask mechanics are `pi-ask`.
- Spark-specific ask presets are `spark-ask`.
- Quality gates are `spark-review`.

`subagents` is not a public product concept in this repo.
