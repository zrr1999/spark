# Role specs and launch modes

This document defines how Spark and `spark-roles` distinguish reusable role definitions from concrete role executions.

## Vocabulary

- **Reusable RoleSpec** — a durable definition of a coding persona: ID/ref, source, description, system prompt, optional origin/metadata, and timestamps.
- **Fresh RoleRun** — a concrete execution that starts a new Pi session from an existing role plus an explicit task instruction and explicit inputs. `fresh` is the default launch mode for Spark workflow execution.
- **Forked RoleRun** — a concrete execution that still references an existing role, but launches with `launch: "forked"` from an explicit parent session/context source.

`fresh` and `forked` are runtime launch modes selected with the `launch` field. They are never role sources. `builtin`, `extension`, `project`, and `user` describe where a reusable role came from. Legacy `managed` and `predefined` terms are rejected instead of being translated at runtime.

## When to use each

### Reusable RoleSpecs

Use a reusable role when the behavior should be named, reviewed, and run more than once: for example reviewer, worker, scout, or a project/domain-specific specialist.

A role spec is not work by itself. Creating or selecting a role must not claim a task, write task-run artifacts, start a subprocess, or imply access to any parent chat/session context. A role can be used by many future runs, and each future run gets its own run identity.

Safety constraints:

- Keep roles free of secrets, live conversation state, transient task data, and machine-specific credentials.
- Persist project/user roles only after the relevant approval flow or repository policy accepts the persona and tool surface; extension roles are package-registered, not user-writable Markdown roles.
- Do not encode launch mode in the role. The same role can be launched fresh or forked by different run requests.
- Represent generated roles with metadata/origin, e.g. `origin.kind: "generated"`, not a separate source.

Attribution:

- Attribute role creation/approval to the role/proposal artifact or registry/store action.
- Use `roleRef` only to identify the definition.
- Do not use a role ref as the concrete actor that owns a task claim or produced a run output.

### Fresh RoleRuns

Use a fresh run as the default for Spark workflow-run execution and most delegated implementation, research, review, or planning work. It is best when the task can be described by a durable task description plus explicit artifacts or files.

Fresh runs provide the cleanest isolation: the child receives the chosen role and task instruction, not the parent session transcript. If context matters, pass it as a task description, input artifact, or linked file so that provenance is reviewable.

Safety constraints:

- Require an existing `roleRef`; do not launch unregistered anonymous roles.
- Pass only the context required for the task. Do not rely on hidden parent chat history.
- Keep task dependencies satisfied before scheduling the run.
- Use runtime timeouts, claim leases, and heartbeats for non-dry-run execution.
- Let `spark-roles` own generic Pi subprocess launch, cancellation, timeout signalling, stdout/stderr capture, and JSONL parsing.
- Let `spark-runtime` own single-task Spark adaptation: claims, heartbeat leases, task status transitions, artifact persistence, and Spark-specific projection of `spark-roles` active-run control results.
- Let `spark-workflows` own graph-level ready task scheduling, dispatch-time executor role assignment, and workflow-run state.
- Prefer Spark-native ready-task execution over manually spawning nested `pi` processes, except when explicitly testing Pi CLI behavior.

Attribution in Spark:

- On non-dry-run scheduling, Spark creates a `TaskClaim` for the concrete run with `kind: "role-run"`.
- `claim.roleRef` is the reusable role; `claim.runName` is the human-readable concrete run instance; `claim.sessionId` is the launching/owner session; `claim.runRef` is the concrete run; and `claim.claimedBy` is the concrete claimant identity, typically derived from `sessionId + runName`.
- `TaskRun.roleRef`, `TaskRun.runName`, and `TaskRun.ownerSessionId` repeat the same distinction for run history.
- Runtime-created artifacts use `kind: "role-run"`, `producer: "task"`, `projectRef`, `taskRef`, `roleRef`, and a note containing the concrete `runName`; the body carries the concrete run record and captured stdout/stderr/events.
- When a task reaches a terminal status, the active claim is cleared and `finishedBy` preserves the owning session and concrete run name for post-completion display.

### Spark role-run observability and controls

Spark keeps role-run UI state canonical by building a `roleRunRegistry` from
structured task runs, active role-run tracking, workflow parent links, usage, and
activity events. UI renderers such as `spark-role-runs` consume that registry;
they do not parse raw role output.

Visible background roles can be inspected and stopped through the workflow-run
surface. Reply and steer delivery is available only when the selected active
role-run exposes an input control channel. Daemon-native role-runs expose that
channel by registering a native controller with `spark-roles`; process-backed
compatibility runs without a controller report `inputControl: "none"`. Control
attempts are intentionally deterministic:

- a control message must be non-empty;
- an explicit `runRef` or `taskRef` narrows the active target before ambiguity
  checks;
- a broad control is refused when multiple active background roles are visible;
- a no-active target is refused rather than queued silently;
- delivered reply/steer attempts record a control artifact and add
  registry-visible `waiting_for_user`/`replied` or `message_activity` events;
- missing-channel or failed delivery records the failed attempt and must not
  create a successful `replied` transition.

The active role-run tracker is workspace-scoped. A role-run from another cwd is
not a valid target for inspect/stop/reply/steer in the current workspace.

### Stale task-claim recovery

Role-run and main-session task claims are lease-protected. If an owner disappears
or a reviewer returns `needs_changes`, use explicit recovery instead of editing
`.spark/projects/<project>/tasks/<task>/task.json` by hand:

- `task_write({ action: "recover", task: "@name" })` releases an eligible
  other-session claim, records recovery evidence, and leaves the task
  pending/unclaimed so it returns to the ready frontier.
- `task_write({ action: "claim", task: "@name" })` may perform the same
  evidence checks and then claim the task in one locked update.
- Recovery refuses current-session claims, active workflow runs, active role-run
  processes, recent owner activity, and active leases unless there is a newer
  `needs_changes` review and no newer owner activity.
- Recovery never marks a task done. Evidence artifacts stay attached so the next
  owner can address reviewer feedback.

### Validation and audit disposition

The role-run TUI/control/recovery work was validated against the package audit
captured in `artifact:5a554db7-6438-441f-b525-1f57ba4aef02`, which compared
Spark with high-download Pi subagent/status packages including
`pi-subagents`, `@tintinweb/pi-subagents`, `@gotgenes/pi-subagents`,
`@danchamorro/pi-subagents`, `@pi-archimedes/subagent`, `pi-hud`,
`pi-powerline-footer`, and `pi-bar`.

Audit checklist D disposition:

- **Passed:** role completion links to Spark task/run records and artifact output
  refs instead of hidden follow-up text. Evidence:
  `artifact:a52c3ae1-43f0-4530-be24-6fc90af89491`,
  `artifact:2dd86717-c0a9-4011-9c05-b2877796cb56`, and
  `artifact:223c907d-7034-4e18-8818-568c34ab03fa`.
- **Passed:** reply/steer events are durable registry activity and control
  attempts have artifact provenance; explicit selectors are filtered before
  ambiguity checks, and failed delivery records a failure without a successful
  activity transition. Evidence: prior needs-change reviews
  `artifact:d8038282-95fe-4068-b490-5c20a8366e74`,
  `artifact:1aa3656c-cf14-43ec-8e06-b14b9acee1fc`, and
  `artifact:f43da8ee-bf94-41ea-ba72-bb162fa5e138` were closed by
  `artifact:223c907d-7034-4e18-8818-568c34ab03fa` and approved in
  `artifact:c00e9bed-c67d-42f4-90f0-410dad1bb06c`. The
  `artifact:f43da8ee-bf94-41ea-ba72-bb162fa5e138` stop-refresh and
  failed-delivery blockers are disposed as closed by the `kill`/`kill_active`
  `spark-role-runs` refresh assertions and selected-target failed-delivery
  test captured in that closure evidence.
- **Passed:** reviewer gates and the Spark task graph consume typed task/run,
  artifact, and review records; the UI board is a projection over the
  `roleRunRegistry` and does not scrape role output.
- **Passed:** stale-claim recovery restores ready-frontier safety without
  auto-completing work. Needs-change reviews were addressed by
  `artifact:a1b457f8-796b-471c-ac68-c6eb8e052999` and approved in
  `artifact:7dfac593-f43b-4f04-8660-6d95f59a3d49`.
- **Deferred:** a production-grade non-Pi executor and richer optional detail
  overlays remain future work; the current scope keeps non-focus-stealing
  status/widget/message surfaces and deterministic controls.
- **Non-goal:** Spark does not replace footer/HUD packages. It publishes compact
  `ctx.ui.setStatus("spark-role-runs", ...)` and a bounded widget so packages
  such as `pi-bar`, `pi-powerline-footer`, and `pi-hud` can coexist instead of
  depending on a Spark-owned footer replacement.

Native `spark-cli` parity is covered through the shared host UI transport:
`SparkNativeTuiApp` renders `setStatus`/`setWidget` surfaces and bridges
notifications, widgets, custom messages, and registered role-run completion
renderers. Component widget factories use a bounded textual fallback in native
mode rather than throwing; reload/resume behavior is covered through task-graph
claim reconstruction and background role-run resume tests.

### Forked RoleRuns

Use a forked run only when the child must continue from an existing session context rather than from explicit task inputs. Examples include continuing an in-progress interactive investigation, reviewing a current session's reasoning with its transcript available, or debugging a problem whose relevant context cannot yet be compacted into artifacts.

Forked runs are not a replacement for explicit artifacts. If the needed context can be summarized or stored as an artifact, prefer a fresh run with that artifact as input.

Safety constraints:

- Require an explicit `forkFromSession` / parent context reference; never infer or silently fork a session.
- Treat a fork as exposing the parent transcript, tool outputs, and any visible sensitive context to the child run.
- Fork only sessions the launcher is allowed to share, and avoid stale or unrelated parent sessions.
- Avoid parallel forked runs that can mutate the same files or claim the same task unless Spark task dependencies and claims make the write ownership explicit.

Attribution:

- A forked run still gets its own `runRef`, `runName`, lifecycle status, stdout/stderr/events, and task claim if it is attached to a Spark task.
- `roleRef` still points to the reusable role, not the parent session.
- `spark-roles` run requests and records carry `launch: "forked"` and `forkFromSession` so consumers can audit why parent context was available.
- Spark artifacts for forked runs use the same task/run provenance as fresh runs and should additionally record the fork source in the artifact body, note, or metadata when the fork source is surfaced to Spark.
- The parent session is context provenance, not the artifact producer; the concrete child run remains the producing actor.

## Default decision rule

Default to a reusable role plus a fresh run. Create or update a reusable role when the persona should outlive the current task. Choose `forked` only when explicit artifacts are insufficient and the launcher has intentionally approved sharing the parent session context.
