# spark-tasks

Generic project/task/TODO/run capability for Spark capability hosts.

`@zendev-lab/spark-tasks` owns task graph contracts, readiness, claims, TODO persistence, task-run records, and the canonical `task_read`, `task_write`, and `assign` tools. Prefer constructing `TaskGraphStore` and `TaskTodoStore` with explicit host-owned paths. The exported default stores read `.spark/projects.json` and `.spark/todos/*`.

The public task surface is split by capability: `task_read` is read-only inspection, `task_write` mutates project/task/TODO graph state, and `assign` is the explicit spawn surface for ready-task scheduling. TODO operations are sub-actions of `task_write` rather than a separate TODO package.

`roleRef` fields and the persisted `role-run` claim kind are attribution for hosts that execute tasks through reusable role specs. New task planning should normally use `kind` as an executor hint and leave role binding to the host/runtime boundary.
