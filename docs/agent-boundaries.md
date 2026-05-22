# Role package boundaries

Spark separates two concerns:

1. **Role specs** — durable definitions of coding personas/instructions.
2. **Role runs** — concrete child Pi executions using one role spec.

Reusable, Spark-independent pieces live in `pi-roles`; Spark keeps task/DAG/workflow adaptation.

## Current boundary

- `packages/pi-roles/src/index.ts` owns `RoleSpec`, `RoleRegistry`, role stores, builtin roles, Markdown role parsing/serialization, and simple `RoleRun` launch/control helpers. It does not depend on `spark-core`.
- `packages/spark-core/src/index.ts` owns Spark refs, task/artifact/review contracts, role refs as branded strings, and temporary deprecated agent aliases needed for rolling state migration.
- `packages/spark-tasks/src/index.ts` owns task DAGs, TODOs, dependencies, readiness, claim leases, and run history. It stores `roleRef` strings but does not import or resolve `RoleSpec` objects.
- `packages/spark-runtime/src/index.ts` owns Spark adaptation: resolving task `roleRef`s through a `RoleRegistry`, creating `role-run` claims, calling `runRole()`, writing artifacts, updating task/run/DAG state, and tracking active background child processes.
- `packages/pi-roles/src/extension.ts` exposes role-spec management tools (`list_roles`, `get_role`, `create_role`) plus the one-off direct `call_role` tool.
- `packages/spark/src/extension/index.ts` exposes Spark workflow tools; Spark task execution uses role refs through `spark_run_ready_tasks`, not direct role wrapper tools.

## Spec/run separation invariant

- A **RoleSpec** is a reusable definition: ID/ref, source, description, system prompt, optional metadata/origin, and timestamps.
- A **RoleRun** is one concrete execution: run ID, launch mode, child process state, stdout/stderr/events, timeout/cancel status, and optional fork source.
- Every run references an existing role spec; specs do not embed run mode.
- `fresh` and `forked` are the only runtime launch modes in the current model.
- `builtin`, `project`, and `user` describe where a reusable role came from.
- Generated roles are represented by metadata/origin, for example `origin.kind: "generated"`; generated is not a primary `RoleSource`.
- Legacy `managed`, `predefined`, `agent:*`, `agentRef`, `agentName`, `subagent`, and agent artifact names are compatibility inputs only during migration.

See [agent-run-modes.md](./agent-run-modes.md) for operational guidance.

## Legacy compatibility lifecycle

Compatibility is intentionally narrow and should shrink in this order:

1. Keep persisted-state readers for old `.spark/thread.json` snapshots and role stores until migration tests cover `agentRef` → `roleRef`, `agentName` → `runName`, `subagent` → `role-run`, and `agent:*` → `role:*`.
2. Remove user-facing/source aliases such as `managed` and `predefined` after one compatibility window; new tools and docs should only advertise `builtin`, `project`, and `user`.
3. Remove local deprecated API inputs only after a state migration/version bump exists and stale-reference scans show no tests or docs rely on them except historical notes.
4. Keep unrelated Pi/cue documentation about generic subagent/fork/worktree behavior out of Spark role terminology cleanup unless that package changes its own vocabulary.

## `pi-roles` ownership

`pi-roles` owns reusable role definition data and simple single-run execution, with no `spark-core` dependency:

- `RoleSource = "builtin" | "project" | "user"`.
- `RoleOriginKind = "manual" | "generated" | "imported" | "migrated" | "builtin"`.
- `RoleRef = `role:${string}` and `RoleRunRef = `run:${string}`.
- `RoleSpec`, `RoleSpecProposal`, `RoleInstruction`, `RoleRunRequest`, `RoleRunRecord`, and `RoleRunResult`.
- `RoleRegistry` and Markdown role stores.
- Builtin roles (`scout`, `planner`, `worker`, `reviewer`, `oracle`).
- Pi role tools for `list_roles`, `get_role`, `create_role`, and task-agnostic one-off `call_role`.
- Pi CLI argument construction, fresh/forked launch, stdout/stderr capture, tolerant JSONL parsing, timeout/cancel, and active-run listing.

Storage policy:

- Project roles: `.agents/roles/**/*.md`.
- User roles: `~/.agents/roles/**/*.md`.
- Compatibility read paths: `.pi/agents/**/*.md` and `~/.pi/agent/agents/**/*.md`.
- Old Spark JSON specs under `.spark/agents/*.json` are migration input only.

## Spark package ownership

- `spark-tasks` owns threads, tasks, dependencies, task TODOs, claim leases, readiness, and run history.
- `spark-runtime` maps Spark tasks to `pi-roles` `RoleRun` primitives and maps completion back to task status, task claims, artifacts, and DAG scheduling.
- `spark` extension tools keep Spark workflow semantics. Deprecated agent-shaped inputs may be accepted only as a narrow rolling migration layer.

## Non-goals

- Cross-thread or cross-plugin DAG dependencies.
- Capabilities/topology/delegation hierarchy in `pi-roles` v0.1.
- Running roles that do not reference a persisted or builtin `RoleSpec`.
- Moving Spark task claims, DAG state, TODOs, asks, artifacts, or review gates into generic Pi packages.
