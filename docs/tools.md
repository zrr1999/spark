# Tool surface

## `spark`

Commands:

- `/spark <idea>` — initialize or advance the Spark idea-to-task flow. High-confidence prompts route to research, planning, or default execution; prompts that ask for autonomous or workflow-style progress ask before selecting a goal or workflow execute strategy. This is the only command that may materialize root `SPARK.md` during initialization.
- `/research <focus>` — investigate repository/project context and summarize findings without task graph changes or task claims.
- `/plan <focus>` — inject a high-priority planning prompt for research, clarification, and task-DAG creation/refinement. It is prompt guidance, not a permission gate; planning mode does not execute tasks and does not create root `SPARK.md`.
- `/execute <focus>` — enter default execution mode. Claim and finish at most one concrete task; run `/execute` again for one more default step. If the request needs continuous execution, use `/goal`; if it needs scripted execution, use `/workflow[:selector]`.
- `/goal <focus>` — enter autonomous verified foreground goal mode; continue across ready tasks until complete, blocked, or budget-limited. When `<focus>` is omitted, derive the goal from the current project/task state and ask with `ask` if project, scope, or priority is ambiguous.
- `/workflow[:selector] <focus>` — enter workflow execution mode for saved workflow scripts. Use `/workflow workspace:<name>` for `.spark/workflows/*.js` and `/workflow user:<name>` for `~/.agents/workflows/*.js`. Empty `/workflow` asks which workflow to use or whether to draft a workspace workflow.

Tools:

- `spark_status` — show Spark project/task status. Defaults to `view: "active"` for unfinished/current-session work, supports `view: "summary"` for counts only, `view: "full"` for done/cancelled history plus read-only `.spark` cache/protected-store summary, optional `limit` for task rows per project, and `format: "json"` for a first-class structured status payload instead of human-formatted text.
- `spark_state` — inspect or explicitly clean `.spark` session/cache state. `action: "status"` is read-only; `action: "diagnostics"`/`"doctor"` is read-only and reports protected-store candidates (terminal/no-unfinished projects, inactive workflow runs, large artifacts, orphan blobs, notes, and role reports) using bounded compact metadata; `action: "cleanup"` defaults to `dryRun: true`, only targets safe session/cache files, and never deletes protected stores such as `.spark/projects.json`, artifacts, notes, role reports, workflow runs, or review-gate state. `action: "prune"` is the typed workflow-run retention entry point: it defaults to dry-run, only considers old terminal non-active workflow runs, preserves unacknowledged failed/stale/timed_out records, and keeps the configured newest runs globally and per project. `action: "compact-role-run-artifacts"` is the role-run transcript retention entry point: it defaults to dry-run, lists blobs over `thresholdBytes` with provenance and candidate reason, writes a compact summary plus serialized tail and optional `exportDir` path, and only deletes the full transcript blob on `dryRun:false` after replacement metadata has been written.
- `spark_list_projects` — list Spark projects as structured JSON with task counts and a `currentForSession` marker. Supports `status: "active" | "done" | "all"`.
- `spark_use_project` — set or create this session's current Spark project.
- `spark_rename_project` — rename or update metadata for an existing Spark project without changing task refs.
- `task` — canonical generic project/task/TODO/run graph tool. Use `action: "project_list" | "project_use" | "project_update" | "claim" | "plan" | "finish" | "todo_update" | "run_ready" | "run_status" | "run_control" | "cache_cleanup"` instead of adding new Spark-specific task surfaces. During the migration, Spark supplies host-specific handlers for these actions while existing `spark_*` tools remain available for compatibility until the facade cutover.
- `spark_plan_tasks` — compatibility surface for `task({ action: "plan" })`: create or update multiple durable named tasks (`name` / `title` / `description`) in the active project from a concrete plan without claiming them for the current session. Each task is plan-bound: callers may provide a structured `plan`, and Spark derives a minimal plan from the task description when omitted. The tool writes directly after readiness checks pass and can be used whenever the request requires durable task planning; agents should clarify planning-affecting questions first, then refine by calling it again with concrete updates. Task dependencies are scoped to the active project only; cross-project dependencies are intentionally out of scope. Cancelling a task is rejected while any non-cancelled task still depends on it.
- `spark_claim_task` — compatibility surface for `task({ action: "claim" })`: claim or update concrete task work for the current session in the active project; tasks render as `@name: title`, and optional `roleRef` values are preferred executor hints for orchestrated runs. Claiming is an execution commitment: agents should read the task's bound plan before creating TODOs or executing.
- `spark_update_task_todos` — compatibility surface for `task({ action: "todo_update", scope: "task" })`.
- `spark_update_todos` — compatibility surface for `task({ action: "todo_update", scope: "session" })`.
- `spark_finish_task` — compatibility surface for `task({ action: "finish" })`: finish this session's claimed task as `done`, `failed`, or `cancelled` without routing through task planning or auto-claiming the next task. When a done task's plan declares `evidenceRequired` but no output artifacts are attached, the tool reports a completion-evidence warning instead of silently treating process/status success as full evidence. In `/execute`, a successful finish may mention the next ready task, but the next task remains unclaimed until another `/execute` or an explicit `/goal` continues it.
- `spark_run_ready_tasks` — start or preflight the Spark workflow-run scheduler for ready tasks; dry-run remains synchronous and read-only by default. Ready-task execution assigns reusable role specs at dispatch time and creates fresh `role-run`s by default. This is the low-level orchestration tool; the user-facing command surface is `/research`, `/plan`, `/execute`, `/goal`, and `/workflow[:selector]` rather than legacy `/run*` slash commands.
- `spark_background_runs` — user-facing background work interface with `status`, `list`, `inspect`, `kill`, `reconcile`, and `ack`. It exposes active child role-runs, task claims, pids, run refs, workflow-run progress, legacy timeout records, compact role-run summaries, transcript refs or bounded tail metadata, and next actions. `inspect`/`list` use the compact `role-run` result body and task-run completion summary by default; full stdout/json event transcripts stay behind artifact/transcript refs and are not expanded unless a caller explicitly reads the artifact. Legacy large role-run artifacts are reported by ref with a safe fallback instead of loading full artifact bodies. `kill` requires `runRef`, `taskRef`, or `all:true` and only targets active child role-run processes; `ack` targets failed/stale/legacy `timed_out` problem records.
- `spark_dag_manager` — legacy low-level compatibility/debug control for persisted Spark workflow-run state with `status`, `reconcile`, `ack`, `prune`, `clear_inactive`, and `kill_active` actions. Prefer `spark_background_runs status/inspect/kill` for normal background inspection and `spark_state prune` for auditable retention; `kill_active` targets child role-run processes, and `timed_out` records are legacy actionable problem records rather than the expected status for new detached background runs.
- `ask` — canonical generic ask tool. Use `action: "ask"` for a structured user ask and `action: "flow"` when the fullscreen multi-question flow renderer is required. During migration, Spark-specific persisted ask artifacts remain on `spark_ask` / `spark_ask_replay` until the facade cutover routes persistence through `pi-ask`.
- `spark_ask` — compatibility surface for Spark flow-native asks that persist the result as an ask artifact.
- `spark_ask_replay` — compatibility replay surface for Spark ask artifacts.
- `artifact` — canonical generic artifact/evidence tool. Use `action: "list"` for compact bounded listings, `action: "read"` for default-truncated artifact reads with `full: true` opt-in, `action: "record"` for provenance-backed evidence writes, `action: "link"` for typed artifact lineage, and `action: "compact"` for artifact-retention previews/applies. The old Spark-specific `spark_list_artifacts` / `spark_get_artifact` surfaces are not registered as canonical tools.
- `learning` — canonical generic evidence-backed learning tool. Use `action: "record" | "search" | "list" | "read" | "mark_stale" | "supersede" | "reject" | "export_markdown" | "import_markdown"`. Learnings remain distinct from recall/memory and use ignored plural local `.learnings/` stores unless explicitly exported.
- `context` — canonical registered context-provider tool. Use `action: "list"` or `action: "preview"` with optional `providerIds`/`budgetChars`; content must come from registered providers such as `spark.active`, not arbitrary prompt text.
- `recall` — canonical controlled recall-candidate tool. Use explicit `scope: "user" | "workspace" | "repo"` with `record_candidate`, `list`, `search`, and `reject`; recall candidates are not `.learnings/` and are not automatic memory.
- `workflow` — canonical saved-script workflow discovery/preview tool. Use `action: "list"` or `action: "read"` with `workspace:<id>` / `user:<id>` selectors; inline workflows and arbitrary paths are rejected. Execution remains through `/workflow[:selector]` host runtime policy.
- `spark_learning_record` — compatibility surface for `learning({ action: "record" })`; record one evidence-backed reusable learning under the ignored local `.learnings/` store for the current repo/workspace scope, or in the user learning directory when `location: "user"` is explicit.
- `spark_learning_search` — compatibility surface for `learning({ action: "search" })`; search active learnings by default across the current repo/workspace plus user learnings.
- `spark_learning_list` / `spark_learning_read` — compatibility surfaces for `learning({ action: "list" })` and `learning({ action: "read" })`.
- `spark_learning_mark_stale` / `spark_learning_supersede` / `spark_learning_reject` — compatibility lifecycle surfaces for learning actions.
- `spark_learning_export_markdown` / `spark_learning_import_markdown` — compatibility explicit sharing/import surfaces for Markdown exports and legacy `compound-learnings` imports.

Automatic behavior:

1. Explicit activation first:
   - a `SPARK.md` exists in cwd or an ancestor
   - a `.spark/projects.json` exists in cwd or an ancestor
   - cwd is under an allowlisted directory in
     `~/.config/spark/config.toml`
2. `/spark` does not start with a generic intake template:
   - Spark records the initial intent and builds
     investigation/planning tasks first
   - Spark does not create placeholder projects/tasks or a
     fake current task just to populate UI; the model should
     use `task({ action: "claim" })` only after it has concrete work
     from the actual situation
   - each session should have at most one unfinished main-session claim at a time; role-run execution is represented as an auto-claim when the run starts
   - initialization and planning analyze the request and
     workspace first, then ask context-specific clarification or
     decision questions grounded in that analysis
   - when open questions or decision points would change task
     scope, dependencies, priorities, success criteria,
     evidence, architecture, dependency choices, or
     implementation order, Spark should use `ask` instead
     of leaving those questions as prose
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
   - task graph snapshots persist project/task/dependency/run
     state in `.spark/projects.json`; task TODOs are intentionally
     excluded from that snapshot
   - `TaskGraphStore` serializes graph writes with a filesystem
     lock directory at `.spark/projects.json.lock`; the lock is
     acquired with `mkdir`, records `owner.json` heartbeat
     metadata, retries for up to 10s at 25ms intervals, and
     removes lock directories older than 60s as stale
   - `TaskGraphStore` writes `.spark/projects.json` atomically by
     writing a temporary file in `.spark/` and renaming it into
     place
   - stale direct saves of previously loaded graphs are rejected:
     if `.spark/projects.json` has changed or disappeared since
     that graph was loaded, `save()` throws
     `TaskGraphStoreConflictError` instead of overwriting newer
     state; use `update()` for locked read/modify/write flows
   - task-scoped TODO state is loaded from and saved outside
     `.spark/projects.json`; active sessions use a session-scoped
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
   - Spark workflow-run scheduler invocations are persisted outside the task graph
     in `.spark/workflow-runs.json`; `spark_status` includes the
     workflow-run summary, last/active workflow run, unacknowledged problem
     counts, acknowledged known-failure counts, and timeout/stale
     signals
   - execute-mode state is persisted in this session's
     `.spark/sessions/<session>.json` entry alongside the
     selected project. It records `runRef`, `projectRef`, `focus`,
     `status`, policy, and timestamps; `policy.maxConcurrency` is the
     stored strategy knob, and the widget displays it as a Spark run
     line separate from workflow-run history
   - before reporting status or starting another background wave,
     Spark reconciles stale `running` workflow-run records from the
     current task graph and active role-run process tracker; runs
     may be marked `succeeded`, `failed`, `timed_out`, or `stale`
   - completed Spark workflow-run scheduler runs persist a concise completion
     follow-up with summary and next actions; workflow-run completion emits
     that follow-up to the session. Known terminal problem runs can be
     acknowledged via `spark_background_runs ack` (or low-level
     `spark_dag_manager ack`), which records `acknowledgedAt` and
     `acknowledgedBySession` so status output can stay quiet while preserving
     history. Old workflow-run history is pruned through typed retention
     (`spark_state prune` or low-level `spark_dag_manager prune`): dry-run is
     the default, active/running records and unacknowledged problem records are
     preserved, and recent terminal windows are retained globally and per
     project.
   - completion readiness is distinct from task status: a task can
     be marked done while still surfacing missing completion evidence
     when its plan declares `evidenceRequired` and no output artifact
     is attached; role-run execution records output artifacts as the
     first concrete evidence attachment mechanism
6. Project / task / TODO text UI is enabled by default for
   the current session:
   - the above-editor widget shows the generated Spark project
     title with task counts (`total/claimed/session-claimed`)
   - tasks render as `@name: title`, task TODOs
     render beneath them as `#n`, and independent session TODOs
     render as siblings of the project display
   - no placeholder task content is shown when no task is claimed
   - active Spark turns include SPARK.md as persistent
     project intent in the system prompt
   - `task({ action: "status" })` / `spark_status` defaults to an active, limited diagnostic view;
     use full history explicitly when needed
7. When Spark is active, a turn hint reminds the model to
   use `task`, `artifact`, `ask`, `role`, `learning`, `context`, `recall`, `workflow`, and `pi-cue` tools.
8. Spark display-name quality is model-maintained when the
   improvement is obvious:
   - models may update the active project title and the current
     task `@name`/title when the existing display name is clearly
     placeholder, generic, stale, too broad, or inconsistent with
     the confirmed active intent
   - placeholder examples: `Untitled`, `New project`, `Task`,
     `TODO`, `Custom input`, `「自定义输入」`, or generated names
     that only mirror an intake placeholder
   - generic or too-broad examples: `Fix bug`, `Implement task`,
     `Research`, `Review`, `Spark work`, `Update docs`, or
     `Plan` when the turn already identifies a narrower outcome
     such as `Harden ask gate semantics` or
     `Document Spark display-name update rules`
   - stale or inconsistent examples: a project still titled
     `Draft GitHub integration plan` while the active request is
     about ask UX, or a claimed task titled `Investigate CI` after
     the user has narrowed the task to `Fix Node test runner flags`
   - obvious fixes can be made without asking by using
     `task({ action: "project_update" })` for project metadata and
     `task({ action: "claim" })` for the claimed task. Display names are
     mutable labels only: underlying `project:*` and `task:*` refs,
     dependency edges, runs, artifacts, and TODO state continue to
     point at the same entities after a rename
   - preserve user-specific intentional names, distinctive
     project/code names, issue IDs, release names, or naming that
     could encode scope/ownership. Ask with `ask` only when
     the right display name reflects a real user decision, such as
     choosing between two plausible scopes, renaming a user-chosen
     project codename, or changing a title that could affect
     external reporting
9. Process guardrails are part of the active prompt and skill:
   - use `task({ action: "plan" })` to梳理/organize multiple tasks before
     assigning roles instead of claiming many unfinished tasks in
     one session; task planning writes directly after readiness
     checks pass, and `/plan` only injects stronger planning
     guidance rather than gating the tool
   - ask with `ask` before launching multiple role-runs or
     parallel workstreams unless the user explicitly requests
     immediate dispatch; no-selection is not approval
   - prefer Spark-native delegation by binding concrete tasks to
     builtin/project/user reusable role `roleRef`s and handing execution to the
     `task({ action: "run_ready" })` workflow-run scheduler or a Spark workflow; this creates concrete
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

- `role` — canonical role action tool. Use `action: "list" | "get" | "create" | "call"` instead of adding new fragmented role tool names.
- `list_roles` — compatibility surface for `role({ action: "list" })`; list builtin/project roles, optionally including user roles.
- `get_role` — compatibility surface for `role({ action: "get" })`; inspect one role; the full system prompt is opt-in.
- `create_role` — compatibility surface for `role({ action: "create" })`; persist a project role by default, or a user role when explicitly requested.
- `call_role` — compatibility surface for `role({ action: "call" })`; call one reusable role directly with an explicit instruction.

`role({ action: "call" })` / `call_role` is intentionally minimal and task-agnostic:

- `mode: "fresh"` starts a new child session and is the default;
- `mode: "forked"` requires explicit `forkFromSession` and shares that parent context;
- it does not claim Spark tasks, write Spark artifacts, or schedule DAG work.

Use `task({ action: "run_ready" })` instead when a Spark task should be claimed, attributed, persisted, and tracked by Spark workflow-run state.

## `pi-ask`

- `ask` — canonical ask action tool. `action: "ask"` auto-selects the focused single-question or flow renderer from the request shape; `action: "flow"` forces the fullscreen flow renderer.
- `ask_user` — compatibility focused single-question human-input primitive with stable result details.
- `ask_flow` — compatibility reusable multi-question/fullscreen form protocol, state machine, renderer, replay mechanics, and result shape.

`ask_user` and `ask_flow` remain peers over the same ask contract, not primary/fallback implementations. New callers should use `ask` and let the package choose the focused or flow renderer unless the flow renderer is explicitly required.

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

`ask` is the canonical ask surface and must provide clear option descriptions explaining what each choice means. During migration, `spark_ask` keeps Spark ask artifact persistence/replay as a compatibility wrapper that stores `ask-answer` artifacts as `{ request, result, summary }`; the facade cutover continues moving generic ask protocol/TUI/summary behavior into `pi-ask`. Concrete ask questions belong at the call site where the actual task, blocker, review, or decision context is known.

## `pi-cue`

Resource-oriented tools:

- `cue_exec` — execute commands and create cue-shell jobs. Tool/API runs use the current Pi session working directory by default and pipe mode (`pty: false`) by default; set `pty: true` only for commands that genuinely need terminal semantics. Foreground stdout/stderr are tailed to 16 KiB per stream by default; pass `tail_bytes: 0` for full output.
- `cue_run` — run a `.cue` file via cue-shell script mode, mirroring `cue run <file.cue>`. Top-level items execute sequentially and fail fast; per-item stdout/stderr are tailed by default.
- `cue_script` — run an inline `.cue` script body. Use this when the script content is generated in the Pi session; prefer `cue_run` when a real `.cue` file exists on disk.
- `script_run` — run a script file with an explicit `language`. First batch supports `cue-shell` and `python`; `cue-shell` delegates to RunScript, while `python` runs `python3` through cue-shell job execution.
- `script_eval` — run an inline script body with an explicit `language`. Inline Python is written to a temporary file before execution.
- `cue_jobs` — list, inspect, wait for, and stop jobs via `action`. List output is limited to 20 rows by default; `action=status` / `action=wait` output is tailed by default.
- `cue_schedule` — add/list/pause/resume/remove scheduled or one-shot jobs. List output is limited to 20 rows by default.
- `cue_scope` — inspect scopes, HEAD env, or cue-shell config. Scope lists are limited to 20 rows by default and omit env unless requested.
- `cue_history` — show recent cue-shell history. Defaults to recent lines plus 16 KiB byte tail; pass `limit: 0` and `tail_bytes: 0` for full history.

`pi-cue` also disables the built-in `bash` tool on
session start, matching the old `pi-cue-shell` execution
policy.
