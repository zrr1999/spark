# Tool surface

## `spark`

Command:

- `/spark <idea>` — initialize or advance the Spark idea-to-task flow.

Tools:

- `spark_status` — show current Spark thread/task DAG status.
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
2. Init clarification comes before artifact generation when UI is available:
   - Spark asks for the concrete outcome, delivery mode,
     confirmed output language, next action, smallest
     slice, and other key intent fields
   - the output language defaults from the current request
     language, but the user confirms the selection
   - that clarification is persisted as an ask artifact
     and linked into the Spark trace
3. Root-file materialization is separate from activation:
   - `.spark/` is always created
   - root `SPARK.md` is only written when `.git` exists in the current cwd
4. Natural-language detection second:
   - high-confidence new-idea prompts are transformed into `/spark <idea>`
   - ordinary coding tasks are not intercepted
5. When Spark is active, loaded graphs are kept aligned
   with Spark invariants:
   - each thread should have an active interaction/context task
   - each task should carry dynamic TODO state
6. Thread / task / TODO text UI is enabled by default:
   - `/spark` initialization follow-up includes the current
     task and TODO summary
   - `spark_status` remains the full diagnostic view
7. When Spark is active, a turn hint reminds the model to
   use `spark_status`, `spark_run_ready_tasks`, and
   `pi-cue` tools.

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

`pi-ask` is the protocol/tool layer. `spark_ask` builds
richer workflow semantics on top of it.

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
