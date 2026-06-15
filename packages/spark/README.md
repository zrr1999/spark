# spark

High-level Spark mode facade for Pi. The legacy compatibility command remains registered for existing callers; new guidance should prefer canonical tools and explicit mode commands.

It wires together Spark mode/policy code and generic `pi-*` capabilities, while package-specific ownership stays below:

- `pi-tasks` owns project/task/TODO graph state, readiness, optional role hints, claims, and the canonical `task` tool.
- `pi-workflows` owns saved workflow discovery/runtime primitives and `.spark/workflow-runs.json` workflow-run state.
- `pi-goal` owns reusable goal state and continuation prompt primitives; Spark owns the project-bound `/goal` command/facade.
- `pi-artifacts` owns artifact metadata/blobs and provenance.
- `pi-learnings` owns evidence-backed `.learnings/` records and the canonical `learning` tool.
- `pi-ask`, `pi-context`, `pi-recall`, `pi-cue`, `pi-graft`, and `pi-roles` remain reusable outside Spark mode.
- `spark-runtime` adapts one Spark task to one concrete `pi-roles` role run and records task/run outcomes.

Patch/candidate workflows belong to `pi-graft`: use `graft_patch` for patcher-style child runs so the child receives only Graft-related tools and must escalate unclear instructions upward instead of editing directly.

The Pi widget renders tasks as `@name: title` and keeps longer task instructions in `description`.
