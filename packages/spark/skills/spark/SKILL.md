---
name: spark
description: Use for turning an initial or ambiguous project intent into SPARK.md, a thread/task DAG, artifacts, reviews, asks, and a role plan through the /spark command.
---

# Spark

Use `/spark <idea>` as the single high-level entry point. Do not expose internal stages as separate user-facing commands.

Spark primitives:

- `spark-core`: shared refs and schemas.
- `spark-artifacts`: typed artifacts with provenance.
- `spark-ask`: structured decisions and approvals.
- `pi-cue`: reusable controlled execution infrastructure.
- `pi-roles`: reusable `RoleSpec`s plus simple `fresh | forked` child Pi `RoleRun` helpers.
- `spark-review`: verification gates.
- `spark-tasks`: thread/task DAG and task planning helpers.
- `spark-runtime`: single Spark task execution adaptation over `pi-roles` runs.
- `spark-orchestrator`: ready task frontier scheduling and DAG manager state.

Rules:

1. A task must belong to a thread.
2. Do not create placeholder tasks or threads for display; tasks are model-claimed only when concrete work exists, and a session may claim multiple tasks only within the active thread.
3. Use the dedicated `spark_plan_tasks` tool to梳理/organize multiple tasks before assigning roles; planning tasks must not be represented by claiming many unfinished tasks in the current session.
4. Executable tasks must bind to a builtin, project, or user role spec via `roleRef`.
5. Running a role only accepts an instruction; no runtime system-prompt patching.
6. Task-generated work must be proposed and validated before persistence.
7. Store durable context as typed artifacts rather than relying on chat history.
8. Treat `.spark/` as local runtime state that should be added to `.gitignore`; share stable learnings only through explicit exports, reports, or committed Markdown artifacts.
9. Treat Spark learnings as evidence-backed reusable judgments for future action, not generic chat memory or source-of-truth replacement; use `spark_learning_search` when prior lessons may be relevant, and current repo/source/tool evidence wins.
10.   Treat SPARK.md as persistent project intent that the extension injects into the active system prompt.
11.   Models may improve Spark display names without asking when the active thread title or current task `@name`/title is obviously placeholder, generic, stale, too broad, or inconsistent with the current confirmed intent. Examples include placeholder labels such as `Untitled`, `New thread`, `Task`, `TODO`, `Custom input`, or `「自定义输入」`; generic labels such as `Fix bug`, `Implement task`, `Research`, `Review`, `Spark work`, `Update docs`, or `Plan`; and stale labels that describe an older scope than the active request. Use `spark_rename_thread` for thread metadata and `spark_claim_task` for the claimed task. Display names are mutable labels only: stable `thread:*` and `task:*` refs, dependencies, runs, artifacts, and TODOs continue to point at the same entities after a rename. Preserve user-specific intentional names, distinctive project/code names, issue IDs, release names, and ambiguous naming choices; ask with `spark_ask` only when the right name depends on a real user decision.
12.   During initialization and planning, analyze the request and workspace context before asking. Do not use broad, generic, or template intake forms; ask context-specific clarification or decision questions grounded in the actual situation. When user-facing open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, use `spark_ask` instead of leaving those questions as prose. If language is obvious, follow the user's language without a separate language confirmation.
13.   After a decision is confirmed and the next action is clear, continue with that action instead of stopping for another permission prompt.
14.   Show the active thread header with task counts plus claimed task / TODO text summaries by default; render independent session TODOs as siblings of the thread display. `spark_status` defaults to active unfinished/current-session work; use `view: "summary"` for counts only or `view: "full"` for full history.
15.   Before launching multiple role-runs or parallel workstreams, ask for approval with `spark_ask` unless the user explicitly requested immediate dispatch. Treat no-selection as blocked, not approval; asks do not support automatic timeout.
16.   Prefer Spark-native delegation: inspect roles with `list_roles` / `get_role`, bind concrete tasks to builtin/project/user `roleRef`s, and hand execution to the `spark_run_ready_tasks` DAG manager. Use `call_role` only for one-off direct role calls that should stay outside Spark tasks/DAGs.
17.   When using `pi-cue` `run`, prefer direct-exec commands and Pi file tools. Use `/bin/sh -lc` only for real shell features such as redirection, here-docs, variable expansion, or compound conditionals.
18.   Keep temporary plans, role-run reports, and scratch outputs out of the repo root; use `.spark/notes/`, `.spark/role-reports/`, or typed Spark artifacts unless the user asks for committed docs.

## Readiness rules

`spark_plan_tasks` creates or updates durable tasks only from concrete, plan-bound work. All current `TaskPlanIssue.kind` values are blocking; there are no warning-only `TaskPlanIssue.kind` values today.

- `missing_plan` (blocking): the task must have a bound `plan`.
- `missing_objective` (blocking): `plan.objective` must be non-empty.
- `missing_success_criteria` (blocking): `plan.successCriteria` must include at least one observable success criterion.
- `missing_evidence_required` (blocking): `plan.evidenceRequired` must include at least one concrete evidence item required before completion.
- `missing_steps` (blocking): `plan.steps` must include at least one execution step.
- `open_questions` (blocking): `plan.openQuestions` must be empty; resolve material unresolved questions through context-specific `spark_ask` artifacts, then record the decision in the plan/`askRefs`.

`dependsOn` resolution is scoped to the active thread. Spark builds the dependency lookup from existing tasks in that thread, then creates/updates every task in the same `spark_plan_tasks` batch and adds those batch tasks to the same lookup before adding dependencies. A dependency may therefore point to an earlier or later task in the same batch, or to an existing task in the thread. Use a bare task `name` handle (displayed as `@name`, passed without `@`), an exact task `title`, or a `task:*` ref. Unknown dependencies block the plan, and cross-thread dependencies are unsupported.
