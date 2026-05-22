# spark

High-level `/spark` facade for Pi.

It wires together Spark primitives and generic `pi-*` tools, but package-specific ownership stays below:

- `pi-roles` owns reusable `RoleSpec`s and simple single `RoleRun` execution helpers.
- `spark-tasks` owns task DAGs, TODOs, scheduling state, optional role hints, and claims.
- `spark-runtime` adapts ready Spark tasks to concrete role runs, assigns executor roles at dispatch, and records artifacts.
- `pi-ask` / `pi-cue` remain reusable outside Spark mode.

The Pi widget renders tasks as `@name: title` and keeps longer task instructions in `description`.
