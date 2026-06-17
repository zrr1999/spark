---
name: spark
description: Use for turning an initial or ambiguous project intent into SPARK.md, a project/task DAG, artifacts, reviews, asks, and a role plan through Spark's compatibility entry and canonical task_read/task_write/assign/goal/workflow tools.
---

# Spark

Spark extensions are dual-host: the same retained `pi-*` extension packages should run under Pi's `@earendil-works/pi-coding-agent` host and under the native `spark-cli` host via `SparkHostRuntime` / `pi-extension-api`. Keep shared extension behavior host-neutral; put native CLI boot, provider/model selection, sessions, skills, and pi-tui wrappers in `packages/spark-cli/src/host/` or `packages/spark-cli/src/tui/`.

Use Spark command modes intentionally: research is the unconditional default standing mode and auto-detects when project-bound state is needed; `/research <focus>` investigates, `/plan <focus>` refines the task DAG, `/implement <focus>` runs one default implementation step, `/goal <focus>` drives autonomous verified foreground progress (derive the goal from current Spark state when focus is omitted, asking if ambiguous), and `/workflow[:selector] <focus>` runs saved Spark workflow scripts. Workflows use `/workflow workspace:<name>` and `/workflow user:<name>`. Do not reintroduce legacy run or execute command guidance.

Spark is now a composition/mode facade over generic Pi capabilities:

- `task_read`: canonical read-only project/task/TODO/run graph inspection.
- `task_write`: canonical project/task/TODO graph mutation.
- `assign`: explicit ready-task scheduling/spawn surface.
- `artifact`: canonical evidence/artifact storage and lineage.
- `ask`: canonical structured decisions and approvals.
- `role`: canonical reusable role specs and direct role calls.
- `learning`: canonical evidence-backed `.learnings/` records.
- `context`: registered bounded context providers such as `spark.active`.
- `recall`: explicit scoped recall candidates, distinct from `.learnings/`.
- `workflow`: saved-script workflow discovery/preview from controlled roots.
- `pi-cue`: reusable controlled execution infrastructure.
- `pi-goal` and `pi-workflows`: reusable goal/workflow primitives; Spark owns project-bound `/goal` and `/workflow` command policy.
- `spark-runtime`: Spark-owned single-task role-run adapter for `/implement`, ready-task execution, and role-run artifacts.

Rules:

1. A task must belong to a project.
2. Do not create placeholder tasks or projects for display; tasks are model-claimed only when concrete work exists, and a main session should have at most one unfinished claimed task at a time.
3. Use `task_write({ action: "plan" })` to organize multiple tasks before assigning roles; planning tasks must not be represented by claiming many unfinished tasks in the current session. Planning writes directly once tasks have clear objectives, dependencies, success criteria, and evidence requirements, and can be used whenever the actual request requires durable task planning; `/plan` only injects stronger planning guidance, not an authorization gate.
4. Tasks must be concrete executable/review/validation/research work. Do not create standalone “design” or “planning” tasks; discuss design/architecture decisions with the user first, then embed the chosen design, rationale, constraints, alternatives, and evidence requirements inside each concrete `task.plan`.
5. Do not cancel a task while any non-cancelled task depends on it; cancel or revise downstream dependents first, or leave the prerequisite pending/blocked.
6. Executable tasks must bind to a builtin, extension, project, or user role spec via `roleRef`.
7. Running a role only accepts an instruction; no runtime system-prompt patching.
8. Task-generated work must pass plan readiness before persistence; tasks that do not pass are rejected rather than stored as incomplete plans.
9. Store durable context as typed artifacts rather than relying on chat history.
10.   Treat `.spark/` and repo/workspace `.learnings/` as local state that should be added to `.gitignore`; `learning` records live under `.learnings/` for local repo/workspace evidence-backed knowledge or the user learning directory for personal cross-project knowledge, and shared learnings should be exported explicitly.
11.   Treat learnings as evidence-backed reusable judgments for future action, not generic chat memory or source-of-truth replacement; use `learning({ action: "search" })` when prior lessons may be relevant, and current repo/source/tool evidence wins.
12.   Treat SPARK.md as persistent project intent that the extension injects into the active system prompt.
13.   Models may improve Spark display names without asking when inspected context clearly shows that the active project title or current task `@name`/title is placeholder, generic, stale, too broad, or inconsistent with the current confirmed intent. Examples include placeholder labels such as `Untitled`, `New project`, `Task`, `TODO`, `Custom input`, or `「自定义输入」`; generic labels such as `Fix bug`, `Implement task`, `Research`, `Review`, `Spark work`, `Update docs`, or `Plan`; and stale labels that describe an older scope than the active request. Use `task_write({ action: "project_update" })` for project metadata and `task_write({ action: "claim" })` for the claimed task. Display names are mutable labels only: stable `project:*` and `task:*` refs, dependencies, runs, artifacts, and TODOs continue to point at the same entities after a rename. Preserve user-specific intentional names, distinctive project/code names, issue IDs, release names, and ambiguous naming choices; ask only when the right name depends on a real user decision.
14.   During initialization and planning, analyze the request and workspace context before asking. Outline the plan shape first, then keep clarifying until all material planning-affecting questions are resolved. Do not use broad, generic, or template intake forms; ask context-specific clarification or decision questions grounded in the actual situation. When user-facing open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, use `ask` instead of leaving those questions as prose. If the language is clear from context, follow the user's language without a separate language confirmation.
15.   After a decision is confirmed and the next action is clear, continue with that action instead of stopping for another permission prompt.
16.   Show the active project header with task counts plus claimed task / TODO text summaries by default; render independent session TODOs as siblings of the project display. `task_read({ action: "status" })`/Spark status default to active unfinished/current-session work; use summary/full views only when needed.
17.   Before launching multiple role-runs or parallel workstreams, ask for approval with `ask` unless the user explicitly requested immediate dispatch. Treat no-selection as blocked, not approval; asks do not support automatic timeout.
18.   Prefer Spark-native delegation: inspect roles with `role({ action: "list" | "get" })`, bind concrete tasks to builtin/extension/project/user `roleRef`s, and hand execution to Spark workflow-run scheduling via `assign({ dryRun: true })`. For default foreground implementation, `/implement` claims at most one concrete task and stops. For autonomous foreground implementation, `/goal` uses Spark goal continuation prompts and continues verified task progress until done or blocked; when the user gives no focus, infer the objective from the active project/task state and use `ask` if the project, scope, priority, or ready path is ambiguous. For scripted/subagent execution, use saved workspace/user workflows; workflow `agent()` calls must cross the Spark workflow role-run adapter boundary rather than raw Pi subagent spawning. Use `role({ action: "call" })` only for one-off direct role calls that should stay outside Spark tasks/DAGs.
19.   When using `pi-cue` `run`, prefer direct-exec commands and Pi file tools. Use `/bin/sh -lc` only for real shell features such as redirection, here-docs, variable expansion, or compound conditionals.
20.   Keep transient plans, role-run reports, and scratch outputs out of the repo root; use `.spark/notes/`, `.spark/role-reports/`, or typed Spark artifacts unless the user asks for committed docs.

## Readiness rules

`task_write({ action: "plan" })` creates or updates durable tasks only from concrete, plan-bound work. Standalone design/planning tasks are invalid: resolve design questions with the user first, then encode the selected design in each concrete task's `plan`. All current `TaskPlanIssue.kind` values are blocking; there are no warning-only `TaskPlanIssue.kind` values today. After readiness passes, planning writes the graph and roadmap refs directly; refine plans by calling it again with concrete updates.

- `missing_plan` (blocking): the task must have a bound `plan`.
- `missing_objective` (blocking): `plan.objective` must be non-empty.
- `missing_success_criteria` (blocking): `plan.successCriteria` must include at least one observable success criterion.
- `missing_evidence_required` (blocking): `plan.evidenceRequired` must include at least one concrete evidence item required before completion.
- `missing_steps` (blocking): `plan.steps` must include at least one execution step.
- `open_questions` (blocking): `plan.openQuestions` must be empty; resolve material unresolved questions through context-specific `ask` artifacts/results, then record the decision in the plan/`askRefs`.

`dependsOn` resolution is scoped to the active project. Spark builds the dependency lookup from existing tasks in that project, then creates/updates every task in the same `task_write({ action: "plan" })` batch and adds those batch tasks to the same lookup before adding dependencies. A dependency may therefore point to an earlier or later task in the same batch, or to an existing task in the project. Use a bare task `name` handle (displayed as `@name`, passed without `@`), an exact task `title`, or a `task:*` ref. Unknown dependencies block the plan, and cross-project dependencies are unsupported.
