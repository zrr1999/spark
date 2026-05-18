# Tool surface

## `spark`

Command:

- `/spark <idea>` — initialize or advance the Spark idea-to-task flow.

Tools:

- `spark_status` — show current Spark thread/task DAG status.
- `spark_plan_tasks` — create or update multiple durable tasks in the active thread from a concrete plan without claiming them for the current session.
- `spark_claim_task` — claim or update concrete task work for the current session in the active thread; optionally bind it to a builtin or managed `agentRef` for Spark-native execution.
- `spark_update_task_todos` — update TODOs attached to a claimed task.
- `spark_update_todos` — update independent session TODOs that are siblings of the thread display.
- `spark_run_ready_tasks` — run currently ready Spark tasks, dry-run by default.
- `spark_ask` — run a generic Spark ask workflow and
  persist the result as an ask artifact.
- `spark_ask_clarify_thread` — run the thread-clarification ask flow.
- `spark_ask_approve_agent` — run the managed-agent approval ask flow.
- `spark_ask_unblock_task` — run the task-blocker resolution ask flow.
- `spark_ask_review_gate` — run the review-gate decision ask flow.
- `spark_ask_replay` — replay the latest or a specified Spark ask artifact.
- `spark_list_agents` — list builtin and managed agents.
- `spark_get_agent` — inspect one agent spec.
- `spark_create_managed_agent` — create and persist a
  managed agent from a proposal shape.

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
   - a session can claim multiple tasks, but only from the
     active Spark thread
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
   - task graph snapshots persist Task state in
     `.spark/thread.json`
   - TODO state is loaded from and saved outside
     `.spark/thread.json`; active sessions use a session-scoped
     `.spark/todos/<session>.json` path to avoid concurrent
     agent overwrites
6. Thread / task / TODO text UI is enabled by default for
   the current session:
   - the above-editor widget shows the generated Spark thread
     title with task counts (`total/claimed/session-claimed`)
   - claimed tasks render as `@task: description`, task TODOs
     render beneath them as `#n`, and independent session TODOs
     render as siblings of the thread display
   - no placeholder task content is shown when no task is claimed
   - active Spark turns include SPARK.md as persistent
     project intent in the system prompt
   - `spark_status` remains the full diagnostic view
7. When Spark is active, a turn hint reminds the model to
   use `spark_status`, `spark_plan_tasks`, `spark_claim_task`,
   `spark_update_task_todos`, `spark_update_todos`,
   `spark_list_agents` / `spark_get_agent`,
   `spark_run_ready_tasks`, and `pi-cue` tools.
8. Process guardrails are part of the active prompt and skill:
   - use `spark_plan_tasks` to梳理/organize multiple tasks before
     assigning agents instead of claiming many unfinished tasks in
     one session
   - ask with `spark_ask` before launching multiple agents or
     parallel workstreams unless the user explicitly requests
     immediate dispatch; timeout/no-selection is not approval
   - prefer Spark-native delegation by binding concrete tasks to
     builtin/managed `agentRef`s and running them through
     `spark_run_ready_tasks`; do not spawn nested `pi` CLI
     sessions as pseudo-agents unless explicitly testing Pi CLI
     behavior
   - prefer cue-shell direct-exec and Pi file tools; use
     `/bin/sh -lc` only for genuine shell semantics
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
