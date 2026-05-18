# Implementation status

This repo has the full Spark package skeleton and a thin
but end-to-end local vertical slice.

## Implemented

- `spark-core`
   - shared refs
   - runtime validation helpers
   - Spark error classes
   - core contracts for agents, tasks, artifacts, ask, review, cue, and traces
- `spark-artifacts`
   - typed JSON artifact metadata
   - content hashes and blob files
   - provenance and lineage links
   - list/query/diff helpers
- `pi-ask`
   - minimal `ask_user` primitive
   - reusable `ask_flow` state machine, renderer, replay
     helpers, settings, payload store, and result shape
   - single/multi/freeform questions with timeout-aware
     UI resolution
   - direct custom input is accepted without forcing an
     explicit `Other` option choice
- `spark-ask`
   - lightweight Spark ask presets built on top of `pi-ask`
   - Spark-specific copy for thread clarification / agent
     approval / blocker resolution / review decisions
   - type aliases over the generic `pi-ask` flow API
   - dedicated flow helpers: clarify-thread /
     approve-managed-agent / resolve-task-blocker /
     review-gate
- `pi-cue`
   - migrated cue-shell IPC client and full short-name tool surface from `pi-cue-shell`
   - raw TypeScript imports compatible with Pi / Node strip-types loading
   - `run/jobs/status/kill/wait/cron/scopes/log` tool registration
   - daemon auto-start and bash disable policy
- `spark-agents`
   - builtin agent registry
   - managed agent store
   - managed agent proposal to spec conversion
   - agent creation/lookup only; runtime execution lives in `spark-runtime`
- `spark-review`
   - review gates
   - gate policies
   - review artifact body helpers
- `spark-tasks`
   - thread/task DAG
   - cycle detection
   - dependency readiness
   - persisted graph store
   - per-task TODO state with summaries and update ops; TODOs
     are stored outside `.spark/thread.json` snapshots, and
     active sessions can use session-scoped `.spark/todos/<session>.json`
     files to avoid concurrent agent overwrites
   - `name` / `title` / `description` task identity, rendered as `@name: title` in Pi UI
   - unified main-agent/subagent claim schema with lease expiration
   - heartbeat updates via `heartbeatTaskClaim()`
   - stale claim expiry that marks running runs as `claim_stale` and returns tasks to `pending`
   - model-claimed current-task tracking per thread
- `spark-runtime`
   - dry-run task execution through registered agents
   - runtime-created subagent claims and run artifact persistence
   - heartbeat loop for active runtime claims
   - persisted expired-claim sweeper and distinct `runtime_timeout` failure marking
- `spark`
   - `/spark <idea>` command
   - `spark_status` tool
   - `spark_claim_task` tool for named model-claimed current work
   - `spark_update_task_todos` for task-scoped TODOs
   - `spark_update_todos` for independent session TODOs
   - `spark_run_ready_tasks` tool
   - `spark_ask`, `spark_ask_clarify_thread`,
     `spark_ask_approve_agent`,
     `spark_ask_unblock_task`,
     `spark_ask_review_gate`, and `spark_ask_replay` tools
   - `spark_list_agents`, `spark_get_agent`, and `spark_create_managed_agent` tools
   - two-layer activation detection: `SPARK.md` /
     `.spark/thread.json` /
     `~/.config/spark/config.toml` allowlist first,
     high-confidence natural-language idea detection second
   - active-project tool hints for `spark_status`,
     `spark_claim_task`, `spark_update_task_todos`,
     `spark_update_todos`, `spark_run_ready_tasks`, and
     `pi-cue` tools
   - `/spark` initializes state without a broad intake form;
     targeted clarification is deferred until Spark has
     context from the current workspace
   - `.spark/` state is always created; root `SPARK.md` is
     only materialized when `.git` exists in cwd
   - SPARK.md artifact, task graph, agent plan artifact,
     review gate, and run trace generation
   - SPARK.md injection into the active turn system prompt as
     persistent project intent
   - default text UI summary for active thread task counts,
     session-claimed tasks, task TODOs, and independent session
     TODO siblings after Spark initialization and on active Spark turns
   - invariant repair that clears stale current-task refs
     without creating placeholder tasks
   - ask artifacts linked into the Spark run trace when init clarification runs
   - managed agent store hydration before ready-task execution

## Deferred by design

- `spark-github`
- compatibility packages for `pi-subagents` or `pi-cue-shell`
- full autonomous scheduler daemon
- production-grade `pi --mode json` runner hardening
- worktree/merge/release gates
