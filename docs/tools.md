# Tool surface

## `spark`

Commands:

- `/spark <idea>` — initialize or advance the Spark idea-to-task flow. High-confidence prompts route to research, planning, or default execution; prompts that ask for autonomous or workflow-style progress ask before selecting a goal or workflow execute strategy. This is the only command that may materialize root `SPARK.md` during initialization.
- `/research <focus>` — investigate repository/project context and summarize findings without task graph changes or task claims.
- `/plan <focus>` — inject a high-priority planning prompt for research, clarification, and task-DAG creation/refinement. It is prompt guidance, not a permission gate; planning mode does not execute tasks and does not create root `SPARK.md`.
- `/execute <focus>` — enter default execution mode. Claim and finish at most one concrete task; run `/execute` again for one more default step. If the request needs continuous execution, use `/goal`; if it needs scripted execution, use `/workflow[:selector]`.
- `/goal <focus>` — enter or restart autonomous verified foreground goal mode; continue across ready tasks until complete, blocked, or budget-limited. `/goal` requires a concrete `<focus>` when no goal already exists; empty `/goal` asks the agent to clarify the real user goal instead of generating an “Advance project …” template. `/goal` never overwrites an existing active or paused goal: a new `<focus>` is ignored until the existing goal is reviewer-completed or explicitly paused/restarted with the old objective. Foreground goal ticks are idle-interval based, not backlog based: a tick is considered only after the agent has been idle for the goal interval, stale tick context is dropped when the goal pauses or changes, and session reset commands such as reload/resume/new/fork/revert/reset auto-pause active goals before the reset so stale foreground ticks cannot continue from pre-reset state.
- `/workflow[:selector] <focus>` — enter workflow execution mode for saved workflow scripts. Use `/workflow workspace:<name>` for `.spark/workflows/*.js` and `/workflow user:<name>` for `~/.agents/workflows/*.js`. Empty `/workflow` asks which workflow to use or whether to draft a workspace workflow.

Tools:

- `task` — canonical generic project/task/TODO/run graph tool. Use `action: "status" | "project_list" | "project_use" | "project_update" | "claim" | "plan" | "finish" | "todo_update" | "run_ready" | "run_status" | "run_control" | "cache_cleanup"`. This is the external surface for Spark project/task status, planning, claiming, finishing, TODO updates, ready-task scheduling, and background run inspection/control.
- `goal` — Spark goal facade. Use `action: "status" | "infer" | "set" | "start" | "pause"` with optional `scope: "session" | "project"` (default `session`). A project-scoped goal requires a current Project and persists that `projectRef`. Only one goal target can be active per session: starting a session goal while a project goal is active, or a different project goal while another target is active, hard-blocks with guidance to pause or continue the same target. Goal completion is reviewer-owned: the main agent/public tool path cannot mark goals complete; Spark internals apply completion only after a reviewer achieved verdict. A session-scoped goal cannot complete while active session TODOs remain; the deterministic pre-review gate records an unmet review state and asks the main agent to finish or disposition those TODOs first. Legacy `action: "complete"` requests return `goal_completion_reviewer_only`. `/goal` command policy is stricter than the low-level tool: it requires an explicit objective for new command-started goals, does not overwrite existing active/paused goals, uses idle-interval foreground ticks rather than queue/backlog semantics, drops stale goal tick context when the goal pauses/changes, and session reset shutdowns (`reload`, `resume`, `new`, `fork`, `revert`, `reset`) auto-pause active goals before the reset. Generic goal primitives live in `pi-goal`, while Spark owns goal storage, widget integration, reviewer loop policy, and command policy.
- `ask` — canonical generic ask tool. Use `action: "ask"` for structured asks and `action: "flow"` when the fullscreen multi-question flow renderer is required. Focused and flow implementations are internal behind this public surface, not active public/default tools.
- `artifact` — canonical generic artifact/evidence tool. Use `action: "list"`, `"read"`, `"record"`, `"link"`, or `"compact"`; reads are truncated by default and full reads are explicit.
- `learning` — canonical generic evidence-backed learning tool. Use `action: "record" | "search" | "list" | "read" | "mark_stale" | "supersede" | "reject" | "export_markdown" | "import_markdown"`. Learnings remain distinct from recall/memory and use ignored plural local `.learnings/` stores unless explicitly exported.
- `context` — canonical registered context-provider tool. Use `action: "list"` or `action: "preview"` with optional `providerIds`/`budgetChars`; content must come from registered providers such as `spark.active`, not arbitrary prompt text.
- `recall` — canonical controlled recall-candidate tool. Use explicit `scope: "user" | "workspace" | "repo"` with `record_candidate`, `list`, `search`, and `reject`; recall candidates are not `.learnings/` and are not automatic memory.
- `workflow` — canonical saved-script workflow discovery/preview tool. Use `action: "list"` or `action: "read"` with `workspace:<id>` / `user:<id>` selectors; inline workflows and arbitrary paths are rejected. Execution remains through `/workflow[:selector]` host runtime policy.
- `role` — canonical role action tool. Use `action: "list" | "get" | "create" | "call"`; Spark task execution should prefer `task({ action: "run_ready" })` so task claims, run records, and evidence attribution stay coherent.
- `pi-cue` tools (`cue_exec`, `cue_run`, `cue_script`, `script_run`, `script_eval`, `cue_jobs`, `cue_schedule`, `cue_scope`, `cue_history`) — cue-shell execution and job/scope/history management.
- `pi-graft` tools (`graft_patch`, `graft_read`, `graft_write`, `graft_edit`, `graft_delete`, `graft_candidate_from_scratch`, `graft_validate`, `graft_admit`, `graft_show`, `graft_evidence`, `graft_candidates`, `graft_search`, `graft_materialize`, `graft_repo`, ...) — Graft scratch/candidate/patch workflows. `graft_patch` owns patcher-style child runs and exposes only Graft-related tools to the child; unclear patch instructions must be escalated upward instead of applied.

Naming/render policy:

- Use one canonical `tool({ action })` when the operations share a domain/resource, state, permissions, result envelope, and UI/rendering contract.
- Use focused `tool_action` names only for independent discoverable capabilities, materially distinct schemas/risk/UI/result shapes, or external public tool contracts that cannot be collapsed safely.
- Do not keep dual public/default compatibility surfaces. Historical implementation functions may remain internal only when needed to share code behind the canonical public tool.
- Public/default action tools render as `tool action=<value> ...` in TUI call summaries. This includes `task`, `artifact`, `learning`, `recall`, `workflow`, `context`, `goal`, `role`, `ask`, `cue_jobs`, `cue_schedule`, `cue_scope`, and `graft_repo`. Focused graft tools such as `graft_patch` render their main argument directly.

Retired `spark_*` compatibility tools are not part of the active public tool surface. The Spark facade may keep internal implementation modules with historical names while routing model-visible operations through the canonical tools above; do not document or call those internal names as user-facing APIs.

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
   - Project creation compares the requested title/description against
     all existing Projects, including `done` Projects. Likely duplicates
     are a hard block (`duplicate_project`) with candidate refs/titles/status
     and guidance to select/use an existing Project or ask the user when
     ambiguous. This slice does not implement destructive Project merge,
     task moving, or artifact relinking; "merge" means selecting the existing
     Project.
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
   - independent session TODOs from `task({ action: "todo_update", scope: "session" })` are
     stored separately in `.spark/session-todos/<session>.json`;
     TODO display numbers are stored in
     `.spark/todo-display-numbers/<session>.json`
   - expired task claims are swept on active Spark turns and by
     a lightweight background interval; stale claims become
     retryable `pending` tasks, while runtime execution timeouts
     are marked as failed runs
   - Spark workflow-run scheduler invocations are persisted outside the task graph
     in `.spark/workflow-runs.json`; `task({ action: "status" })` includes the
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
     acknowledged via `task({ action: "run_control", control: "ack" })`, which records `acknowledgedAt` and
     `acknowledgedBySession` so status output can stay quiet while preserving
     history. Old workflow-run history is pruned through typed retention
     workflow-run retention actions: dry-run is
     the default, active/running records and unacknowledged problem records are
     preserved, and recent terminal windows are retained globally and per
     project.
   - completion readiness is distinct from task status: a task can
     be marked done while still surfacing missing completion evidence
     when its plan declares `evidenceRequired` and no output artifact
     is attached; role-run execution records output artifacts as the
     first concrete evidence attachment mechanism
   - `task({ action: "finish", status: "done" })` is reviewer-gated:
     Spark resolves the claimed task, runs a read-only forked reviewer
     through the `ReviewerRunner` boundary, persists a `kind="review"`
     artifact, and marks the task done only when the verdict approves.
     Rejected, blocked, malformed, or failed reviewer verdicts return
     transparent feedback (`task_review_failed`) and leave the task
     unfinished/claimed.
   - research/review/plan task completion has a deterministic follow-up
     disposition precheck before reviewer execution: P0/P1/P2/TODO,
     follow-up, recommended-route, next-action, or action-item signals
     in the finish summary or attached output artifacts must be marked
     `created_task`, `already_covered`, `deferred`, `rejected`, or
     `out_of_scope`, otherwise `task({ action: "finish" })` returns
     `followup_disposition_required` without marking the task done.
6. Project / task / TODO text UI is enabled by default for
   the current session:
   - the above-editor widget shows the active Goal line first
     (`Goal/session` or `Goal/project`), then the generated Spark project
     title with task counts (`total/claimed/session-claimed`)
   - tasks render as `@name: title`, task TODOs
     render beneath them as `#n`, and independent session TODOs
     render as siblings of the project display
   - no placeholder task content is shown when no task is claimed
   - active Spark turns include SPARK.md as persistent
     project intent in the system prompt
   - `task({ action: "status" })` defaults to an active, limited diagnostic view;
     use full history explicitly when needed
7. When Spark is active, a turn hint reminds the model to
   use `task`, `artifact`, `ask`, `role`, `learning`, `context`, `recall`, `workflow`, `pi-cue`, and `pi-graft` tools.
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

- `role` — canonical role action tool. Use `action: "list" | "get" | "create" | "call"` instead of adding fragmented role tool names.

The public/default extension surface is `role` only. Historical fragmented role implementations may exist internally behind the canonical adapter, but they are not user-facing APIs and must not be enabled as active default tools.

`role({ action: "call" })` is intentionally minimal and task-agnostic:

- `mode: "fresh"` starts a new child session and is the default;
- `mode: "forked"` requires explicit `forkFromSession` and shares that parent context;
- it does not claim Spark tasks, write Spark artifacts, or schedule DAG work.

Use `task({ action: "run_ready" })` instead when a Spark task should be claimed, attributed, persisted, and tracked by Spark workflow-run state.

## `pi-ask`

- `ask` — canonical ask action tool. `action: "ask"` auto-selects the focused single-question or flow renderer from the request shape; `action: "flow"` forces the fullscreen flow renderer.

The public/default extension surface is `ask` only. Historical focused/flow implementation names are internal dispatch targets behind `ask({ action: "ask" | "flow" })`; new callers should never request them directly.

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
- `ask` and internal focused/flow ask implementations use shared label-first
  summary helpers. Persisted ask artifacts should store both the structured
  `request`/`result` and a human `summary`; automation must use the structured
  ids in `answers[*].values`.
- The flow renderer may run a freeform-only request with only `input` UI available;
  absence of `select` does not imply default answers for that case.

`ask` is the canonical ask surface and must provide clear option descriptions explaining what each choice means. Concrete ask questions belong at the call site where the actual task, blocker, review, or decision context is known. Persisted ask artifacts use the shared `ask-answer` body shape `{ request, result, summary }`.

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
