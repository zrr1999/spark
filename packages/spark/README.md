# spark

High-level Spark mode facade for Pi. The legacy compatibility command remains registered for existing callers; new guidance should prefer canonical tools and explicit mode commands.

It wires together Spark mode/policy code and generic `pi-*` capabilities, while package-specific ownership stays below:

- `@zendev-lab/pi-tasks` owns project/task/TODO graph state, readiness, optional role hints, claims, and the canonical `task_read`, `task_write`, and `assign` tools.
- `@zendev-lab/pi-workflows` owns saved workflow discovery/runtime primitives and `.spark/workflow-runs.json` workflow-run state.
- `@zendev-lab/pi-goal` owns reusable goal state and continuation prompt primitives; Spark owns the project-bound `/goal` command/facade.
- `@zendev-lab/pi-artifacts` owns artifact metadata/blobs and provenance.
- `@zendev-lab/pi-learnings` owns evidence-backed `.learnings/` records and the canonical `learning` tool.
- `@zendev-lab/pi-ask`, `@zendev-lab/pi-context`, `@zendev-lab/pi-recall`, `@zendev-lab/pi-cue`, `@zendev-lab/pi-graft`, and `@zendev-lab/pi-roles` remain reusable outside Spark mode.
- `@zendev-lab/spark-runtime` adapts one Spark task to one concrete `@zendev-lab/pi-roles` role run and records task/run outcomes.

Patch/candidate workflows belong to `@zendev-lab/pi-graft`: use explicit Graft scratch/candidate tools, or an explicit extension role for patcher-style child runs so the child receives only relevant domain tools and must escalate unclear instructions upward instead of editing directly.

The Pi widget renders tasks as `@name: title` and keeps longer task instructions in `description`.
