# spark-runtime

Spark runtime adapter for executing one Spark task with a registered role.

Runtime resolves reusable `RoleSpec`s from `pi-roles`, calls `runRole()` for concrete child Pi executions, and adapts those `RoleRun`s back into Spark task/run/artifact state. Ready-frontier scheduling and durable background orchestration state live in `spark-orchestrator`.

Responsibilities:

- run one ready task through a `RoleRegistry`
- adapt Spark tasks to `pi-roles` `fresh | forked` launch helpers
- choose a concrete executor role for a single run when the caller did not assign one
- create a `role-run` task claim for the concrete run
- enforce run timeout/lease defaults
- refresh active claim leases with a heartbeat loop during non-dry-run execution
- sweep persisted expired claims with `sweepExpiredTaskClaims()`
- maintain Spark-specific active child process tracking for timeout/reconciliation UI and kill controls
- persist task-run artifacts through `spark-artifacts`
- read bounded role-run artifact previews for background-run inspection
- compact historical role-run transcript artifacts through `collectRoleRunArtifactRetentionPlan()`
- update `TaskRun` and task status on success/failure

Non-responsibilities:

- does not own role specs or role storage (`pi-roles`)
- does not own DAG/TODO/claim data structures (`spark-tasks`)
- does not schedule ready task waves or own `.spark/dag-runs.json` (`spark-orchestrator`)
- does not provide generic Pi tools (`pi-*` packages)

Default launch mode:

- Spark task execution should use fresh role runs by default: the assigned role selects the reusable role, while the task description and input artifacts provide explicit context.
- Forked runs require an explicit parent session/context source and should be used only when that parent context is intentionally shared and cannot reasonably be materialized as artifacts first.

Timeout semantics:

- Generic `pi-roles` timeouts send `SIGTERM` and reject with `RoleRunTimeoutError`.
- `spark-runtime` maps that generic error to Spark `RoleRunTimeoutError`, records the `TaskRun` as `running` with `failureKind: "runtime_timeout"`, and keeps the child in Spark's active role-run tracker so the parent session can inspect or kill it.
- Other subprocess launch failures become failed Spark runs and clear the Spark active role-run tracker.
- Stale claim timeout means no heartbeat refreshed the lease; sweepers release the claim, mark the run `cancelled` with `failureKind: "claim_stale"`, and return the task to `pending` for retry.

Attribution:

- `roleRef` identifies the reusable role; it is not the concrete running actor.
- `runName`, `ownerSessionId`, and `runRef` identify the concrete run in `TaskRun` records and active `TaskClaim`s.
- Runtime-created artifacts use `kind: "role-run"` with task provenance and run-record data so outputs are attributed to the Spark task and concrete run while still retaining the role ref.

Use `runSparkTask()` for single-task execution. Use `spark-orchestrator` `runReadySparkTasks()` for graph-level ready task scheduling.
