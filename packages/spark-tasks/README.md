# spark-tasks

Thread/task DAG orchestration. Tasks belong to threads, dependencies are task-to-task, executable tasks bind to registered agents, and each thread can track model/task state without synthesizing placeholders.

Task planning is a first-class operation: use `TaskGraph.planTasks()` / the Spark `spark_plan_tasks` tool to梳理/organize multiple durable tasks before assigning agents. Planning should not be represented by claiming many unfinished tasks in one session.

Task graph snapshots persist durable thread/task/run state in `.spark/thread.json`. TODOs are stored separately so reload/replay can recover the working set without putting volatile checklist churn into task snapshots. Callers may use session-scoped `.spark/todos/<session>.json` files to avoid concurrent agent overwrites; the legacy `.spark/todos.json` path is only the unscoped fallback.
