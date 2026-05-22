# spark-orchestrator

Spark task-graph orchestration for ready frontier scheduling and durable DAG manager state.

Responsibilities:

- schedule execution-ready tasks from `TaskGraph.readyTasks()` in concurrency-limited waves
- assign concrete executor roles at dispatch time from task role hints, runner defaults, and task kind defaults
- call `spark-runtime` `runSparkTask()` for each concrete task execution
- persist DAG manager invocation records in `.spark/dag-runs.json` via `SparkDagRunStore`
- reconcile stale DAG manager state from task graph and active role-run process state supplied by the Spark extension/runtime
- summarize DAG manager status for `spark_status` and `spark_dag_manager`

Non-responsibilities:

- does not own task/thread graph state or plan readiness (`spark-tasks`)
- does not execute a single role-run itself (`spark-runtime`)
- does not register Pi tools or own UI/widget rendering (`spark` extension facade)
- does not attempt to be a generic `pi-dag` abstraction

Public Spark tool names stay stable in the extension facade:

- `spark_run_ready_tasks`
- `spark_dag_manager`
