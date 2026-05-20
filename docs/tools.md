# Tool surface

## `spark`

Command:

- `/spark <idea>` — initialize or advance the Spark idea-to-task flow.

Tools:

- `spark_status` — show Spark thread/task status. Defaults to `view: "active"` for unfinished/current-session work, supports `view: "summary"` for counts only, `view: "full"` for done/cancelled history, and optional `limit` for task rows per thread.
- `spark_use_thread` — set or create this session's current Spark thread.
- `spark_rename_thread` — rename or update metadata for an existing Spark thread without changing task refs.
- `spark_plan_tasks` — create or update multiple durable named tasks (`name` / `title` / `description`) in the active thread from a concrete plan without claiming them for the current session. Task dependencies are scoped to the active thread only; cross-thread dependencies are intentionally out of scope.
- `spark_claim_task` — claim or update concrete task work for the current session in the active thread; tasks render as `@name: title`, and optional `agentRef` bindings can later be auto-claimed by Spark runtime execution.
- `spark_update_task_todos` — update TODOs attached to a claimed task.
- `spark_update_todos` — update independent session TODOs that are siblings of the thread display.
- `spark_run_ready_tasks` — start the Spark DAG manager for ready tasks; dry-run remains synchronous and read-only by default. Ready-task execution uses reusable agent specs via task `agentRef`s and creates fresh/spec-based subagent runs by default.
- `spark_ask` — run a generic Spark ask workflow and
  persist the result as an ask artifact.
- `spark_ask_clarify_thread` — run the thread-clarification ask flow.
- `spark_ask_approve_agent_spec` — run the agent-spec approval ask flow.
   - Legacy alias: `spark_ask_approve_agent`.
- `spark_ask_unblock_task` — run the task-blocker resolution ask flow.
- `spark_ask_review_gate` — run the review-gate decision ask flow.
- `spark_ask_replay` — replay the latest or a specified Spark ask artifact.
- `spark_list_agent_specs` — list predefined and project reusable agent specs.
   - Legacy alias: `spark_list_agents`.
- `spark_get_agent_spec` — inspect one reusable agent spec.
   - Legacy alias: `spark_get_agent`.
- `spark_create_agent_spec` — create and persist a project reusable agent spec from a proposal shape.
   - Legacy alias: `spark_create_managed_agent`.

Automatic behavior:

1. Explicit activation first:
   - a `SPARK.md` exists in cwd or an ancestor
   - a `.spark/thread.json` exists in cwd or an ancestor
   - cwd is under an allowlisted directory in
     `~/.config/spark/config.toml`
2. `/spark` does not start with a broad intake form:
   - Spark records the initial intent and builds
     investigation/planning tasks first
   - Spark does not create placeholder threads/tasks or a
     fake current task just to populate UI; the model should
     use `spark_claim_task` only after it has concrete work
     from the actual situation
   - each session should have at most one unfinished main-agent claim at a time; subagent assignment is represented as an auto-claim when the run starts
   - initialization does not show a broad upfront form;
     Spark analyzes the request and workspace first, then asks
     only targeted clarification questions for concrete
     ambiguities discovered by that analysis
   - the output language defaults from the current request
     language; do not ask a separate language question when the
     language is obvious
3. Root-file materialization is separate from activation:
   - `.spark/` is always created
   - root `SPARK.md` is only written when `.git` exists in the current cwd
4. Natural-language detection second:
   - high-confidence new-idea prompts are transformed into `/spark <idea>`
   - ordinary coding tasks are not intercepted
5. When Spark is active, loaded graphs are kept aligned
   with Spark invariants:
   - stale current-task refs are cleared, but Spark never
     synthesizes a placeholder task for display
   - task graph snapshots persist thread/task/dependency/run
     state in `.spark/thread.json`; task TODOs are intentionally
     excluded from that snapshot
   - `TaskGraphStore` serializes graph writes with a filesystem
     lock directory at `.spark/thread.json.lock`; the lock is
     acquired with `mkdir`, records `owner.json` heartbeat
     metadata, retries for up to 10s at 25ms intervals, and
     removes lock directories older than 60s as stale
   - `TaskGraphStore` writes `.spark/thread.json` atomically by
     writing a temporary file in `.spark/` and renaming it into
     place
   - stale direct saves of previously loaded graphs are rejected:
     if `.spark/thread.json` has changed or disappeared since
     that graph was loaded, `save()` throws
     `TaskGraphStoreConflictError` instead of overwriting newer
     state; use `update()` for locked read/modify/write flows
   - task-scoped TODO state is loaded from and saved outside
     `.spark/thread.json`; active sessions use a session-scoped
     `.spark/todos/<session>.json` path to avoid concurrent
     agent overwrites
   - independent session TODOs from `spark_update_todos` are
     stored separately in `.spark/session-todos/<session>.json`;
     TODO display numbers are stored in
     `.spark/todo-display-numbers/<session>.json`
   - expired task claims are swept on active Spark turns and by
     a lightweight background interval; stale claims become
     retryable `pending` tasks, while runtime execution timeouts
     are marked as failed runs
6. Thread / task / TODO text UI is enabled by default for
   the current session:
   - the above-editor widget shows the generated Spark thread
     title with task counts (`total/claimed/session-claimed`)
   - tasks render as `@name: title`, task TODOs
     render beneath them as `#n`, and independent session TODOs
     render as siblings of the thread display
   - no placeholder task content is shown when no task is claimed
   - active Spark turns include SPARK.md as persistent
     project intent in the system prompt
   - `spark_status` defaults to an active, limited diagnostic view;
     use `view: "full"` explicitly when full historical task rows are needed
7. When Spark is active, a turn hint reminds the model to
   use `spark_status`, `spark_use_thread`,
   `spark_rename_thread`, `spark_plan_tasks`,
   `spark_claim_task`, `spark_update_task_todos`,
   `spark_update_todos`,
   `spark_list_agent_specs` / `spark_get_agent_spec`,
   `spark_run_ready_tasks`, and `pi-cue` tools.
8. Spark display-name quality is model-maintained when the
   improvement is obvious:
   - agents may update the active thread title and the current
     task `@name`/title when the existing display name is clearly
     placeholder, generic, stale, too broad, or inconsistent with
     the confirmed active intent
   - placeholder examples: `Untitled`, `New thread`, `Task`,
     `TODO`, `Custom input`, `「自定义输入」`, or generated names
     that only mirror an intake placeholder
   - generic or too-broad examples: `Fix bug`, `Implement task`,
     `Research`, `Review`, `Spark work`, `Update docs`, or
     `Plan` when the turn already identifies a narrower outcome
     such as `Harden ask gate semantics` or
     `Document Spark display-name update rules`
   - stale or inconsistent examples: a thread still titled
     `Draft GitHub integration plan` while the active request is
     about ask UX, or a claimed task titled `Investigate CI` after
     the user has narrowed the task to `Fix Node test runner flags`
   - obvious fixes can be made without asking by using
     `spark_rename_thread` for thread metadata and
     `spark_claim_task` for the claimed task. Display names are
     mutable labels only: underlying `thread:*` and `task:*` refs,
     dependency edges, runs, artifacts, and TODO state continue to
     point at the same entities after a rename
   - preserve user-specific intentional names, distinctive
     project/code names, issue IDs, release names, or naming that
     could encode scope/ownership. Ask with `spark_ask` only when
     the right display name reflects a real user decision, such as
     choosing between two plausible scopes, renaming a user-chosen
     project codename, or changing a title that could affect
     external reporting
9. Process guardrails are part of the active prompt and skill:
   - use `spark_plan_tasks` to梳理/organize multiple tasks before
     assigning agents instead of claiming many unfinished tasks in
     one session
   - ask with `spark_ask` before launching multiple agents or
     parallel workstreams unless the user explicitly requests
     immediate dispatch; no-selection is not approval
   - prefer Spark-native delegation by binding concrete tasks to
     builtin/managed `agentRef`s and handing execution to the
     `spark_run_ready_tasks` DAG manager; this creates concrete
     fresh/spec-based subagent runs with task claims and run artifacts
     attributed to the task/run, while the `agentRef` remains the
     reusable spec identity; do not spawn nested `pi` CLI sessions as
     pseudo-agents unless explicitly testing Pi CLI behavior
   - prefer cue-shell direct-exec and Pi file tools; use
     `/bin/sh -lc` only for genuine shell semantics
   - forked-context subagent runs require an explicit parent session or
     context source and should be used only when explicit artifacts are
     insufficient and sharing the parent transcript is intentional
   - keep temporary plans, agent reports, and scratch artifacts
     out of repo root by using `.spark/notes/`,
     `.spark/agent-reports/`, or typed artifacts

Example allowlist:

```toml
[activation]
enabled = true
allow_dirs = [
  "/Users/zhanrongrui/workspace/zrr1999/loom-dev/pi-spark",
  "~/workspace/spore-lang"
]
```

## `pi-ask`

- `ask_user` — minimal structured human-input primitive
  with stable result details.

`ask_user` accepts direct custom input for non-freeform
questions; users are not forced through a separate
`Other / custom input…` option before typing their own
answer.

`pi-ask` is the protocol/tool layer. `ask_flow` owns the
generic multi-question flow UI and replay mechanics;
`spark_ask` builds Spark workflow semantics on top of it.

## `pi-cue`

Short-name tools preserved from `pi-cue-shell`:

- `run` — create and execute a cue-shell job.
- `jobs` — list jobs.
- `status` — inspect a job or cron.
- `kill` — terminate a job or remove a cron.
- `wait` — wait for a job to reach a terminal state.
- `cron` — add/list/pause/resume/remove scheduled jobs.
- `scopes` — list cue-shell environment scopes.
- `log` — show cue-shell history.

`pi-cue` also disables the built-in `bash` tool on
session start, matching the old `pi-cue-shell` execution
policy.
