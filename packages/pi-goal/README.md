# pi-goal

Spark-owned goal state, usage accounting, and hidden continuation prompt primitives for `/goal`.

This package vendors and rewrites selected MIT-licensed ideas from `pi-codex-goal`. It intentionally does not expose Pi extension entrypoints, slash commands, or workflow script registration.

Responsibilities:

- model Spark goal state and usage accounting
- reconstruct goal state from session custom entries
- render goal summaries, budget text, and continuation prompts
- keep Spark goal tool-name guidance and continuation markers in one package

Non-responsibilities:

- does not parse or run workflow scripts (`spark-workflows`)
- does not schedule ready tasks or own workflow-run state (`spark-workflows`)
- does not register Pi tools or slash commands (`spark` extension facade)
