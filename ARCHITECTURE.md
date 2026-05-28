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
  ├─ spark-learnings ─→ spark-artifacts
  ├─ spark-ask ───────→ pi-ask
  ├─ spark-review
  └─ spark-tasks
        ↑
   spark-runtime ─────→ spark-artifacts, pi-roles
        ↑
 spark-orchestrator ─→ spark-artifacts, pi-roles
        ↑
       spark  ───────→ pi-cue, pi-ask, pi-roles, spark-learnings
```

Allowed high-level usage:

- `spark` may orchestrate every Spark primitive and may use `pi-cue`, `pi-ask`, and `pi-roles`.
- `spark-runtime` may combine `spark-tasks`, `pi-roles`, and `spark-artifacts` to run one claimed task. It maps a Spark task into a `RoleRun` request and maps completion back into task status, claims, and artifacts.
- `spark-orchestrator` may combine `spark-tasks`, `spark-runtime`, `pi-roles`, and `spark-artifacts` to schedule ready task frontiers, assign executor roles at dispatch, and own background orchestration state.
- `spark-learnings` may combine `spark-core` and `spark-artifacts` to store evidence-backed reusable learning records as local typed artifacts, but it must not own task scheduling or prompt injection.
- `spark-tasks` owns DAGs, TODOs, scheduling state, task names, role refs as optional plain-string executor hints, and claim leases. It must not run roles or import `pi-roles`.
- `spark-review` may reference tasks, artifacts, and role refs, but must not own task scheduling.
- `spark-ask` may depend on `pi-ask`, but it must not provide canned question presets; Spark asks are constructed by the caller from the concrete task, blocker, review, or decision context.
- `pi-*` packages must remain generic and usable outside Spark mode.
- `RoleSpec` objects are definition-layer objects; runtime launch mode is `fresh | forked`. Do not expose legacy `managed` as a runtime-facing mode or primary source.

Forbidden dependencies:

```text
pi-cue -> spark-core
pi-ask -> spark-core
pi-roles -> spark-core
pi-cue -> spark-tasks
spark-artifacts -> spark-tasks
spark-artifacts -> spark-learnings
spark-tasks -> spark-artifacts
spark-tasks -> pi-roles
spark-review -> spark-tasks
pi-* -> spark-*
```

## Public mental model

- Users know `/spark`.
- Reusable roles are `RoleSpec`s from `pi-roles` (`builtin`, `project`, or `user`).
- Long-lived work and claim scheduling are `spark-tasks`.
- Role execution/runtime orchestration is split: generic single-run launch/control/JSONL helpers live in `pi-roles`; Spark single-task adaptation lives in `spark-runtime`; graph-level ready frontier scheduling lives in `spark-orchestrator`.
- Durable context is `spark-artifacts`.
- Evidence-backed reusable learning is `spark-learnings`.
- Execution is `pi-cue`.
- Generic human/supervisor ask mechanics are `pi-ask`.
- Spark-specific ask artifact persistence/replay is `spark-ask`; concrete ask questions are generated at the call site from actual context.
- Quality gates are `spark-review`.

`subagents` is not a public product concept in this repo; the Spark-side concrete child execution term is `role-run`.
