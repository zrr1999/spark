# spark-tasks

Thread/task DAG, TODO, scheduling, and claim state for Spark.

Tasks belong to threads and have three user-facing identity fields:

- `name` — simple stable handle rendered as `@name` in Pi TUI/tools
- `title` — concise human title rendered as `@name: title`
- `description` — detailed objective/instructions for execution

Task planning is first-class: use `TaskGraph.planTasks()` / `spark_plan_tasks` to organize durable tasks before running agents.

Claims are the scheduling primitive. There is no separate assign model: assigning work to a subagent is represented as a `claim` created when the subagent run starts. Main-agent claims and subagent auto-claims use the same schema. Claims support leases via `claimedAt`, `heartbeatAt`, and `expiresAt`; active runs refresh them through `heartbeatTaskClaim()`. Expired claims can be released with `expireTaskClaims()` so failed/stale runs return to `pending` for retry. If an expired claim has a running `TaskRun`, the run is marked `cancelled` with `failureKind: "claim_stale"`.

`TaskGraph` records runs, readiness, dependencies, and TODO summaries, but does not execute agents. Runtime execution belongs in `spark-runtime`; agent registry/creation belongs in `spark-agents`.

Task graph snapshots persist durable thread/task/run state in `.spark/thread.json`. TODOs are stored separately so reload/replay can recover the working set without putting volatile checklist churn into task snapshots. Callers may use session-scoped `.spark/todos/<session>.json` files to avoid concurrent agent overwrites; the legacy `.spark/todos.json` path is only the unscoped fallback.
