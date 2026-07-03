# spark

High-level Spark command and policy facade for Spark hosts. User-facing entry points are intent-specific commands plus canonical tools.

Naming note: current workspace packages still use several `pi-*` import specifiers until the staged rename lands. The selected target concept is documented in [`../../docs/architecture/spark-capabilities-and-generative-ui.md`](../../docs/architecture/spark-capabilities-and-generative-ui.md): Spark-owned capabilities move to `spark-*`, public tool names stay stable, and `pi-btw` remains out of scope.

It wires together Spark mode/policy code and capability packages, while package-specific ownership stays below:

- `spark-tasks` (currently `@zendev-lab/spark-tasks`) owns project/task/TODO graph state, readiness, optional role hints, claims, and the canonical `task_read`, `task_write`, and `assign` tools.
- `spark-workflows` (currently `@zendev-lab/spark-workflows`) owns saved workflow discovery/runtime primitives and `.spark/workflow-runs.json` workflow-run state.
- `spark-loop` (currently `@zendev-lab/spark-loop`) owns reusable loop and goal state/continuation prompt primitives; Spark owns the project-bound `/loop` and `/goal` command facades.
- `spark-artifacts` (currently `@zendev-lab/spark-artifacts`) owns artifact metadata/blobs and provenance.
- `spark-learnings` (currently `@zendev-lab/spark-learnings`) owns evidence-backed `.learnings/` records and the canonical `learning` tool.
- `spark-ask`, `spark-context`, `spark-recall`, `spark-cue`, `spark-graft`, and `spark-roles` are the selected target names for the remaining non-`btw` capability packages.
- `@zendev-lab/spark-runtime` adapts one Spark task to one concrete role run and records task/run outcomes.

Patch/candidate workflows belong to the Graft capability package: use explicit Graft scratch/candidate tools, or an explicit extension role for patcher-style child runs so the child receives only relevant domain tools and must escalate unclear instructions upward instead of editing directly.

The Spark widget renders tasks as `@name: title` and keeps longer task instructions in `description`.
