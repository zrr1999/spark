# pi-goal

Generic durable goal state, usage accounting, and continuation prompt primitives for Pi extensions.

Spark uses this package for project-bound `/goal` mode, but `pi-goal` does not own Spark commands, task scheduling, workflow runs, or widget policy. Historical serialized marker strings such as `"spark-goal"` remain stable for on-disk compatibility and are not package ownership markers.

This package vendors and rewrites selected MIT-licensed ideas from `pi-codex-goal`. It intentionally does not expose Pi extension entrypoints, slash commands, or workflow script registration.

Responsibilities:

- model generic goal state and usage accounting
- reconstruct goal state from session custom entries
- render goal summaries, budget text, and continuation prompts
- keep goal tool-name guidance and continuation markers in one package
- document canonical goal actions used by host extensions: `status`, `start`, `pause`, `resume`, `clear`, `edit`, and reviewer-owned `complete`

Non-responsibilities:

- does not parse or run workflow scripts (`pi-workflows`)
- does not schedule ready tasks or own workflow-run state (`pi-workflows`)
- does not register Pi tools or slash commands (`spark` extension facade)
- does not expose a standalone `goal_complete` tool; Spark completion remains reviewer-owned through the canonical `goal({ action: "complete" })` boundary
