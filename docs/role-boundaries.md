# Role package boundaries

Spark separates two concerns:

1. **Role specs** — durable definitions of coding personas/instructions.
2. **Role runs** — concrete child Pi executions using one role spec.

Reusable, Spark-independent pieces live in `pi-roles`; Spark keeps task/DAG/workflow adaptation.

## Current boundary

- `packages/pi-roles/src/index.ts` owns `RoleSpec`, `RoleRegistry`, role stores, core builtin roles, registered builtin role providers, Markdown role parsing/serialization, and simple `RoleRun` launch/control helpers. It does not depend on `spark-core`.
- `packages/spark-core/src/index.ts` owns Spark refs, task/artifact/review contracts, and role refs as branded strings.
- `packages/spark-tasks/src/index.ts` owns task DAGs, TODOs, dependencies, readiness, claim leases, and run history. It stores `roleRef` strings but does not import or resolve `RoleSpec` objects.
- `packages/spark-runtime/src/index.ts` owns single-task Spark adaptation: resolving an assigned/task/default `roleRef` through a `RoleRegistry`, creating `role-run` claims, calling `runRole()`, writing artifacts, updating task/run state, and tracking active background child processes.
- `packages/spark-workflows/src/orchestrator/index.ts` owns graph-level ready-task scheduling: dispatch-time executor role assignment, workflow-run state, and stale run reconciliation.
- `packages/pi-roles/src/extension.ts` exposes role-spec management tools (`list_roles`, `get_role`, `create_role`) plus the one-off direct `call_role` tool.
- `packages/spark/src/extension/index.ts` exposes Spark workflow tools and registers Spark-owned predefined roles; Spark task execution uses role refs through `spark_run_ready_tasks`, not direct role wrapper tools.

## Spec/run separation invariant

- A **RoleSpec** is a reusable definition: ID/ref, source, description, system prompt, optional metadata/origin, and timestamps.
- A **RoleRun** is one concrete execution: run ID, launch mode, child process state, stdout/stderr/events, timeout/cancel status, and optional fork source.
- Every run references an existing role spec; specs do not embed run mode.
- `fresh` and `forked` are the only runtime launch modes in the current model.
- `builtin`, `project`, and `user` describe where a reusable role came from.
- Generated roles are represented by metadata/origin, for example `origin.kind: "generated"`; generated is not a primary `RoleSource`.
- Spark role APIs use only `role:*`, `roleRef`, `runName`, and `role-run`; legacy agent-shaped names are rejected rather than migrated in place.

See [role-run-modes.md](./role-run-modes.md) for operational guidance.

## Role terminology boundary

Persisted state, runtime inputs, and docs use the current role vocabulary directly:

- Role definitions are identified by `role:*` refs.
- Task assignment and attribution use `roleRef`.
- Concrete child executions use `runName`.
- Task claims use `kind: "role-run"` for child role runs.

Old agent-shaped inputs are not part of the package boundary. A stale local snapshot should be repaired explicitly instead of being silently translated by readers.

## `pi-roles` ownership

`pi-roles` owns reusable role definition data and simple single-run execution, with no `spark-core` dependency:

- `RoleSource = "builtin" | "project" | "user"`.
- `RoleOriginKind = "manual" | "generated" | "builtin"`.
- `RoleRef = `role:${string}` and `RoleRunRef = `run:${string}`.
- `RoleSpec`, `RoleSpecProposal`, `RoleInstruction`, `RoleRunRequest`, `RoleRunRecord`, and `RoleRunResult`.
- `RoleRegistry` and Markdown role stores.
- Core builtin roles (`scout`, `planner`, `worker`, `reviewer`, `oracle`) plus the provider mechanism for package-owned predefined roles.
- Pi role tools for `list_roles`, `get_role`, `create_role`, and task-agnostic one-off `call_role`.
- Pi CLI argument construction, fresh/forked launch, stdout/stderr capture, tolerant JSONL parsing, timeout/cancel, and active-run listing.

Storage policy:

- Project roles: `.agents/roles/**/*.md`.
- User roles: `~/.agents/roles/**/*.md`.
- Old agent-shaped paths are not loaded at runtime. Migrate them explicitly into `.agents/roles/**/*.md` before using `pi-roles`.

## Spark package ownership

- `spark-tasks` owns projects, tasks, dependencies, task TODOs, claim leases, readiness, and run history.
- `spark-runtime` maps one Spark task to one `pi-roles` `RoleRun` primitive and maps completion back to task status, task claims, and artifacts.
- `spark-workflows` maps ready Spark task frontiers to scheduled `spark-runtime` runs and owns workflow-run scheduling/reconciliation state.
- `spark` extension tools keep Spark workflow semantics, register Spark-owned predefined roles such as `patcher`, and should not reintroduce agent-shaped role aliases.

## Non-goals

- Cross-project or cross-plugin DAG dependencies.
- Capabilities/topology/delegation hierarchy in `pi-roles` v0.1.
- Running roles that do not reference a persisted or builtin `RoleSpec`.
- Owning domain-specific role semantics in `pi-roles`; package-specific predefined roles should be registered by their owning package.
- Moving Spark task claims, DAG state, TODOs, asks, artifacts, or review gates into generic Pi packages.
