# spark-orchestrator

Spark ready-frontier orchestration and durable background state.

Responsibilities:

- persist orchestrator invocation records in `.spark/dag-runs.json` via `SparkDagRunStore`
- schedule execution-ready tasks from `TaskGraph.readyTasks()` in concurrency-limited waves
- coordinate ready-wave progress hooks with durable DAG run records
- reconcile stale orchestrator state from task graph and active role-run process state supplied by the Spark extension/runtime
- summarize orchestrator status for `spark_status`, `spark_background_runs`, and low-level `spark_dag_manager`

Non-responsibilities:

- does not own task/project graph state or plan readiness (`spark-tasks`)
- does not execute a single role-run or own active child process tracking (`spark-runtime`)
- does not register Pi tools or own UI/widget rendering (`spark` extension facade)
- does not attempt to be a generic `pi-dag` abstraction

Public Spark tool names stay stable in the extension facade:

- `spark_run_ready_tasks`
- `spark_background_runs`
- `spark_dag_manager`
