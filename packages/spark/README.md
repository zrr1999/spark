# spark

High-level `/spark` facade for Pi.

It wires together Spark primitives and generic `pi-*` tools, but package-specific ownership stays below:

- `pi-roles` owns reusable `RoleSpec`s and simple single `RoleRun` execution helpers.
- `spark-tasks` owns task DAGs, TODOs, readiness, optional role hints, and claims.
- `spark-runtime` adapts one Spark task to one concrete role run and records artifacts.
- `spark-goal` owns goal state, usage accounting, and continuation prompts.
- `spark-workflows` owns workflow scripts and workflow-run orchestration.
- `pi-ask` / `pi-cue` remain reusable outside Spark mode.

The Spark extension registers Spark-owned predefined roles through `pi-roles`,
including `patcher` for narrow, reviewable code patches. Domain-specific roles
belong to the package that owns their semantics; `pi-roles` only provides the
registry and run mechanism.

The Pi widget renders tasks as `@name: title` and keeps longer task instructions in `description`.
