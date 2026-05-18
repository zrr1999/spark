# spark-runtime

Spark runtime orchestration for executing claimed tasks with registered agents.

Responsibilities:

- run a ready task through an `AgentRegistry`
- create a task claim for the runtime/subagent run
- enforce run timeout/lease defaults
- refresh active claim leases with a heartbeat loop during non-dry-run execution
- sweep persisted expired claims with `sweepExpiredTaskClaims()`
- persist task-run artifacts through `spark-artifacts`
- update `TaskRun` and task status on success/failure

Non-responsibilities:

- does not own agent specs or managed-agent storage (`spark-agents`)
- does not own DAG/TODO/claim data structures (`spark-tasks`)
- does not provide generic Pi tools (`pi-*` packages)

Timeout semantics:

- runtime execution timeout means the run reached its own timeout and the task is marked `failed` with `failureKind: "runtime_timeout"`
- stale claim timeout means no heartbeat refreshed the lease; sweepers release the claim, mark the run `cancelled` with `failureKind: "claim_stale"`, and return the task to `pending` for retry

Use `runSparkTask()` from the Spark extension or higher-level orchestrators.
