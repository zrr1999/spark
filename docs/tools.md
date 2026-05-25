# Tool surface

## `spark`

Command:

- `/spark <idea>` — initialize or advance the Spark idea-to-task flow.

Tools:

- `spark_status` — show Spark thread/task status. Defaults to `view: "active"` for unfinished/current-session work, supports `view: "summary"` for counts only, `view: "full"` for done/cancelled history plus read-only `.spark` cache/protected-store summary, and optional `limit` for task rows per thread.
- `spark_use_thread` — set or create this session's current Spark thread.
- `spark_rename_thread` — rename or update metadata for an existing Spark thread without changing task refs.
- `spark_plan_tasks` — create or update multiple durable named tasks (`name` / `title` / `description`) in the active thread from a concrete plan without claiming them for the current session. Each task is plan-bound: callers may provide a structured `plan`, and Spark derives a minimal plan from the task description when omitted. Task dependencies are scoped to the active thread only; cross-thread dependencies are intentionally out of scope.
- `spark_claim_task` — claim or update concrete task work for the current session in the active thread; tasks render as `@name: title`, and optional `roleRef` values are preferred executor hints for orchestrated runs. Claiming is an execution commitment: agents should read the task's bound plan before creating TODOs or executing.
- `spark_update_task_todos` — update TODOs attached to a claimed task.
- `spark_update_todos` — update independent session TODOs that are siblings of the thread display.
- `spark_finish_task` — finish this session's claimed task as `done`, `failed`, or `cancelled` without routing through task planning. When a done task's plan declares `evidenceRequired` but no output artifacts are attached, the tool reports a completion-evidence warning instead of silently treating process/status success as full evidence.
- `spark_run_ready_tasks` — start the Spark orchestrator/DAG manager for ready tasks; dry-run remains synchronous and read-only by default. Ready-task execution assigns reusable role specs at dispatch time and creates fresh `role-run`s by default.
- `spark_dag_manager` — inspect and control persisted DAG manager state with `status`, `reconcile`, `clear_inactive`, and `kill_active` actions. It reads `.spark/dag-runs.json`, reconciles stale running records against the task graph and active role-run process tracker, can clear inactive manager history, and can terminate active background role-run processes.
- `spark_ask` — run a unified flow-native Spark ask workflow with
  one or more questions and persist the result as an ask artifact.
- `spark_ask_replay` — replay the latest or a specified Spark ask artifact.
- `spark_list_artifacts` — list Spark artifacts with compact bounded output.
- `spark_get_artifact` — read a Spark artifact, truncated by default with `full=true` opt-in.
- `spark_learning_record` — record one evidence-backed reusable learning as a local Spark artifact. Learning records are local runtime state under `.spark/`; use export tools for sharing.
- `spark_learning_search` — search active Spark learnings by default. Candidate or inactive learnings are only returned with explicit `includeCandidates`, `includeInactive`, or `status` filters.
- `spark_learning_list` — list local Spark learnings with compact status/category/scope metadata.
- `spark_learning_read` — read one learning by artifact ref or stable id, truncated by default with `full=true` opt-in.
- `spark_learning_mark_stale` — mark a learning stale with a reason while preserving the record for audit.
- `spark_learning_supersede` — mark a learning superseded by one or more replacement learning refs.
- `spark_learning_reject` — reject a learning candidate while preserving the rejected record and reason.
- `spark_learning_export_markdown` — explicitly export selected local learnings to a Markdown artifact and optional file for review or sharing.
- `spark_learning_import_markdown` — import Markdown produced by `spark_learning_export_markdown` or legacy `compound-learnings` `.learnings/{patterns,gotchas,decisions}` Markdown; dry-run by default, `apply=true` persists records, and `deleteLegacyAfterVerifiedExport=true` can remove the legacy source only after an explicit verification export is written.

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
   - each session should have at most one unfinished main-session claim at a time; role-run execution is represented as an auto-claim when the run starts
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
     role-run overwrites
   - independent session TODOs from `spark_update_todos` are
     stored separately in `.spark/session-todos/<session>.json`;
     TODO display numbers are stored in
     `.spark/todo-display-numbers/<session>.json`
   - expired task claims are swept on active Spark turns and by
     a lightweight background interval; stale claims become
     retryable `pending` tasks, while runtime execution timeouts
     are marked as failed runs
   - DAG manager invocations are persisted outside the task graph
     in `.spark/dag-runs.json`; `spark_status` includes the
     manager summary, last/active DAG run, completion counts, and
     timeout/stale signals
   - before reporting status or starting another background wave,
     Spark reconciles stale `running` manager records from the
     current task graph and active role-run process tracker; runs
     may be marked `succeeded`, `failed`, `timed_out`, or `stale`
   - completed DAG manager runs persist a concise completion
     follow-up with summary and next actions; background manager
     completion emits that follow-up to the session
   - completion readiness is distinct from task status: a task can
     be marked done while still surfacing missing completion evidence
     when its plan declares `evidenceRequired` and no output artifact
     is attached; role-run execution records output artifacts as the
     first concrete evidence attachment mechanism
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
   `list_roles` / `get_role`,
   `spark_run_ready_tasks`, `spark_list_artifacts` / `spark_get_artifact`,
   `spark_learning_search` / `spark_learning_record`, and `pi-cue` tools.
8. Spark display-name quality is model-maintained when the
   improvement is obvious:
   - models may update the active thread title and the current
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
     assigning roles instead of claiming many unfinished tasks in
     one session
   - ask with `spark_ask` before launching multiple role-runs or
     parallel workstreams unless the user explicitly requests
     immediate dispatch; no-selection is not approval
   - prefer Spark-native delegation by binding concrete tasks to
     builtin/project/user reusable role `roleRef`s and handing execution to the
     `spark_run_ready_tasks` DAG manager; this creates concrete
     fresh role-runs with task claims and run artifacts
     attributed to the task/run, while the `roleRef` remains the
     reusable role identity; do not spawn nested `pi` CLI sessions as
     pseudo-roles unless explicitly testing Pi CLI behavior
   - prefer cue-shell direct-exec and Pi file tools; use
     `/bin/sh -lc` only for genuine shell semantics
   - forked role-runs require an explicit parent session or
     context source and should be used only when explicit artifacts are
     insufficient and sharing the parent transcript is intentional
   - keep temporary plans, role-run reports, and scratch artifacts
     out of repo root by using `.spark/notes/`,
     `.spark/role-reports/`, or typed artifacts

Example allowlist:

```toml
[activation]
enabled = true
allow_dirs = [
  "/Users/zhanrongrui/workspace/zrr1999/loom-dev/pi-spark",
  "~/workspace/spore-lang"
]
```

## `pi-roles`

- `list_roles` — list builtin/project roles, optionally including user roles.
- `get_role` — inspect one role; the full system prompt is opt-in.
- `create_role` — persist a project role by default, or a user role when explicitly requested.
- `call_role` — call one reusable role directly with an explicit instruction.

`call_role` is intentionally minimal and task-agnostic:

- defaults to `dryRun: true`, returning the exact Pi CLI args that would be launched;
- `dryRun: false` launches one child Pi run;
- `mode: "fresh"` starts a new child session;
- `mode: "forked"` requires explicit `forkFromSession` and shares that parent context;
- it does not claim Spark tasks, write Spark artifacts, or schedule DAG work.

Use `spark_run_ready_tasks` instead when a Spark task should be claimed, attributed, persisted, and tracked by the DAG manager.

## `pi-ask`

- `ask_user` — focused single-question human-input primitive
  with stable result details.
- `ask_flow` — reusable multi-question/fullscreen form protocol,
  state machine, renderer, replay mechanics, and result shape.

`ask_user` and `ask_flow` are peers over the same ask contract, not
primary/fallback implementations. Use `ask_user` for one focused question and
`ask_flow` for multi-question forms or review/replay-heavy interactions.

Shared ask contract:

- Asks do not make automatic timeout decisions; they wait for an answer,
  explicit cancellation, or explicit no-selection from the UI adapter.
- Option `value` is the stable machine id stored in structured results;
  `label` and `description` are user-facing. UI and human summaries should show
  labels/descriptions instead of raw ids.
- Direct custom input is first-class. Custom text is returned as `customText`
  whether it comes from a freeform question or the shared custom-input
  affordance. Fullscreen `Type your own` drafts are preserved during navigation
  but only committed on Enter; committed custom answers render as selected.
- Custom input affordances are UI metadata, not business options. Do not add
  business options named `Other` / `Type your own`.
- Optional blank freeform answers may be submitted as `kind: "skipped"` so
  forms can advance without fabricating user text.
- Decision and approval gates treat `cancelled` and `no_selection` as blocked.
  Submitted custom text is preserved as `answered` + `customText`, but the gate
  still blocks when no required option id was selected.
- `ask_user`, `ask_flow`, and Spark ask wrappers use shared label-first
  summary helpers. Persisted ask artifacts should store both the structured
  `request`/`result` and a human `summary`; automation must use the structured
  ids in `answers[*].values`.
- `ask_flow` may run a freeform-only request with only `input` UI available;
  absence of `select` does not imply default answers for that case.

`spark_ask` builds Spark workflow semantics on top of this contract and must
provide clear option descriptions explaining what each choice means. It is the
canonical Spark flow-native ask surface: prefer `questions[]`, persist
`ask-answer` artifacts as `{ request, result, summary }`, replay from those
artifacts, and treat no-selection/cancelled gate results as blocked. Keep the
package boundary clear: generic ask protocol/TUI/summary behavior belongs in
`pi-ask`; Spark ask artifact persistence/replay helpers belong in `spark-ask`;
concrete ask questions belong at the call site where the actual task, blocker,
review, or decision context is known; Pi tool registration, Spark
option-description validation, artifacts, and replay tool behavior belong in
`packages/spark`.

## `pi-cue`

Resource-oriented tools:

- `cue_exec` — execute commands and create cue-shell jobs. Tool/API runs use the current Pi session working directory by default and pipe mode (`pty: false`) by default; set `pty: true` only for commands that genuinely need terminal semantics. Foreground stdout/stderr are tailed to 16 KiB per stream by default; pass `tail_bytes: 0` for full output.
- `cue_jobs` — list, inspect, wait for, and stop jobs via `action`. List output is limited to 20 rows by default; `action=status` / `action=wait` output is tailed by default.
- `cue_schedule` — add/list/pause/resume/remove scheduled or one-shot jobs. List output is limited to 20 rows by default.
- `cue_scope` — inspect scopes, HEAD env, or cue-shell config. Scope lists are limited to 20 rows by default and omit env unless requested.
- `cue_history` — show recent cue-shell history. Defaults to recent lines plus 16 KiB byte tail; pass `limit: 0` and `tail_bytes: 0` for full history.

`pi-cue` also disables the built-in `bash` tool on
session start, matching the old `pi-cue-shell` execution
policy.
