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
  - stable ask protocol/result shape
  - single/multi/freeform questions with timeout-aware
    UI resolution
  - direct custom input is accepted without forcing an
    explicit `Other` option choice
- `spark-ask`
  - richer ask workflows built on top of `pi-ask`
  - flow metadata for thread clarification / agent
    approval / blocker resolution / review decisions
  - replay/elaboration-friendly result shape
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
  - instruction-only dry-run runner
  - tolerant JSONL parser and `pi --mode json` runner path
- `spark-review`
  - review gates
  - gate policies
  - review artifact body helpers
- `spark-tasks`
  - thread/task DAG
  - cycle detection
  - dependency readiness
  - persisted graph store
  - per-task dynamic TODO state with summaries and
    update ops
  - current interaction-task tracking per thread
  - dry-run task execution through registered agents
- `spark`
  - `/spark <idea>` command
  - `spark_status` tool
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
    `spark_run_ready_tasks`, and `pi-cue` tools
  - clarification-first Spark init flow that captures
    working title, confirmed output language, objective,
    delivery mode, next action, smallest slice, success
    signal, and non-goals before artifact generation when
    UI is available
  - `.spark/` state is always created; root `SPARK.md` is
    only materialized when `.git` exists in cwd
  - SPARK.md artifact, task graph, agent plan artifact,
    review gate, and run trace generation
  - default text UI summary for thread / task / TODO state
    after Spark initialization
  - invariant repair that keeps an active interaction task
    and per-task TODOs present in loaded Spark graphs
  - ask artifacts linked into the Spark run trace when init clarification runs
  - managed agent store hydration before ready-task execution

## Deferred by design

- `spark-github`
- compatibility packages for `pi-subagents` or `pi-cue-shell`
- full autonomous scheduler daemon
- production-grade `pi --mode json` runner hardening
- worktree/merge/release gates
