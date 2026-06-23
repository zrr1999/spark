# Tool surface

## `spark`

Commands:

- Ordinary input — investigate repository/project context, clarify, and summarize without task graph changes or task claims unless the request needs durable planning/execution state. This is the quiet default behavior when no explicit driver command selects another path.
- `/plan <focus>` — inject a high-priority planning prompt for research, clarification, and task graph creation/refinement. It is prompt guidance, not a permission gate; planning mode does not execute tasks and does not create root `SPARK.md`.
- `/implement <focus>` — enter human-blocking implementation mode. Claim and finish one concrete ready task at a time, then continue to the next ready task until the ready frontier is empty, validation/review is pending, or a real blocker requires human input or external action. Canonical asks in `/implement` wait for human input and must not inherit `/goal` reviewer auto-answer.
- `/loop <focus>` — start or resume a persistent foreground loop for open-ended continuous work: monitoring fresh information, periodic repo checks, long-running observation, or continuing until the user stops it. `/loop` can drive repeated research/plan/implement steps and reports blockers, but it is not a `/goal` alias and must not call `goal({ action: "complete" })` or request reviewer-gated completion. `/loop stop`, `/loop pause`, and Chinese pause aliases set the loop status to `paused`; the TUI shows active or paused loops in the existing goal widget slot as `◆ Loop(...)`.
- `/goal <focus>` — enter or restart autonomous verified foreground goal mode; continue across ready tasks until complete or blocked. `/goal` builds on loop primitives plus durable goal objective tracking, reviewer-backed auto-decision/auto-ask during goal work, and reviewer-gated completion at the end. Canonical asks may be auto-resolved by the reviewer only while the goal driver is active; if reviewer auto-answer is unavailable or blocked, Spark records/reports the blocker instead of waiting for raw human input. `/goal` and `/loop` are mutually exclusive foreground drivers for a session: starting one clears the other. `/goal` requires a concrete `<focus>` when no goal already exists; empty `/goal` asks the agent to clarify the real user goal instead of generating an “Advance project …” template. `/goal` never overwrites an existing active or paused goal: a new `<focus>` is ignored until the existing goal has completed through reviewer-gated approval or is explicitly paused/restarted with the old objective. Foreground goal ticks are idle-interval based, not backlog based: a tick is considered only after the agent has been idle for the goal interval, stale tick context is dropped when the goal pauses or changes, and session reset commands such as reload/resume/new/fork/revert/reset auto-pause active goals before the reset so stale foreground ticks cannot continue from pre-reset state.
- `/workflow[:selector] <focus>` — enter workflow execution mode for builtin or saved workflow scripts. Workflow is an independent capability and does not require initialized Spark project/task state. Use `/workflow:research <question>` for the builtin deep-research workflow (query planning, webSearch/fetchContent, cross-checking, cited report), `/workflow:review <focus>` for adversarial review (investigation, critiques, rebuttal, verdict), `/workflow builtin:<id>` for other builtin workflows, `/workflow workspace:<name>` for `.spark/workflows/*.js`, and `/workflow user:<name>` for `~/.agents/workflows/*.js`. Empty `/workflow` and `/workflows` open the blocking workflow navigator to choose a saved workflow, describe a one-off workflow request, or inspect/control persisted dynamic `workflow_run` records (inspect/pause/resume/stop/restart/save/ack, depending on run state).
- `/ultracode <focus>` — explicit opt-in high-effort dynamic workflow generation. Use for substantive complex prompts that should be decomposed into a generated metadata-first JavaScript workflow with bounded fan-out, quality helpers, and `workflow_run` approval/persistence. Do not use it as a hidden default for ordinary prompts.

Tools:

- `task_read` — read-only project/task/TODO/run graph inspection. Use `action: "task_status" | "project_status" | "workspace_status" | "project_list" | "run_status"` for one-task status, one-project status, broad workspace status, project lists, and workflow-run inspection/reconciliation. Scoped status actions are strict: use `workspace_status` for all-project summaries, `project_status` for one project, and `task_status` with `taskRef`/`task` for one task.
- `task_write` — project/task/plan-item graph mutations. Use `action: "project_use" | "project_rename" | "project_metadata_update" | "claim" | "plan" | "finish" | "todo_update" | "cache_cleanup"`; Projects are permanent records, so there is no project finish/status lifecycle action. Project mutations are limited to session-local selection/creation plus rename/metadata updates. Creating or claiming a task is plan-locked, and every task must have a bound `task.plan` before claim succeeds. Goal completion is a separate evidence-based request: the main session calls `goal({ action: "complete" })`, the reviewer audits, and Spark applies the approved transition. Planning and claiming sync concrete `task.plan.items` (derived from imported `steps`/`successCriteria` when needed) into active task plan items; use `todo_update` ops `upsert_done` to intentionally create-and-complete one exact item, and strict `done` when a typo should fail.
- `assign` — explicit Spark assignment/spawn surface. Use `assign({ dryRun: true })` to inspect the ready frontier and `assign({ dryRun: false })` only when dispatching ready tasks through the workflow runtime; `task_write` does not expose `run_ready`, and public `run_control` is not part of the default tool surface.
- `goal` — Spark goal facade. Use `action: "status" | "set" | "start" | "pause" | "resume" | "clear" | "edit" | "complete"`. Goals are session-scoped and infer the objective from the current project when no objective is given, so there is no separate read-only infer action. `goal({ action: "status" })` treats durable goal state as authoritative: when no goal is set it says so explicitly, warns that compact/historical summaries are hints only, and reports the current project relationship/recommended next action when a project is selected. Only one goal can be active per session: starting or setting a goal updates the active session goal in place. Active goal turns may use reviewer-backed canonical ask auto-answer for material decisions; this is scoped to goal work and is separate from final completion approval. Goal completion is reviewer-gated: the main session requests completion with `goal({ action: "complete" })`, the reviewer audits and returns a verdict, and Spark applies the approved state transition. Manual/public pause is also reviewer-gated: the reviewer evaluates whether the pause reason justifies stopping without completion, and rejected pause reviews leave the goal active. Blocked `action: "complete"` requests return structured remaining-work details such as `goal_completion_needs_changes`; approved requests persist the completed goal state. `/goal` command policy requires an explicit objective for new command-started goals, does not overwrite existing active/paused goals, uses idle-interval foreground ticks rather than queue/backlog semantics, drops stale goal tick context when the goal pauses/changes, and session reset shutdowns (`reload`, `resume`, `new`, `fork`, `revert`, `reset`) auto-pause active goals before the reset. Generic goal primitives live in `pi-goal`, while Spark owns goal storage, widget integration, reviewer loop policy, and command policy.
- `ask` — canonical generic ask tool. Use `action: "ask"` for structured asks and `action: "flow"` when the fullscreen multi-question flow renderer is required. Focused and flow implementations are internal behind this public surface, not active public/default tools.
- `artifact` — canonical generic artifact/evidence tool. Use `action: "list"`, `"read"`, `"record"`, `"link"`, or `"compact"`; reads are bounded by `maxChars` and list output is limited by `limit`. `kind` classifies what an artifact IS on a single functional axis (origin lives in `provenance.producer`, lifecycle in record `status`): `document` (prose/markdown deliverables), `record` (structured JSON records of decisions/results/events), `trace` (execution output/transcripts), and `knowledge` (reusable learning material). The record and read paths accept only these four canonical kinds.
- `learning` — canonical generic evidence-backed learning tool. Use `action: "record" | "search" | "list" | "read" | "mark_stale" | "supersede" | "reject" | "export_markdown" | "import_markdown"`. Learnings remain distinct from recall/memory and use ignored plural local `.learnings/` stores unless explicitly exported.
- `context` — canonical registered context-provider tool. Use `action: "list"` or `action: "preview"` with optional `providerIds`/`budgetChars`; content must come from registered providers such as `spark.active`, not arbitrary prompt text.
- `recall` — canonical controlled recall-candidate tool. Use explicit `scope: "user" | "workspace" | "repo"` with `record_candidate`, `list`, `search`, and `reject`; recall candidates are not `.learnings/` and are not automatic memory.
- `workflow` — canonical builtin/saved-script workflow discovery/preview tool. Use `action: "list"` or `action: "read"` with `builtin:<id>` / `workspace:<id>` / `user:<id>` selectors; inline workflows and arbitrary paths are rejected. Execution remains through `/workflow[:selector]` host runtime policy, with builtin registry metadata such as `research` mode applied by Spark command routing.
- `workflow_run` — Spark-owned dynamic workflow execution tool. Use it only for explicit workflow/fan-out/ultracode requests, with either a saved selector, a generated metadata-first JavaScript script, or `runRef` to resume a persisted dynamic run. It routes `agent()` calls through Spark workflow role-run boundaries, stores script hash/body, args, metadata, phases, journal, result/error, base metadata, and required approval provenance in `.spark/dynamic-workflow-runs.json`, and keeps workflow output standalone unless the user explicitly asks to attach it to project/task state. Runs with significant fan-out, web/fetch use, write/isolation/shell tool policy, high token bounds, or long timeouts must be approved through a scoped user/reviewer gate before any child agents run; the approval summary includes script hash, resource bounds, tools, isolation, and Graft base metadata. `agent(..., { isolation: "graft" })` injects the stored base as `GRAFT_BASE_REF`, narrows child tools to Graft scratch/candidate/validation operations, and asks the child to return scratch/candidate/patch refs; env base alone does not isolate direct working-tree writes.
- `role` — canonical role action tool. Use `action: "list" | "get" | "create" | "call" | "model_list" | "model_get" | "model_set" | "model_delete"`; Spark task execution should prefer `assign({ dryRun: true })` so task claims, run records, and evidence attribution stay coherent.
- `pi-cue` tools (`cue_exec`, `cue_run`, `cue_script`, `script_run`, `script_eval`, `cue_jobs`, `cue_resources`, `cue_schedule`, `cue_scope`, `cue_history`) — cue-shell execution and job/scope/history management.
- `pi-graft` tools (`graft_read`, `graft_write`, `graft_edit`, `graft_delete`, `graft_candidate_from_scratch`, `graft_validate`, `graft_admit`, `graft_show`, `graft_evidence`, `graft_candidates`, `graft_search`, `graft_materialize`, `graft_repo`, ...) — explicit Graft scratch/candidate/patch workflows. Patcher-style child runs are provided by explicit extension roles rather than a hidden public patch tool.

Naming/render policy:

- Use one canonical `tool({ action })` when the operations share a domain/resource, state, permissions, result envelope, and UI/rendering contract.
- Use focused `tool_action` names only for independent discoverable capabilities, materially distinct schemas/risk/UI/result shapes, or external public tool contracts that cannot be collapsed safely.
- Do not keep dual public/default surfaces. Shared implementation helpers must be named for their owner/domain, not kept as old `spark_*` tool configs.
- Public/default action tools render as `tool action=<value> ...` in TUI call summaries. This includes `task_read`, `task_write`, `artifact`, `learning`, `recall`, `workflow`, `context`, `goal`, `role`, `ask`, `cue_jobs`, `cue_schedule`, `cue_scope`, and `graft_repo`. `assign` and focused graft lifecycle tools render their main argument directly when they have materially distinct schemas or result envelopes.

Retired `spark_*` tools are not part of the active public or internal tool surface. Spark may keep private helper functions/modules to share implementation code, but canonical tools must not dispatch through old `spark_*` tool configs.

Automatic behavior:

1. Spark default research guidance is always available:
   - active turns receive a default research lens marker even before `.spark/` or `SPARK.md` exists
   - project-bound context is appended only after a graph/current project exists
   - explicit `/plan` and `/implement` remain project-bound and guide the user to create/select a project when no graph exists
2. Project-bound initialization does not include project-idea capture templates:
   - Spark records an initial intent only when durable graph state is needed by the host/tool path and builds
     investigation/planning tasks first
   - Spark does not create placeholder projects/tasks or a
     fake current task just to populate UI; the model should
     use `task_write({ action: "claim" })` only after it has concrete work
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
     language is clear from context
3. SPARK.md idea-capture workflows are external skills, not Spark product defaults:
   - `.spark/` is local runtime state and is created only when durable state is needed by the host/tool path
   - initialization may materialize root `SPARK.md` only when `.git` exists in the current cwd; direct commands and external skills should not rely on that as the default deliverable
4. Natural-language detection follows command guidance:
   - ordinary input stays in default lightweight research/answering unless it explicitly needs durable planning/execution state
   - ordinary coding tasks are not intercepted
5. When Spark is active, loaded graphs are kept aligned
   with Spark invariants:
   - stale current-task refs are cleared, but Spark never
     synthesizes a placeholder task for display
   - task graph snapshots persist project/task/dependency/run
     state in the V2 `.spark/projects/<project>/...` file tree;
     task plan items are intentionally excluded from those files
   - Project creation compares the requested title/description against
     all existing Projects, including legacy-imported Projects. Likely duplicates
     are a hard block (`duplicate_project`) with candidate refs/titles
     and guidance to select/use an existing Project or ask the user when
     ambiguous. This slice does not implement destructive Project merge,
     task moving, or artifact relinking; "merge" means selecting the existing
     Project.
   - `TaskGraphStore` coordinates V2 graph writes with a small
     index lock at `.spark/projects/index.lock` and project-owner
     lock directories at `.spark/projects/locks/<project>.lock`;
     locks are acquired with `mkdir`, record `owner.json` heartbeat
     metadata, retry for up to 10s at 25ms intervals, and remove
     lock directories older than 60s as stale
   - `TaskGraphStore` writes the project tree by materializing a temporary
     `.spark/projects.tmp-*` tree and renaming it into place
   - stale direct saves of previously loaded graphs are rejected:
     if the `.spark/projects/` tree has changed or disappeared since
     that graph was loaded, `save()` throws
     `TaskGraphStoreConflictError` instead of overwriting newer
     state; use `update()` for locked read/modify/write flows
   - task plan item state is loaded from and saved outside `.spark/projects/`; V2 stores it in canonical SQLite at `.spark/todos/todos.sqlite` to avoid concurrent role-run overwrites
   - session-scoped snapshots are import-only data; new planning should use durable project tasks and task plan items
   - expired task claims are swept on active Spark turns and by
     a lightweight background interval; stale claims become
     retryable `pending` tasks, while runtime execution timeouts
     are marked as failed runs
   - Spark workflow-run scheduler invocations are persisted outside the task graph
     in `.spark/workflow-runs.json`; `task_read({ action: "workspace_status" })`
     includes the workflow-run summary, last/active workflow run,
     unacknowledged problem counts, acknowledged known-failure counts,
     and timeout/stale signals
   - Spark lenses are per-turn and are not persisted in
     `.spark/sessions/<session>.json`; that session file keeps only
     the selected current project pointer. Goal and workflow are drivers
     that select or guide a per-turn research/plan/implement lens, while
     workflow-run scheduler state is persisted separately in
     `.spark/workflow-runs.json`
   - before reporting status or starting another background wave,
     Spark reconciles stale `running` workflow-run records from the
     current task graph and active role-run process tracker; runs
     may be marked `succeeded`, `failed`, `timed_out`, or `stale`
   - completed Spark workflow-run scheduler runs persist a concise completion
     follow-up with summary and next actions; workflow-run completion emits
     that follow-up to the session. Known terminal problem runs remain visible
     through `task_read({ action: "run_status" })` until resolved or retained
     through internal workflow-run maintenance; public `run_control` is not a
     default model-facing surface. Old workflow-run history is pruned through typed retention
     workflow-run retention actions: dry-run is
     the default, active/running records and unacknowledged problem records are
     preserved, and recent terminal windows are retained globally and per
     project.
   - background role observability is registry-backed: Spark builds a
     `roleRunRegistry` from task runs, active child-process tracking, workflow
     parent links, usage, recovery, and durable activity events. The
     `spark-role-runs` status/widget surfaces show active, waiting, failed,
     stale/interrupted, and done role-runs without parsing raw role text.
   - `task_read({ action: "run_status" })` can inspect visible background
     role-runs, and internal controls can stop, reply, or steer them. Reply/steer require a non-empty message and exactly one active
     target: pass `runRef` or `taskRef` to disambiguate, because broad controls
     are refused when multiple active role-runs are visible. Successful replies
     and steers record control artifacts and registry-visible activity events;
     failed delivery is recorded as a failed attempt and does not synthesize a
     `replied` success transition.
   - the same `run_status` surface renders persisted dynamic `workflow_run`
     records from `.spark/dynamic-workflow-runs.json` with phase summaries,
     agent journal tail metadata/result snippets, per-agent telemetry, child
     run refs, actual/estimated token totals, optional cost, liveness/rate
     signals, completed results, base metadata, approval provenance, errors, saved-workflow selectors,
     acknowledged state, and next actions. Dynamic workflow controls are deterministic state
     transitions: `pause`, `resume`, `stop`, `restart`, `save`, and `ack`
     require a dynamic runRef; restart resets phases/journal and instructs
     callers to execute with `workflow_run({ runRef })`, save writes the script
     to a controlled workflow file (`.spark/workflows/<id>.js` by default, or
     `~/.agents/workflows/<id>.js` with `workflowScope: "user"`), choosing a
     numeric suffix instead of silently overwriting an existing workflow, and ack hides
     delivered terminal dynamic runs from compact default status.
   - stale task-claim recovery is explicit and evidence-gated. `task_write({
     action: "recover", task: "@name" })` releases a recoverable other-session
     claim, records a recovery artifact, and leaves the task pending/unclaimed
     so it re-enters the ready frontier. `task_write({ action: "claim" })` can
     also perform claim-time recovery before claiming. Both refuse active
     workflow runs, active role-run processes, current-session claims, recent
     owner activity, or active leases without a newer `needs_changes` review.
   - completion readiness is distinct from task status: a task can
     be marked done while still surfacing missing completion evidence
     when its plan declares `evidenceRequired` and no output artifact
     is attached; role-run execution records output artifacts as the
     first concrete evidence attachment mechanism
   - `task_write({ action: "finish", status: "done" })` is reviewer-gated:
     Spark resolves the claimed task, runs a read-only fresh reviewer
     through the `ReviewerRunner` boundary, persists a `kind="record"`
     artifact with `producer="review"`, and marks the task done only when the verdict approves.
     `finish` can also accept structured `evidence` (`changedFiles`,
     `sourceRefs`, `validationCommands`, `notes`) and Spark will create a
     bounded task evidence artifact with `producer="task"`, `projectRef`,
     `taskRef`, and `candidate/task` curation before the reviewer gate.
     Finish results include structured `statusBefore`/`statusAfter`,
     `transition.committed`, `reviewRequired`, reviewer verdict/artifact
     refs, generated and explicit evidence refs, remaining ready tasks, and a
     `projectCompletionCandidate` hint that can recommend `goal({ action: "complete" })`
     when no unfinished project tasks remain. Rejected, blocked, malformed, or failed reviewer verdicts
     return transparent feedback (`task_review_failed`) and leave the task
     unfinished/claimed with a non-committed transition.
   - research/review/plan task completion has a deterministic follow-up
     disposition precheck before reviewer execution: P0/P1/P2/TODO,
     follow-up, recommended-route, next-action, or action-item signals
     in the finish summary or attached output artifacts must be marked
     `created_task`, `already_covered`, `deferred`, `rejected`, or
     `out_of_scope`, otherwise `task_write({ action: "finish" })` returns
     `followup_disposition_required` without marking the task done.
6. Project / task / TODO text UI is enabled by default for
   the current session:
   - the above-editor widget shows the active Goal line first
     (`Goal/session` or `Goal/project`), then the generated Spark project
     title with task counts (`total/claimed/session-claimed`)
   - tasks render as `@name: title`; task plan items render beneath them as `#n` only after the task is claimed by the current session or is an active current-session role-run, while unclaimed ready/pending tasks stay compact
   - no placeholder task content is shown when no task is claimed
   - active Spark turns include SPARK.md as persistent
     project intent in the system prompt
   - `task_read({ action: "project_status" })` defaults to an active, limited diagnostic view for the current project; use `workspace_status` for broad all-project summaries and targeted run/artifact reads for historical evidence
7. When Spark is active, a turn hint reminds the model to
   use `task_read`, `task_write`, `assign`, `artifact`, `ask`, `role`, `learning`, `context`, `recall`, `workflow`, `pi-cue`, and `pi-graft` tools.
8. Spark display-name quality is model-maintained when inspected context
   clearly supports the improvement:
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
     `GitHub integration plan` while the active request is
     about ask UX, or a claimed task titled `Investigate CI` after
     the user has narrowed the task to `Fix Node test runner flags`
   - context-supported fixes can be made without asking by using
     `task_write({ action: "project_rename" })` or `project_metadata_update`
     for project display/metadata and `task_write({ action: "claim" })` for the claimed task. Display names are
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
   - use `task_write({ action: "plan" })` to organize multiple tasks before
     assigning roles instead of claiming many unfinished tasks in
     one session; task planning writes directly after readiness
     checks pass, and `/plan` only injects stronger planning
     guidance rather than gating the tool
   - ask with `ask` before launching multiple role-runs or
     parallel workstreams unless the user explicitly requests
     immediate dispatch; no-selection is not approval
   - prefer Spark-native delegation by binding concrete tasks to
     builtin/extension/project/user reusable role `roleRef`s and handing execution to the
     `assign({ dryRun: true })` workflow-run scheduler or a Spark workflow; this creates concrete
     fresh role-runs with task claims and run artifacts
     attributed to the task/run, while the `roleRef` remains the
     reusable role identity; do not spawn nested `pi` CLI sessions as
     pseudo-roles unless explicitly testing Pi CLI behavior
   - prefer cue-shell direct-exec and Pi file tools; use
     `/bin/sh -lc` only for genuine shell semantics
   - forked role-runs require an explicit parent session or
     context source and should be used only when explicit artifacts are
     insufficient and sharing the parent transcript is intentional
   - keep transient plans, role-run reports, and scratch artifacts
     out of repo root by using `.spark/notes/`,
     `.spark/role-reports/`, or typed artifacts

Example allowlist:

```toml
[activation]
enabled = true
allow_dirs = [
  "/Users/zhanrongrui/workspace/zrr1999/loom-dev/spark",
  "~/workspace/spore-lang"
]
```

## `pi-roles`

- `role` — canonical role action tool. Use `action: "list" | "get" | "create" | "call" | "model_list" | "model_get" | "model_set" | "model_delete"` instead of adding fragmented role tool names.

The public/default extension surface is `role` only. Historical fragmented role implementations may exist internally behind the canonical adapter, but they are not user-facing APIs and must not be enabled as active default tools. Role specs do not carry model policy: `model` and `defaultModel` frontmatter are rejected, and model choices are stored in `.spark/role-model-settings.json` or `~/.agents/role-model-settings.json`.

Builtin role tool profiles are audited from the six-token capability vocabulary `read | write | exec | net | interact | spawn`: `scout=read+net`, `reviewer=read+net+exec`, and `worker=read+net+exec+write`. `record` is folded into `write`; no builtin role receives `interact`, `spawn`, `ask`, `task`, `task_read`, `task_write`, `goal`, `role`, `assign`, `workflow`, or `graft_patch`.

`role({ action: "call" })` is intentionally minimal and task-agnostic:

- `launch: "fresh"` starts a new child session and is the default;
- `launch: "forked"` requires explicit `forkFromSession` and shares that parent context;
- it does not claim Spark tasks, write Spark artifacts, or schedule Spark workflow-run work.

Use `assign({ dryRun: true })` instead when a Spark task should be claimed, attributed, persisted, and tracked by Spark workflow-run state. Ready-task dispatch resolves role models from explicit run input, project settings, then user settings; non-interactive dispatch blocks with guidance when a role model setting is missing.

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

- `cue_exec` — execute commands and create cue-shell jobs. Tool/API runs use the current Pi session working directory by default and pipe mode (`pty: false`) by default; set `pty: true` only for commands that genuinely need terminal semantics. Foreground stdout/stderr are tailed to 16 KiB per stream by default; `tail_bytes` must be positive.
- `cue_run` — run a `.cue` file via cue-shell script mode, mirroring `cue run <file.cue>`. Top-level items execute sequentially and fail fast; per-item stdout/stderr are tailed by default.
- `cue_script` — run an inline `.cue` script body. Use this when the script content is generated in the Pi session; prefer `cue_run` when a real `.cue` file exists on disk.
- `script_run` — run a script file with an explicit `language`. First batch supports `cue-shell` and `python`; `cue-shell` delegates to RunScript, while `python` runs `python3` or the selected `venv` interpreter through cue-shell job execution.
- `script_eval` — run an inline script body with an explicit `language`. Inline Python executes through `python -c` or the selected `venv` interpreter. For script runners, `venv` is python-only and `scope` is cue-shell-only.
- `cue_jobs` — list, inspect, wait for, and stop jobs via `action`. List output is limited to 20 rows by default; `action=status` / `action=wait` output is tailed by default.
- `cue_resources` — inspect resource providers and snapshots via `action: "providers"` or `action: "resources"`.
- `cue_schedule` — add/list/pause/resume/remove scheduled or one-shot jobs. List output is limited to 20 rows by default.
- `cue_scope` — inspect scopes, HEAD env, or cue-shell config. Scope lists are limited to 20 rows by default and omit env unless requested.
- `cue_history` — show recent cue-shell history. Defaults to recent lines plus 16 KiB byte tail; `limit` and `tail_bytes` must be positive.

`pi-cue` also disables the built-in `bash` tool on
session start, matching the old `pi-cue-shell` execution
policy.
