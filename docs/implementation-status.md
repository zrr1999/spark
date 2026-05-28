# Implementation status

This repo has the full Spark package skeleton and a thin
but end-to-end local vertical slice.

## Implemented

- `spark-core`
   - shared refs
   - runtime validation helpers
   - Spark error classes
   - core contracts for roles, tasks, artifacts, ask, review, cue, and traces
- `spark-artifacts`
   - typed JSON artifact metadata
   - content hashes and blob files
   - provenance and lineage links
   - list/query/diff helpers
- `spark-learnings`
   - typed evidence-backed `learning` / `learning-candidate` / `learning-export` records
   - active/candidate/stale/superseded/rejected lifecycle helpers
   - keyword search, explicit Markdown export/import, and legacy `compound-learnings` migration
- `pi-ask`
   - minimal `ask_user` primitive for focused single-question asks
   - reusable `ask_flow` state machine, renderer, replay
     helpers, payload store, and result shape for
     multi-question/fullscreen forms
   - shared ask contract across `ask_user` and `ask_flow`:
     explicit result envelopes, no automatic timeout decisions,
     stable option ids in structured values, user-facing
     labels/descriptions in UI summaries, and consistent
     decision/approval blocking semantics
   - direct custom input is accepted as first-class `customText`
     without forcing callers to add their own `Other` business option
   - fullscreen custom input preserves drafts while navigating,
     commits on Enter, renders committed custom answers as selected,
     and allows optional blank freeform answers to advance as
     `skipped`
- `spark-ask`
   - lightweight Spark ask artifact persistence/replay helpers built on top of `pi-ask`
   - no canned question presets; callers must generate ask questions from concrete task, blocker, review, or decision context
   - type aliases over the generic `pi-ask` flow API
   - no Pi extension registration or workflow ownership; those stay in `spark`
- `pi-cue`
   - migrated cue-shell IPC client and full short-name tool surface from `pi-cue-shell`
   - raw TypeScript imports compatible with Pi / Node strip-types loading
   - `run/jobs/status/kill/wait/cron/scopes/log` tool registration
   - daemon auto-start and bash disable policy
- `pi-roles`
   - reusable `RoleSpec` definitions with `builtin | project | user` sources
   - builtin roles (`scout`, `planner`, `worker`, `reviewer`, `oracle`)
   - project/user Markdown role stores under `.agents/roles` and `~/.agents/roles`
   - compatibility readers for old role/agent paths and `.spark/agents/*.json` migration input
   - generic `fresh | forked` role run mode types
   - Pi JSON-mode CLI argument construction
   - subprocess launch with stdout/stderr capture and tolerant JSONL parsing
   - active-run listing/cancellation and timeout signalling
   - explicit `forkFromSession` requirement for forked runs
   - role-ref requirement for every run request
   - role-spec management tools (`list_roles`, `get_role`, `create_role`)
   - minimal task-agnostic `call_role` tool with dry-run, fresh, and explicit forked modes
- `spark-review`
   - review gates
   - gate policies
   - review artifact body helpers
- `spark-tasks`
   - thread/task DAG
   - cycle detection
   - dependency readiness
   - persisted graph store backed by `TaskGraphStore` at
     `.spark/thread.json`
   - filesystem locking for graph mutations via
     `.spark/thread.json.lock`; lock acquisition uses an atomic
     `mkdir`, writes owner/heartbeat metadata, retries for up to
     10s every 25ms, and removes lock directories older than 60s
   - atomic graph saves: `TaskGraphStore` writes a temporary file
     in `.spark/` and renames it over `.spark/thread.json`
   - stale direct-save protection: saving a graph that was loaded
     before `.spark/thread.json` changed, or after the file was
     removed, throws `TaskGraphStoreConflictError` instead of
     clobbering newer state; locked `update()` is the preferred
     read/modify/write path
   - per-task TODO state with summaries and update ops; TODOs
     are stored outside `.spark/thread.json` snapshots, and
     active sessions can use session-scoped `.spark/todos/<session>.json`
     files to avoid concurrent role-run overwrites
   - `name` / `title` / `description` task identity, rendered as `@name: title` in Pi UI
   - unified main-session/role-run claim schema with lease expiration
   - heartbeat updates via `heartbeatTaskClaim()`
   - stale claim expiry that marks running runs as `claim_stale` and returns tasks to `pending`
   - model-claimed current-task tracking per thread
- `spark-runtime`
   - dry-run task execution through registered roles
   - Spark task execution via `pi-roles` `runRole()` subprocess launch/control, CLI argument, and JSONL helpers
   - runtime-created role-run claims and run artifact persistence
   - heartbeat loop for active runtime claims
   - Spark-specific active role-run tracking for timeout/reconciliation and kill controls
   - persisted expired-claim sweeper and distinct `runtime_timeout` failure marking
- `spark`
   - `/spark <idea>`, `/plan <focus>`, `/execute <focus>`, `/run <focus>`, `/run-sequential <focus>`, and `/run-parallel <focus>` commands. `/execute` is single-task execution; `/run-sequential` persists run-mode state with `maxConcurrency=1`; `/run-parallel` keeps the existing parallel DAG-manager progress; `/run` infers between those strategies.
   - `spark_status` tool
   - `spark_claim_task` tool for named model-claimed current work
   - `spark_update_task_todos` for task-scoped TODOs
   - `spark_update_todos` for independent session TODOs
   - `spark_run_ready_tasks` tool
   - flow-native multi-question `spark_ask` and
     `spark_ask_replay` tools
   - `spark_finish_task`, `spark_list_artifacts`, and `spark_get_artifact` tools
   - `spark_learning_record` / `spark_learning_search` / `spark_learning_list` /
     `spark_learning_read` / lifecycle tools plus explicit Markdown export/import
     for local Spark learnings; legacy `.learnings/{patterns,gotchas,decisions}`
     compound-learnings imports are supported with dry-run by default
   - two-layer activation detection: `SPARK.md` /
     `.spark/thread.json` /
     `~/.config/spark/config.toml` allowlist first,
     high-confidence natural-language idea detection second
   - active-project tool hints for `spark_status`,
     `spark_claim_task`, `spark_update_task_todos`,
     `spark_update_todos`, `spark_run_ready_tasks`, and
     `pi-cue` tools
   - `/spark` initializes state without a generic intake
     template; clarification and decision asks are grounded in
     context from the current workspace, and plan-changing open
     questions should be represented with `spark_ask` rather
     than prose
   - `.spark/` state is always created and should stay Git-ignored;
     root `SPARK.md` is only materialized when `.git` exists in cwd
   - SPARK.md artifact, task graph, role plan artifact,
     review gate, and run trace generation
   - SPARK.md injection into the active turn system prompt as
     persistent project intent
   - default text UI summary for active thread task counts,
     session-claimed tasks, task TODOs, independent session
     TODO siblings, DAG manager state, and run-mode status after Spark initialization and on active Spark turns
   - active-session task TODO files live under
     `.spark/todos/<session>.json`; independent TODOs managed by
     `spark_update_todos` live under
     `.spark/session-todos/<session>.json`, with stable display
     numbers in `.spark/todo-display-numbers/<session>.json`
   - invariant repair that clears stale current-task refs
     without creating placeholder tasks
   - ask artifacts linked into the Spark run trace when init clarification runs
   - project role store hydration before ready-task execution
   - `/run` / `/run-sequential` / `/run-parallel` background orchestration reuses the DAG manager, advances newly unblocked ready work, and records terminal run-mode states (`done`, `blocked`, or `failed`) without queuing synthetic user messages

## Boundary cleanup status

- `pi-roles` is now the generic role package. It owns reusable role specs and simple single child Pi role runs.
- Spark packages keep task DAGs, task claims, TODOs, artifacts, asks, review gates, and DAG manager orchestration.
- Deprecated role-shaped fields and aliases may still be accepted in code as rolling compatibility for persisted state, but new tools/docs should use role terminology. See [role-boundaries.md](./role-boundaries.md) and [role-run-modes.md](./role-run-modes.md).

## Deferred by design

- `spark-github`
- compatibility packages for `pi-cue-shell`
- full autonomous scheduler daemon
- production-grade `pi --mode json` runner hardening
- worktree/merge/release gates
