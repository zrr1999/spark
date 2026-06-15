# pi-goal

Generic durable goal state, usage accounting, and continuation prompt primitives for Pi extensions.

Spark uses this package for project-bound `/goal` mode, but `@zendev-lab/pi-goal` does not own Spark commands, task scheduling, workflow runs, or widget policy. Historical serialized marker strings such as `"spark-goal"` remain stable for on-disk compatibility and are not package ownership markers.

This package vendors and rewrites selected MIT-licensed ideas from `pi-codex-goal`. It intentionally does not expose Pi extension entrypoints, slash commands, or workflow script registration.

Responsibilities:

- model generic goal state and usage accounting
- reconstruct goal state from session custom entries
- render goal summaries and continuation prompts
- keep goal tool-name guidance and continuation markers in one package
- document canonical goal actions used by host extensions: `status`, `start`, `pause`, `resume`, `clear`, `edit`, and reviewer-owned `complete`

Lifecycle semantics:

- `status` is the primary inspection surface and should show scope, objective, status, review/retry state, and available actions
- `start` creates or replaces a completed goal; host extensions must reject conflicting non-complete goals instead of silently switching
- `pause` stops automatic continuation without deleting the goal; `resume` only restarts a still-valid paused goal
- `edit` changes the objective deliberately and clears stale review/retry state; `clear` forgets the current goal without completing it
- `complete` remains reviewer-owned; there is no standalone `goal_complete` alias

Non-responsibilities:

- does not parse or run workflow scripts (`@zendev-lab/pi-workflows`)
- does not schedule ready tasks or own workflow-run state (`@zendev-lab/pi-workflows`)
- does not register Pi tools or slash commands (`@zendev-lab/spark` extension facade)
- does not expose a standalone `goal_complete` tool; Spark completion remains reviewer-owned through the canonical `goal({ action: "complete" })` boundary
