# pi-goal

Generic durable goal state, usage accounting, and continuation prompt primitives for Pi extensions, layered on `@zendev-lab/pi-loop`.

Spark uses this package for project-bound `/goal` mode, but `@zendev-lab/pi-goal` does not own Spark commands, task scheduling, workflow runs, or widget policy. Serialized marker strings such as `"spark-goal"` are not package ownership markers.

This package vendors and rewrites selected MIT-licensed ideas from `pi-codex-goal`. It intentionally does not expose Pi extension entrypoints, slash commands, or workflow script registration.

Responsibilities:

- layer goal objective/status/completion policy on lower-level non-completing `pi-loop` continuation primitives
- model generic goal state and usage accounting
- reconstruct goal state from session custom entries
- render goal summaries and continuation prompts
- keep goal tool-name guidance and continuation markers in one package
- document canonical goal actions used by host extensions: `status`, `start`, `pause`, `resume`, `clear`, `edit`, and reviewer-gated `complete`

Lifecycle semantics:

- `status` is the primary inspection surface and should show scope, objective, status, review/retry state, and available actions
- `start` creates or replaces a completed goal; host extensions must reject conflicting non-complete goals instead of silently switching
- `pause` stops automatic continuation without deleting the goal; `resume` only restarts a still-valid paused goal
- `edit` changes the objective deliberately and clears stale review/retry state; `clear` forgets the current goal without completing it
- `complete` is a reviewer-gated completion request: the main session requests completion, the reviewer audits and returns a verdict, and the host extension applies the approved state transition; there is no standalone `goal_complete` alias

Non-responsibilities:

- does not make `pi-loop` a completion authority; loop can continue/wait/block/pause, while goal adds reviewer-gated completion policy
- does not parse or run workflow scripts (`@zendev-lab/pi-workflows`)
- does not schedule ready tasks or own workflow-run state (`@zendev-lab/pi-workflows`)
- does not register Pi tools or slash commands (`@zendev-lab/spark-extension` extension facade)
- does not expose a standalone `goal_complete` tool; Spark completion remains reviewer-gated through the canonical `goal({ action: "complete" })` request boundary
