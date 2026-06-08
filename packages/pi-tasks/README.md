# pi-tasks

Generic project/task/TODO/run capability for Pi extensions.

`pi-tasks` owns task graph contracts, readiness, claims, TODO persistence, task-run records, and the canonical `task` action tool. Persisted Spark project state intentionally remains under `.spark/projects.json` and `.spark/todos/*` for on-disk schema compatibility; those paths are data compatibility, not `spark-*` package ownership.

The canonical tool is singular `task`; TODO operations are sub-actions of `task` rather than a separate TODO package.
