# pi-tasks

Generic project/task/TODO/run capability for Pi extensions.

`@zendev-lab/pi-tasks` owns task graph contracts, readiness, claims, TODO persistence, task-run records, and the canonical `task` action tool. Prefer constructing `TaskGraphStore` and `TaskTodoStore` with explicit host-owned paths. The exported default stores still read `.spark/projects.json` and `.spark/todos/*` as compatibility defaults for existing local state.

The canonical tool is singular `task`; TODO operations are sub-actions of `task` rather than a separate TODO package.

`roleRef` fields and the persisted `role-run` claim kind remain compatibility attribution for hosts that execute tasks through reusable role specs. New task planning should normally use `kind` as an executor hint and leave role binding to the host/runtime boundary.
