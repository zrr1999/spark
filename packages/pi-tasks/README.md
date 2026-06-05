# pi-tasks

Generic project/task/TODO/run capability for Pi extensions.

`pi-tasks` is the promoted owner for task graph contracts and the canonical `task` action tool. During the migration it re-exports the existing `spark-tasks` graph implementation so persisted `.spark/projects.json` and `.spark/todos/*` data do not move.

The canonical tool is singular `task`; TODO operations are sub-actions of `task` rather than a separate TODO package.
