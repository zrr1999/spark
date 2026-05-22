# spark-runtime

Spark runtime orchestration for executing ready Spark tasks with registered roles.

Runtime resolves reusable `RoleSpec`s from `pi-roles`, calls `runRole()` for concrete child Pi executions, and adapts those `RoleRun`s back into Spark task/DAG/artifact state. See [`../../docs/agent-run-modes.md`](../../docs/agent-run-modes.md) for the distinction between role specs, fresh runs, and forked runs.

Responsibilities:

- run a ready task through a `RoleRegistry`
- adapt Spark tasks to `pi-roles` `fresh | forked` launch helpers
- create a `role-run` task claim for the concrete run
- enforce run timeout/lease defaults
- refresh active claim leases with a heartbeat loop during non-dry-run execution
- sweep persisted expired claims with `sweepExpiredTaskClaims()`
- maintain Spark-specific active child process tracking for timeout/reconciliation UI and kill controls
- persist DAG manager invocation records in `.spark/dag-runs.json` via `SparkDagRunStore`
- reconcile stale DAG manager state from task graph and active role-run process state
- persist task-run artifacts through `spark-artifacts`
- update `TaskRun` and task status on success/failure

Default launch mode:

- Spark ready-task execution should use fresh role runs by default: the task's `roleRef` selects the reusable role, while the task description and input artifacts provide explicit context.
- Forked runs require an explicit parent session/context source and should be used only when that parent context is intentionally shared and cannot reasonably be materialized as artifacts first.

Non-responsibilities:

- does not own role specs or role storage (`pi-roles`)
- does not own DAG/TODO/claim data structures (`spark-tasks`)
- does not provide generic Pi tools (`pi-*` packages)

Timeout semantics:

- Generic `pi-roles` timeouts send `SIGTERM` and reject with `RoleRunTimeoutError`.
- `spark-runtime` maps that generic error to Spark `RoleRunTimeoutError`, records the `TaskRun` as `running` with `failureKind: "runtime_timeout"`, and keeps the child in Spark's active role-run tracker so the parent session can inspect or kill it.
- Other subprocess launch failures become failed Spark runs and clear the Spark active role-run tracker.
- Stale claim timeout means no heartbeat refreshed the lease; sweepers release the claim, mark the run `cancelled` with `failureKind: "claim_stale"`, and return the task to `pending` for retry.

Attribution:

- `roleRef` identifies the reusable role; it is not the concrete running actor.
- `runName`, `ownerSessionId`, and `runRef` identify the concrete run in `TaskRun` records and active `TaskClaim`s.
- Runtime-created artifacts use `kind: "role-run"` with task provenance and run-record data so outputs are attributed to the Spark task and concrete run while still retaining the role ref.

## Durable DAG run manager model

`runReadySparkTasks()` returns an in-memory aggregate for one scheduling invocation. The durable manager model records a separate DAG-run row so a parent session or UI can track the whole ready-task wave without deriving everything from individual `TaskRun` rows.

Store and status contract:

- `SparkDagRunStore` persists `.spark/dag-runs.json` outside `.spark/thread.json`. The task graph remains the source of truth for tasks, claims, dependencies, and child `TaskRun` history.
- `manager.status` is `idle | running | failed`; `activeRunRef` points at the currently running manager invocation when known; `lastRunRef` points at the most recent manager invocation.
- `SparkDagRunRecord.status` is `running | succeeded | failed | timed_out | stale`.
- Each record stores scheduler inputs (`dryRun`, `maxConcurrency`, `timeoutMs`, optional `ownerSessionId`), counters (`scheduled`, `completed`), scheduled/completed task refs, child `taskRunRefs`, timestamps, optional `errorMessage`, and optional `completionFollowUp`.
- `SparkDagRunStore.status()` summarizes manager state, active/last/recent runs, and running/succeeded/failed/timed-out counts for `spark_status` and control tools.

Lifecycle rules:

- The Spark extension creates a manager record as `running` before scheduling children.
- Schedule/progress callbacks persist scheduled task refs, child run refs, completed task refs, and counters.
- A normal terminal result marks the record `succeeded`; a DAG-level timeout marks it `timed_out` while child claims may remain `running`; an exception marks it `failed`.
- Terminal manager records persist a concise `completionFollowUp` with a summary and next actions. Background manager completion emits that follow-up as a session follow-up message and info notification.

Recovery/reconciliation rules:

- `SparkDagRunStore.reconcile()` is called before `spark_status` reports DAG state and before a new background manager wave starts.
- Reconciliation compares `running` manager records with the current `TaskGraph` and active Spark role-run process refs. If no known child process is active, the manager record is finalized from child `TaskRun` rows when possible.
- Reconciled records become `succeeded` when all known child runs succeeded, `failed` when any child run failed/cancelled, or `stale` when there is not enough child-run evidence. Stale records count as failed in status summaries because they need operator attention/retry.
- Reconciliation clears `manager.activeRunRef` when it no longer points at a running manager record and returns the manager to `idle` when no active run remains.

Control surface:

- `spark_status` includes the persisted DAG manager summary and last/active manager run.
- `spark_dag_manager` actions:
   - `status` — report the persisted summary after reconciliation.
   - `reconcile` — explicitly reconcile stale manager state and report the result.
   - `clear_inactive` — remove inactive manager records from `.spark/dag-runs.json` while preserving any still-running record.
   - `kill_active` — terminate active background role-run processes, then reconcile and report the manager summary.

Use `runSparkTask()` from the Spark extension or higher-level orchestrators.
