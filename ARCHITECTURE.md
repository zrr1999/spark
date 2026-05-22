# Spark Package Architecture

## Naming rule

Use the dependency boundary as the naming boundary:

- `spark-*` packages depend on `spark-core` and participate in Spark-specific workflow state.
- `pi-*` packages do **not** depend on `spark-core`; they are reusable Pi infrastructure primitives.

`pi-cue`, `pi-ask`, and `pi-roles` are infrastructure, not Spark-specific workflow logic. Future packages like `pi-warp` should follow the same rule.

## Dependency direction

```text
pi-cue                 # independent Pi infrastructure
pi-ask                 # independent ask infrastructure
pi-roles               # reusable role specs and simple role-run helpers

spark-core
  ↑
  ├─ spark-artifacts
  ├─ spark-ask ───────→ pi-ask
  ├─ spark-review
  └─ spark-tasks
        ↑
   spark-runtime ─────→ spark-artifacts, pi-roles
        ↑
       spark  ───────→ pi-cue, pi-ask, pi-roles
```

Allowed high-level usage:

- `spark` may orchestrate every Spark primitive and may use `pi-cue`, `pi-ask`, and `pi-roles`.
- `spark-runtime` may combine `spark-tasks`, `pi-roles`, and `spark-artifacts` to run claimed tasks. It maps Spark tasks into `RoleRun` requests and maps completion back into task status, claims, DAG manager state, and artifacts.
- `spark-tasks` owns DAGs, TODOs, scheduling state, task names, role bindings as plain `roleRef` strings, and claim leases. It must not run roles or import `pi-roles`.
- `spark-review` may reference tasks, artifacts, and role refs, but must not own task scheduling.
- `spark-ask` may depend on `pi-ask`, but it should only provide Spark presets and copy.
- `pi-*` packages must remain generic and usable outside Spark mode.
- `RoleSpec` objects are definition-layer objects; runtime launch mode is `fresh | forked`. Do not expose legacy `managed` as a runtime-facing mode or primary source.

Forbidden dependencies:

```text
pi-cue -> spark-core
pi-ask -> spark-core
pi-roles -> spark-core
pi-cue -> spark-tasks
spark-artifacts -> spark-tasks
spark-tasks -> spark-artifacts
spark-tasks -> pi-roles
spark-review -> spark-tasks
pi-* -> spark-*
```

## Public mental model

- Users know `/spark`.
- Reusable roles are `RoleSpec`s from `pi-roles` (`builtin`, `project`, or `user`).
- Long-lived work and claim scheduling are `spark-tasks`.
- Role execution/runtime orchestration is split: generic single-run launch/control/JSONL helpers live in `pi-roles`; Spark DAG/task adaptation remains in `spark-runtime`.
- Durable context is `spark-artifacts`.
- Execution is `pi-cue`.
- Generic human/supervisor ask mechanics are `pi-ask`.
- Spark-specific ask presets are `spark-ask`.
- Quality gates are `spark-review`.

`subagents` is not a public product concept in this repo; the Spark-side concrete child execution term is `role-run`.
