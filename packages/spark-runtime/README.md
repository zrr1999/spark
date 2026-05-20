# spark-runtime

Spark runtime orchestration for executing claimed tasks with registered agents.

Runtime uses reusable agent specs from `spark-agents`/future `pi-agent-spec` and creates concrete subagent runs. See [`../../docs/agent-run-modes.md`](../../docs/agent-run-modes.md) for the distinction between specs, fresh/spec-based runs, and forked-context runs.

Responsibilities:

- run a ready task through an `AgentRegistry`
- create a task claim for the runtime/subagent run
- enforce run timeout/lease defaults
- refresh active claim leases with a heartbeat loop during non-dry-run execution
- sweep persisted expired claims with `sweepExpiredTaskClaims()`
- persist task-run artifacts through `spark-artifacts`
- update `TaskRun` and task status on success/failure

Default launch mode:

- Spark ready-task execution should use fresh/spec-based runs by default: the task's `agentRef` selects the reusable spec, while the task description and input artifacts provide explicit context.
- Forked-context runs require an explicit parent session/context source and should be used only when that parent context is intentionally shared and cannot reasonably be materialized as artifacts first.

Non-responsibilities:

- does not own agent specs or project spec storage (`spark-agents`)
- does not own DAG/TODO/claim data structures (`spark-tasks`)
- does not provide generic Pi tools (`pi-*` packages)

Timeout semantics:

- runtime execution timeout means the run reached its own timeout and the task is marked `failed` with `failureKind: "runtime_timeout"`
- stale claim timeout means no heartbeat refreshed the lease; sweepers release the claim, mark the run `cancelled` with `failureKind: "claim_stale"`, and return the task to `pending` for retry

Attribution:

- `agentRef` identifies the reusable spec; it is not the concrete running actor.
- `agentName`, `ownerSessionId`, and `runRef` identify the concrete run in `TaskRun` records and active `TaskClaim`s.
- Runtime-created artifacts use `kind: "agent-run"` with task provenance and run-record data so outputs are attributed to the Spark task and concrete run while still retaining the spec ref.

Use `runSparkTask()` from the Spark extension or higher-level orchestrators.
