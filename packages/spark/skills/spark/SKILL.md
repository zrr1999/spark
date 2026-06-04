---
name: spark
description: Use for turning an initial or ambiguous project intent into SPARK.md, a project/task DAG, artifacts, reviews, asks, and a role plan through the /spark command.
---

# Spark

Spark extensions are dual-host: the same retained extension packages should run under Pi's `@earendil-works/pi-coding-agent` host and under the native `spark-cli` host via `SparkHostRuntime` / `pi-extension-api`. Keep shared extension behavior host-neutral; put native CLI boot, provider/model selection, sessions, skills, and pi-tui wrappers in `packages/spark-cli/src/host/` or `packages/spark-cli/src/tui/`.

Use Spark command modes intentionally: `/spark <idea>` for initialization/autodetection, `/research <focus>` for investigation, `/plan <focus>` for task-DAG refinement, `/execute <focus>` for one default execution step, and `/workflow[:selector] <focus>` for Spark-owned workflows. Builtins are intentionally minimal: `/workflow:goal` and `/workflow:ready`; scripted workflows use `/workflow workspace:<name>` and `/workflow user:<name>`. Do not reintroduce legacy `/run*` or `/goal` command guidance.

Spark primitives:

- `spark-core`: shared refs, schemas, and typed artifact storage/provenance.
- `pi-ask` (and `packages/spark/src/extension/spark-ask-tool.ts` for the Spark-specific persistence/replay wrapper): structured decisions and approvals.
- `pi-cue`: reusable controlled execution infrastructure.
- `pi-roles`: reusable `RoleSpec`s plus simple `fresh | forked` child Pi `RoleRun` helpers.
- `spark-tasks`: project/task DAG and task planning helpers.
- `spark-runtime`: single Spark task execution adaptation over `pi-roles` runs.
- `spark-workflows`: Spark-owned workflow runtime/builtin primitives, `/workflow:goal` continuation, `/workflow:ready` frontier scheduling, workflow-run state persisted in `.spark/workflow-runs.json`, and role-run adapter boundaries.

Rules:

1. A task must belong to a project.
2. Do not create placeholder tasks or projects for display; tasks are model-claimed only when concrete work exists, and a session may claim multiple tasks only within the active project.
3. Use the dedicated `spark_plan_tasks` tool to梳理/organize multiple tasks before assigning roles; planning tasks must not be represented by claiming many unfinished tasks in the current session. `spark_plan_tasks` writes directly after readiness checks pass and can be used whenever the actual request requires durable task planning; `/plan` only injects stronger planning guidance, not an authorization gate.
4. Tasks must be concrete executable/review/validation/research work. Do not create standalone “design”, “规划”, or “planning” tasks; discuss design/architecture decisions with the user first, then embed the chosen design, rationale, constraints, alternatives, and evidence requirements inside each concrete `task.plan`.
5. Do not cancel a task while any non-cancelled task depends on it; cancel or revise downstream dependents first, or leave the prerequisite pending/blocked.
6. Executable tasks must bind to a builtin, project, or user role spec via `roleRef`.
7. Running a role only accepts an instruction; no runtime system-prompt patching.
8. Task-generated work must pass plan readiness before persistence; tasks that do not pass are rejected rather than stored as drafts.
9. Store durable context as typed artifacts rather than relying on chat history.
10.   Treat `.spark/` as local runtime state that should be added to `.gitignore`; Spark learnings live under `.learning/` for repo/workspace knowledge or the user learning directory for personal cross-project knowledge.
11.   Treat Spark learnings as evidence-backed reusable judgments for future action, not generic chat memory or source-of-truth replacement; use `spark_learning_search` when prior lessons may be relevant, and current repo/source/tool evidence wins.
12.   Treat SPARK.md as persistent project intent that the extension injects into the active system prompt.
13.   Models may improve Spark display names without asking when the active project title or current task `@name`/title is obviously placeholder, generic, stale, too broad, or inconsistent with the current confirmed intent. Examples include placeholder labels such as `Untitled`, `New project`, `Task`, `TODO`, `Custom input`, or `「自定义输入」`; generic labels such as `Fix bug`, `Implement task`, `Research`, `Review`, `Spark work`, `Update docs`, or `Plan`; and stale labels that describe an older scope than the active request. Use `spark_rename_project` for project metadata and `spark_claim_task` for the claimed task. Display names are mutable labels only: stable `project:*` and `task:*` refs, dependencies, runs, artifacts, and TODOs continue to point at the same entities after a rename. Preserve user-specific intentional names, distinctive project/code names, issue IDs, release names, and ambiguous naming choices; ask with `spark_ask` only when the right name depends on a real user decision.
14.   During initialization and planning, analyze the request and workspace context before asking. Brainstorm the plan shape first, then keep clarifying until all material planning-affecting questions are resolved. Do not use broad, generic, or template intake forms; ask context-specific clarification or decision questions grounded in the actual situation. When user-facing open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, use `spark_ask` instead of leaving those questions as prose. If language is obvious, follow the user's language without a separate language confirmation.
15.   After a decision is confirmed and the next action is clear, continue with that action instead of stopping for another permission prompt.
16.   Show the active project header with task counts plus claimed task / TODO text summaries by default; render independent session TODOs as siblings of the project display. `spark_status` defaults to active unfinished/current-session work; use `view: "summary"` for counts only or `view: "full"` for full history.
17.   Before launching multiple role-runs or parallel workstreams, ask for approval with `spark_ask` unless the user explicitly requested immediate dispatch. Treat no-selection as blocked, not approval; asks do not support automatic timeout.
18.   Prefer Spark-native delegation: inspect roles with `list_roles` / `get_role`, bind concrete tasks to builtin/project/user `roleRef`s, and hand execution to Spark workflow-run scheduling. For default foreground execution, `/execute` claims at most one concrete task and stops. For autonomous foreground execution, `/workflow:goal` uses Spark goal continuation prompts and continues verified task progress until done or blocked. For ready-frontier background execution, `/workflow:ready` uses Spark workflow-run scheduling. For scripted/subagent execution, use workspace workflows and user workflows; workflow `agent()` calls must cross the Spark workflow role-run adapter boundary rather than raw Pi subagent spawning. Use `spark_run_ready_tasks` only for low-level ready-frontier dispatch from a tool call. Use `call_role` only for one-off direct role calls that should stay outside Spark tasks/DAGs.
19.   When using `pi-cue` `run`, prefer direct-exec commands and Pi file tools. Use `/bin/sh -lc` only for real shell features such as redirection, here-docs, variable expansion, or compound conditionals.
20.   Keep temporary plans, role-run reports, and scratch outputs out of the repo root; use `.spark/notes/`, `.spark/role-reports/`, or typed Spark artifacts unless the user asks for committed docs.

## Readiness rules

`spark_plan_tasks` creates or updates durable tasks only from concrete, plan-bound work. Standalone design/planning tasks are invalid: resolve design questions with the user first, then encode the selected design in each concrete task's `plan`. All current `TaskPlanIssue.kind` values are blocking; there are no warning-only `TaskPlanIssue.kind` values today. After readiness passes, `spark_plan_tasks` writes the graph and roadmap refs directly; refine plans by calling it again with concrete updates.

- `missing_plan` (blocking): the task must have a bound `plan`.
- `missing_objective` (blocking): `plan.objective` must be non-empty.
- `missing_success_criteria` (blocking): `plan.successCriteria` must include at least one observable success criterion.
- `missing_evidence_required` (blocking): `plan.evidenceRequired` must include at least one concrete evidence item required before completion.
- `missing_steps` (blocking): `plan.steps` must include at least one execution step.
- `open_questions` (blocking): `plan.openQuestions` must be empty; resolve material unresolved questions through context-specific `spark_ask` artifacts, then record the decision in the plan/`askRefs`.

`dependsOn` resolution is scoped to the active project. Spark builds the dependency lookup from existing tasks in that project, then creates/updates every task in the same `spark_plan_tasks` batch and adds those batch tasks to the same lookup before adding dependencies. A dependency may therefore point to an earlier or later task in the same batch, or to an existing task in the project. Use a bare task `name` handle (displayed as `@name`, passed without `@`), an exact task `title`, or a `task:*` ref. Unknown dependencies block the plan, and cross-project dependencies are unsupported.
