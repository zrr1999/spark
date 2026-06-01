# spark-tasks

Project/task DAG, TODO, scheduling, and claim state for Spark.

Tasks belong to projects and have three user-facing identity fields:

- `name` — simple stable handle rendered as `@name` in Pi TUI/tools
- `title` — concise human title rendered as `@name: title`
- `description` — detailed objective/instructions for execution

Task planning is first-class: use `TaskGraph.planTasks()` / `spark_plan_tasks`
to organize durable tasks before running roles. In the Spark extension,
`spark_plan_tasks` writes directly after readiness checks pass; `/plan` only
injects stronger planning guidance, and refinements are applied by calling the
tool again with concrete updates.
Planning contracts live here: standalone design/planning placeholders are rejected before graph writes, and readiness decisions are derived from the exported `TaskPlan` rules rather than facade-local UI fallbacks.

Claims are the scheduling primitive. There is no separate assign model: binding a task to reusable role work stores a `roleRef`, and executing it creates a `claim` when the `role-run` starts. Main-session claims and role-run claims use the same schema. Claims support leases via `claimedAt`, `heartbeatAt`, and `expiresAt`; active runs refresh them through `heartbeatTaskClaim()`. Expired claims can be released with `expireTaskClaims()` so failed/stale runs return to `pending` for retry. If an expired claim has a running `TaskRun`, the run is marked `cancelled` with `failureKind: "claim_stale"`.

`TaskGraph` records runs, readiness, dependencies, and TODO summaries, but does not execute roles. Runtime execution belongs in `spark-runtime`; role registry/storage and single-run helpers belong in `pi-roles`. Dependencies are strictly scoped to tasks in the same project; cross-project/plugin dependency orchestration is intentionally out of scope for `spark-tasks`.

Task graph snapshots persist durable project/task/run state in `.spark/projects.json`. TODOs are stored separately so reload/replay can recover the working set without putting volatile checklist churn into task snapshots. Callers must provide an explicit scope and use `.spark/todos/<session>.json` files so concurrent sessions and role-runs do not overwrite each other. Independent session TODOs keep their Spark-owned storage path, but share the same `TaskTodoOp` reducer contract so task-bound and session-only checklists do not drift.

## Transferable pi-tasks principles

The reusable core of `spark-tasks` should stay small and protocol-oriented. The following principles summarize the OpenSpec/OpenArc/superpowers-style research that has proved useful for pi-tasks governance without copying a heavyweight process:

1. **Intent before inventory.** A project/task graph should start from the concrete user intent and success criteria, then attach files/artifacts/runs as evidence. Do not create broad intake templates or placeholder tasks just because the system can.
2. **Plan before claim.** Durable planning (`spark_plan_tasks`) is the right place to ask clarifying questions, split dependencies, and set readiness. Claim/runtime paths should enforce readiness rather than invent the plan while executing.
3. **Small typed records beat directory rituals.** Keep the durable protocol as typed project/task/run/TODO/artifact records. Avoid copying OpenSpec/OpenArc change folders unless a specific workflow needs that structure.
4. **Human gates must be explicit.** Clarifications, approvals, and decision gates should use ask artifacts with explicit status/result semantics. Defaults and recommendations may guide the UI, but must not silently become approval.
5. **Execution evidence closes the loop.** A task is not done just because a role run started. Completion should be backed by result status, artifacts, tests/checks, or a clear manual evidence note.
6. **Local composability over global orchestration.** Same-project dependencies, leases, and run records should be easy to reason about locally. Cross-project/workspace roadmap orchestration can be layered later instead of being baked into the core task graph.
7. **Low-noise status, full evidence on demand.** Default status views should show the active frontier and blockers; full history, run logs, and artifacts should remain retrievable through explicit full/tail/read tools.

Actionable backlog derived from these principles:

- Keep extracting generic `pi-tasks` only around stable records and readiness/claim semantics; leave Spark-specific role dispatch and artifacts in Spark packages.
- Prototype project-bound roadmap as a layer above project/task DAGs before adding cross-project dependencies to `spark-tasks`.
- Harden completion evidence gates incrementally by task kind instead of imposing one heavy process on every task.
- Treat ask defaults/recommendations as UI state until explicit user confirmation, matching the ask contract in `packages/pi-ask/README.md`.
