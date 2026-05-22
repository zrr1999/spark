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
- `spark-runtime`: Spark task/DAG adaptation over `pi-roles` runs.

Rules:

1. A task must belong to a thread.
2. Do not create placeholder tasks or threads for display; tasks are model-claimed only when concrete work exists, and a session may claim multiple tasks only within the active thread.
3. Use the dedicated `spark_plan_tasks` tool to梳理/organize multiple tasks before assigning roles; planning tasks must not be represented by claiming many unfinished tasks in the current session.
4. Executable tasks must bind to a builtin, project, or user role spec via `roleRef`.
5. Running a role only accepts an instruction; no runtime system-prompt patching.
6. Task-generated work must be proposed and validated before persistence.
7. Store durable context as typed artifacts rather than relying on chat history.
8. Treat SPARK.md as persistent project intent that the extension injects into the active system prompt.
9. Models may improve Spark display names without asking when the active thread title or current task `@name`/title is obviously placeholder, generic, stale, too broad, or inconsistent with the current confirmed intent. Examples include placeholder labels such as `Untitled`, `New thread`, `Task`, `TODO`, `Custom input`, or `「自定义输入」`; generic labels such as `Fix bug`, `Implement task`, `Research`, `Review`, `Spark work`, `Update docs`, or `Plan`; and stale labels that describe an older scope than the active request. Use `spark_rename_thread` for thread metadata and `spark_claim_task` for the claimed task. Display names are mutable labels only: stable `thread:*` and `task:*` refs, dependencies, runs, artifacts, and TODOs continue to point at the same entities after a rename. Preserve user-specific intentional names, distinctive project/code names, issue IDs, release names, and ambiguous naming choices; ask with `spark_ask` only when the right name depends on a real user decision.
10.   During initialization, do not show a broad upfront intake form. Analyze the request and workspace context first, then ask only targeted clarification questions when that analysis finds a concrete ambiguity. If language is obvious, follow the user's language without a separate language confirmation.
11.   After a decision is confirmed and the next action is clear, continue with that action instead of stopping for another permission prompt.
12.   Show the active thread header with task counts plus claimed task / TODO text summaries by default; render independent session TODOs as siblings of the thread display. `spark_status` defaults to active unfinished/current-session work; use `view: "summary"` for counts only or `view: "full"` for full history.
13.   Before launching multiple role-runs or parallel workstreams, ask for approval with `spark_ask` unless the user explicitly requested immediate dispatch. Treat no-selection as blocked, not approval; asks do not support automatic timeout.
14.   Prefer Spark-native delegation: inspect roles with `spark_list_roles` / `spark_get_role`, bind concrete tasks to builtin/project/user `roleRef`s, and hand execution to the `spark_run_ready_tasks` DAG manager. Do not spawn nested `pi` CLI sessions as pseudo-roles unless the task is explicitly about testing Pi CLI behavior.
15.   When using `pi-cue` `run`, prefer direct-exec commands and Pi file tools. Use `/bin/sh -lc` only for real shell features such as redirection, here-docs, variable expansion, or compound conditionals.
16.   Keep temporary plans, role-run reports, and scratch outputs out of the repo root; use `.spark/notes/`, `.spark/role-reports/`, or typed Spark artifacts unless the user asks for committed docs.
