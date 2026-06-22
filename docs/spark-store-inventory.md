# Spark `.spark/` store inventory

This inventory is the reviewable contract for local Spark runtime state under a project root. It documents current owners and guarantees; it does not require every store to have the same durability level. Historical `.spark/` paths are retained for on-disk compatibility even when the owning package is now `pi-*`.

## Scope classes

- **Project canonical/protected** stores are project-level Spark state. They are not safe housekeeping targets except through a typed owner API or a future explicit cleanup command with user intent.
- **Session cache** stores live under the project `.spark/` directory but are scoped to a Pi session, owner session, or display cache. They may be stale after sessions finish and are eligible for housekeeping when the owning workflow is terminal or the cache is broken/stale.
- **Legacy/import-only** stores are read for migration or compatibility only. New writes must go to the current owner API.
- **Unstructured scratch** paths are human/agent files under `.spark/` without typed schemas. Prefer typed artifacts for durable workflow evidence.

## Global transaction rules

- `.spark/` and `.learnings/` are local runtime/recall state. They should be ignored by Git; durable shared knowledge must be exported or committed explicitly outside these local artifact stores.
- Each typed store has one owner package/API. Callers should go through that API instead of writing JSON files directly. Where the current implementation has no dedicated store API, that missing owner boundary is called out below rather than hidden.
- Store transaction boundaries are per store file or per artifact metadata file. Spark does **not** provide database-style cross-store transactions.
- Multi-store flows must tolerate partial success. For example, task execution may update `.spark/projects/<project>/...` files and create artifacts/review records separately; compatibility initialization creates graph, TODO, and artifact trace commits separately.
- When a store writes content-addressed blobs plus metadata, metadata is the commit point. Orphan blobs are acceptable and may be reported by housekeeping; they are not evidence until referenced by committed metadata.
- Session caches should be treated as recoverable hints. Losing or deleting a cache file must not delete canonical project/task/artifact history.

## V2 hard-cutover contract

V2 is a **hard cutover**, not a long-lived compatibility layer. Legacy stores may be read by an explicit migration or doctor command, but after validation the runtime must read and write the V2 owner stores only. Missing V2 state after cutover is a `migration_required` / `cutover_incomplete` diagnostic, not permission to silently fall back to V1 files or dual-write old and new locations.

Target layout:

```text
.spark/
  todos/
    todos.sqlite                 # canonical TODO record store
  sessions/
    index.json                   # rebuildable session index
    session-<id>/
      state.json                 # canonical session focus/current-project state
      goal.json                  # canonical session goal state
      loop.json                  # canonical loop driver state
      todo-display-numbers.json  # session UI cache; TODO rows stay in todos.sqlite
      goal-reviews/
        goal-<id>/
          artifact-<id>.json     # subject-owned goal review records
          index.json             # rebuildable subject review index
  projects/
    index.json                   # rebuildable project index
    proj-<id>/
      project.json               # canonical project metadata
      roadmap.json               # canonical project roadmap
      dependencies.json          # canonical task dependency edges for the project
      reviews/
        review-<id>.json         # subject-owned project review records
      tasks/
        task-<id>/
          task.json              # canonical task metadata, artifact refs only
          runs/
            run-<id>.json        # canonical task run records
          reviews/
            artifact-<id>.json   # subject-owned task review records
            index.json           # rebuildable subject review index
  artifacts/                     # unchanged pi-artifacts metadata and blobs
  reviews/
    index.json                   # rebuildable cross-subject review index only
  cache/
    index.sqlite                 # optional rebuildable read-model/projection cache
```

V2 store classification:

| V2 path | Owner package/API | Scope | Policy |
| --- | --- | --- | --- |
| `.spark/todos/todos.sqlite` | `pi-tasks` TODO record store | Canonical TODO state | Only source for task plan-item rows and legacy session-scoped rows after cutover. Uses `node:sqlite`; not a cache. |
| `.spark/sessions/<session>/state.json` | `spark` session store | Canonical session focus state | Replaces flat `.spark/sessions/<owner>.json` after migration; stores current project/task refs, not per-turn mode. |
| `.spark/sessions/<session>/goal.json` | `spark` goal store | Canonical session goal state | Replaces `.spark/session-goals/<session>.json`; stores state plus last-review refs only, while reviewer evidence bodies stay in artifacts/review records. |
| `.spark/sessions/<session>/loop.json` | `spark` loop store | Canonical loop state | Replaces `.spark/session-loops/<session>.json`. |
| `.spark/sessions/<session>/todo-display-numbers.json` | `spark` TODO display helper | Session display metadata | Stable per-session display labels only; TODO bodies remain in SQLite. |
| `.spark/sessions/<session>/hidden-role-run-inbox.json` | `spark` role-run inbox helper | Session inbox metadata | Tracks hidden delivered role-run refs for the owning session. |
| `.spark/sessions/index.json` | `spark` session index builder | Rebuildable index | Rebuilt from per-session directories. Not a source of truth. |
| `.spark/projects/<project>/project.json` | `pi-tasks` project store | Canonical project metadata | Replaces the project metadata slice of `.spark/projects.json`. |
| `.spark/projects/<project>/roadmap.json` | `pi-tasks` project store | Canonical roadmap | One roadmap per project; task refs only. |
| `.spark/projects/<project>/dependencies.json` | `pi-tasks` project store | Canonical dependency edges | Project-owned dependency file to avoid rewriting unrelated projects. |
| `.spark/projects/<project>/tasks/<task>/task.json` | `pi-tasks` task store | Canonical task metadata | Does not embed TODO bodies; stores artifact refs and task state. |
| `.spark/projects/<project>/tasks/<task>/runs/<run>.json` | `pi-tasks` run store | Canonical run record | Split from the monolithic task graph run array. |
| `.spark/projects/**/reviews/<artifact>.json` and `.spark/sessions/<session>/goal-reviews/<goal>/<artifact>.json` | `spark` review store | Canonical review records | Review records are owned by their subject and include a rebuildable per-subject `index.json`. Artifacts remain detailed evidence. |
| `.spark/reviews/index.json` | `spark` review index builder | Rebuildable index | Listing/projection only. It is not a global gate and must not decide transitions alone. |
| `.spark/artifacts/**` | `pi-artifacts` | Canonical artifact metadata/blob store | Unchanged; project/task/session records reference curated artifact refs instead of embedding bodies. |
| `.spark/cache/index.sqlite` | index/cache owner TBD | Rebuildable cache | Optional projection cache; safe to delete and rebuild. Never canonical for project/task/TODO/review truth. |

Legacy import-only paths after V2 cutover:

- `.spark/projects.json` and `.spark/projects.json.lock/`
- `.spark/todos/<session>.json` and legacy `.spark/todos.json`
- `.spark/sessions/<owner>.json` flat session pointer files
- `.spark/session-goals/<session>.json`
- `.spark/session-loops/<session>.json`
- `.spark/session-todos/<session>.json`
- `.spark/todo-display-numbers/<session>.json`
- `.spark/background-role-results-inbox/<session>.json`
- `.spark/review-gate.json`

Migration/doctor rules:

1. The state doctor implementation reports discovered V1 stores, target V2 paths, conflicts, and whether hard cutover can proceed.
2. The store-v2 migration implementation previews backup/import/index actions in dry-run mode; applying it creates a timestamped `.spark/backups/store-v2-*` backup, imports legacy state into V2 owner stores, and rebuilds indexes. The apply path is idempotent and leaves legacy files import-only for manual verification/removal.
3. Runtime V2 code must not dual-write V1 and V2 stores. If a V2 canonical store is missing, fail with an actionable migration diagnostic instead of reading legacy state implicitly.
4. Index rebuilds may delete and recreate `.spark/sessions/index.json`, `.spark/projects/index.json`, `.spark/reviews/index.json`, and `.spark/cache/index.sqlite`; they must not rewrite canonical owner files except through typed repair actions.
5. Review gate policy is transition logic. Review records are entities owned by their task, project, or session goal; a global `reviews/gate.json` is not part of V2.

## Inventory

| Path                                                                                  | Current owner package/API                                                                                                       | Scope                                                | Main API / facade                                                                                                                                                          | Policy                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `.spark/projects/index.json` and `.spark/projects/<project>/...`                      | `pi-tasks` / `TaskGraphStore` V2 project-tree layout                                                                             | Project canonical/protected                          | `defaultTaskGraphStore(cwd)`, `load()`, `save()`, `update()`, `withLock()`; facade `task_read` / `task_write` / `assign`                                                    | Per-project/task file tree is the runtime write path. `index.json` is rebuildable; project/task files are not generic cache.           |
| `.spark/projects/index.lock/` and `.spark/projects/locks/<project>.lock/`             | `pi-tasks` / `TaskGraphStore` internals                                                                                         | Index/project lock metadata                          | internal lock owner heartbeat                                                                                                                                              | Lock directories only; housekeeping may remove stale locks, not data.                                                                  |
| `.spark/projects.json` and `.spark/projects.json.lock/`                               | `pi-tasks` legacy importer                                                                                                      | Legacy/import-only graph snapshot                    | future migration/doctor import path                                                                                                                                        | Import-only during migration/doctor. Runtime V2 code must not write or fall back to this path.                                          |
| `.spark/todos/todos.sqlite`                                                           | `pi-tasks` / `TaskTodoStore` SQLite compatibility/projection store                                                                | Canonical/protected task plan-item projection and legacy session-scoped records | `defaultTaskTodoStore(cwd, scope)`, `TaskTodoStore.load/save/hydrate()`, `loadSessionTodos()`, `saveSessionTodos()`; facade `task_write({ action: "todo_update" })` for task plan items | Hard-cutover V2 task progress truth lives in `TaskPlan.items`; this store persists task plan-item projections and legacy session-scoped compatibility rows. Protected; not a cache.                         |
| `.spark/todos/<session>.json`                                                         | `pi-tasks` / legacy `TaskTodoStore` JSON importer                                                                                | Legacy/import-only task plan-item snapshots          | `TaskTodoStore.importLegacyTaskTodoFile()`                                                                                                                                  | Import-only during migration/doctor. Runtime V2 code must not write or fall back to this path.                                          |
| `.spark/sessions/<session>/state.json`                                                | `spark` extension session directory store                                                                                       | Canonical/protected session focus state              | `loadCurrentProjectState()`, `saveCurrentProjectRef()`, `clearCurrentProjectRef()`, facade `task_write({ action: "project_use" })` and command modes                              | V2 current-project/current-task pointer; per-turn lenses are not persisted here. Protected as session state.                             |
| `.spark/sessions/<session>/goal.json`                                                 | `spark` extension goal store                                                                                                    | Canonical/protected session goal state               | `loadSessionGoal()`, `setSessionGoal()`, `updateSessionGoalStatus()`                                                                                                       | Goal state belongs to the session directory and stores last-review refs only; reviewer evidence bodies remain in artifacts/reviews.     |
| `.spark/sessions/<session>/loop.json`                                                 | `spark` extension loop store                                                                                                    | Canonical/protected foreground loop state            | `loadSessionLoop()`, `setSessionLoop()`, `clearSessionLoop()`                                                                                                             | Loop state belongs to the session directory.                                                                                            |
| `.spark/sessions/<session>/todo-display-numbers.json`                                 | `spark` extension TODO display helper                                                                                           | Session display metadata                             | `loadTodoDisplayNumberState()`, `assignTodoDisplayNumber()`, `saveTodoDisplayNumberState()`                                                                                | Losing it only renumbers display labels; TODO bodies live in `.spark/todos/todos.sqlite`.                                               |
| `.spark/sessions/<session>/hidden-role-run-inbox.json`                                | `spark` extension role-run inbox helper                                                                                         | Session hidden inbox metadata                        | `loadHiddenRoleRunInboxState()`, `saveHiddenRoleRunInboxState()`                                                                                                          | Tracks delivered hidden role-run refs for the owning session.                                                                           |
| `.spark/sessions/index.json`                                                          | `spark` session index builder                                                                                                   | Rebuildable session index                            | `rebuildSessionIndex()`                                                                                                                                                    | Read-model rebuilt from per-session directories; not a source of truth.                                                                 |
| `.spark/sessions/<owner>.json`                                                        | `spark` extension legacy importer                                                                                               | Legacy/import-only current-project snapshot          | `importLegacyCurrentProjectState()`                                                                                                                                         | Import-only during migration/doctor. Runtime V2 code must not write or fall back to this path.                                          |
| `.spark/session-todos/<session>.json`                                                 | `spark` extension facade legacy importer                                                                                        | Legacy/import-only session-scoped snapshots | `importLegacyIndependentTodos()`                                                                                                                                             | Import-only during migration/doctor; new planning uses durable project tasks and task plan items.                    |
| `.spark/todo-display-numbers/<session>.json`                                          | `spark` extension legacy importer                                                                                               | Legacy/import-only session display snapshot          | `importLegacyTodoDisplayNumberState()`                                                                                                                                      | Import-only during migration/doctor. Runtime V2 display numbers live under `.spark/sessions/<session>/`.                                |
| `.spark/background-role-results-inbox/<session>.json`                                 | `spark` extension legacy importer                                                                                               | Legacy/import-only hidden role-run inbox snapshot    | `importLegacyHiddenRoleRunInboxState()`                                                                                                                                     | Import-only during migration/doctor. Runtime V2 hidden inbox state lives under `.spark/sessions/<session>/`.                            |
| `.spark/workflow-runs.json`                                                           | `pi-workflows` / `WorkflowRunStore`                                                                                              | Project canonical/protected workflow-run state       | `defaultSparkWorkflowRunStore(cwd)`, `status()`, `startRun()`, `recordSchedule()`, `recordProgress()`, `finishRun()`, `reconcile()`, `acknowledgeFailures()`, `pruneRuns()` | Locked workflow-run snapshot. Protected; retention/prune is typed and dry-run by default. Field names remain for schema compatibility. |
| `.spark/artifacts/<artifact-id>.json`                                                 | Physical owner `pi-artifacts` / `ArtifactStore`; logical producers include `spark`, `spark-runtime`, `pi-ask`, and review flows | Project canonical/protected artifact metadata        | `defaultArtifactStore(cwd)`, `put()`, `update()`, `get()`, `getBody()`, `tryGet()`, `list()`, `linksTo()`, `diff()`, `compactMetadata()`, facade `artifact({ action })`    | Metadata is the commit point. Protected; compaction is explicit and dry-run by default.                                                |
| `.spark/artifacts/blobs/<hash>.<ext>`                                                 | `pi-artifacts` / `ArtifactStore`                                                                                                | Project content-addressed blob store                 | written by `ArtifactStore.put()`; read by `getBody()` / hydrated `get()`                                                                                                   | Blob is evidence only when referenced by committed metadata. Orphan deletion requires explicit cleanup policy.                         |
| `.learnings/<artifact-id>.json` or `$PI_CODING_AGENT_DIR/learning/<artifact-id>.json` | `pi-learnings` / `LearningStore` over `pi-artifacts` storage shape                                                              | Repo/workspace/user learning store                   | `defaultLearningStore(cwd, location?)`, `learning({ action })`                                                                                                             | Local-only by default; share via `learning({ action: "export_markdown" })` or reviewed files outside the local artifact store.         |
| `.spark/artifacts/*` ask-answer records                                               | Logical owner `spark` ask facade over `pi-ask`; physical owner `pi-artifacts`                                                   | Project canonical/protected ask artifacts            | canonical `ask({ action })` path plus shared ask artifact helpers such as `createAskArtifactBody()`                                                                        | Protected workflow evidence. Do not infer approval from missing/cancelled/no-selection artifacts.                                      |
| `.spark/artifacts/*` role-run records                                                 | Logical owner `spark-runtime`; physical owner `pi-artifacts`                                                                    | Project canonical/protected execution evidence       | `runSparkTask()` persists `kind: "role-run"` artifacts with task/run provenance                                                                                            | Protected execution evidence. Full transcript compaction/deletion is never generic cache cleanup and is preview-first.                 |
| `.spark/reviews/index.json`                                                           | `spark` subject review index builder                                                                                            | Rebuildable review index                             | `rebuildWorkspaceReviewIndex(cwd)`                                                                                                                                         | Rebuildable from subject-owned task/project/session review records; not a gate and not a source of truth.                              |
| `.spark/projects/<project>/roadmap.json`                                              | `pi-tasks` / `TaskGraph`; planning helpers in `spark` roadmap flow                                                              | Project canonical/protected 1:1 roadmap              | `createProject()` bootstraps one roadmap per project; `/plan` reads active/matching items and `task_write({ action: "plan" })` attaches produced task refs to roadmap items only | Protected project state via project-tree store. Legacy `.spark/roadmap.json` is no longer read.                                        |
| `.spark/notes/`                                                                       | No typed package owner                                                                                                          | Project protected unstructured notes                 | file tools / manual Markdown files only                                                                                                                                    | Protected from automatic cache cleanup. Use typed artifacts or committed docs for durable/shareable records.                           |
| `.spark/role-reports/`                                                                | No typed package owner                                                                                                          | Unstructured scratch                                 | file tools / role-run reports only                                                                                                                                         | Not canonical workflow state. Prefer typed `role-run` artifacts for evidence that should survive cleanup.                              |

## Owner boundaries by package

- `pi-tasks` owns the `TaskGraph` schema and the SQLite TODO record store schema. It must not execute roles or write Spark artifacts directly.
- `pi-artifacts` owns physical artifact metadata and blobs through `ArtifactStore`. Producers own the meaning of their artifact `kind` and body, but not the filesystem layout.
- `pi-learnings`, Spark ask facade code, `spark-runtime`, and review flows own logical artifact bodies while delegating persistence to `pi-artifacts`.
- `pi-workflows` owns workflow-run invocation state in `workflow-runs.json`; it does not own task graph snapshots.
- `spark` owns per-session directories under `sessions/`, rebuildable `sessions/index.json`, legacy session-scoped compatibility calls over the `pi-tasks` SQLite TODO record store, roadmap planning helpers over per-project roadmaps in `.spark/projects/<project>/roadmap.json`, subject-owned review record writers, and housekeeping summaries that classify cache vs protected state.
- `pi-roles` does not own Spark workflow state and does not read `.spark/` role compatibility paths at runtime.

## Housekeeping strategy

Housekeeping must classify before deleting:

1. **Protected project/session state:** `projects/` project/task tree, `todos/todos.sqlite`, `sessions/<session>/`, `artifacts/`, `workflow-runs.json`, `reviews/index.json`, and `notes/` are report-only unless a typed owner cleanup API says otherwise.
2. **Legacy session/cache state:** flat `sessions/<owner>.json`, `todo-display-numbers/<session>.json`, and background inbox JSON may be reported as safe-to-delete when stale, broken, empty, or tied only to terminal/missing work according to the cache-specific rules above.
3. **Legacy state:** `todos/<session>.json`, `session-todos/<session>.json`, `todos.json`, `session-goals/<session>.json`, and `session-loops/<session>.json` should be explicitly retired after migration; runtime V2 APIs do not write or load them by default.
4. **Scratch:** `role-reports/` and untyped files are not canonical evidence. Cleanup should be conservative and prefer reporting before deletion.
