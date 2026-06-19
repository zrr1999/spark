# spark-runtime

Spark runtime adapter for executing one Spark task with a registered role.

Runtime resolves reusable `RoleSpec`s from `@zendev-lab/pi-roles` and adapts concrete role execution back into Spark task/run/artifact state. Hosts can inject a `SparkRoleInstructionExecutor` for daemon-native execution; without one, the package keeps the legacy `runRole()` Pi child launcher as a compatibility fallback. Graph-level ready-task scheduling and durable workflow-run state live in `@zendev-lab/pi-workflows`; `@zendev-lab/spark-runtime` stays focused on one task execution at a time.

Responsibilities:

- run one ready task through a `RoleRegistry`
- adapt Spark tasks to `@zendev-lab/pi-roles` `fresh | forked` launch helpers
- choose a concrete executor role for a single run when the caller did not assign one
- create a `role-run` task claim for the concrete run
- enforce run timeout/lease defaults
- refresh active claim leases with a heartbeat loop during non-dry-run execution
- sweep persisted expired claims with `sweepExpiredTaskClaims()`
- maintain Spark-specific active child process tracking for timeout/reconciliation UI and kill controls
- persist task-run artifacts through `@zendev-lab/pi-artifacts`
- read bounded role-run artifact previews for background-run inspection
- compact historical role-run transcript artifacts through `collectRoleRunArtifactRetentionPlan()`
- update `TaskRun` and task status on success/failure

Non-responsibilities:

- does not own role specs or role storage (`@zendev-lab/pi-roles`)
- does not own project/task/TODO/claim data structures (`@zendev-lab/pi-tasks`)
- does not schedule ready task waves or own `.spark/workflow-runs.json` (`@zendev-lab/pi-workflows`)
- does not provide generic Pi tools (`pi-*` packages)

Default launch mode:

- Spark task execution should use fresh role runs by default: the assigned role selects the reusable role, while the task description and input artifacts provide explicit context.
- Forked runs require an explicit parent session/context source and should be used only when that parent context is intentionally shared and cannot reasonably be materialized as artifacts first.

Timeout semantics:

- Generic `@zendev-lab/pi-roles` timeouts send `SIGTERM` and reject with `RoleRunTimeoutError`.
- `@zendev-lab/spark-runtime` maps that generic error to Spark `RoleRunTimeoutError`, records the `TaskRun` as `running` with `failureKind: "runtime_timeout"`, and keeps the child in Spark's active role-run tracker so the parent session can inspect or kill it.
- Other subprocess launch failures become failed Spark runs and clear the Spark active role-run tracker.
- Stale claim timeout means no heartbeat refreshed the lease; sweepers release the claim, mark the run `cancelled` with `failureKind: "claim_stale"`, and return the task to `pending` for retry.

Attribution:

- `roleRef` identifies the reusable role; it is not the concrete running actor.
- `runName`, `ownerSessionId`, and `runRef` identify the concrete run in `TaskRun` records and active `TaskClaim`s.
- Runtime-created artifacts use `kind: "role-run"` with task provenance and run-record data so outputs are attributed to the Spark task and concrete run while still retaining the role ref.

Use `runSparkTask()` for single-task execution. Use `@zendev-lab/pi-workflows` `runReadyTasks()` for graph-level ready task scheduling.
