# spark

High-level `/spark` facade for Pi.

It wires together Spark primitives and generic `pi-*` tools, but package-specific ownership stays below:

- `spark-agents` owns registry/managed-agent creation
- `spark-tasks` owns task DAGs, TODOs, scheduling state, and claims
- `spark-runtime` executes claimed tasks through agents
- `pi-ask` / `pi-cue` remain reusable outside Spark mode

The Pi widget renders tasks as `@name: title` and keeps longer task instructions in `description`.
