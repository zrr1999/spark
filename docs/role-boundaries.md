# Role package boundaries

Spark separates two concerns:

1. **Role specs** — durable definitions of coding personas/instructions.
2. **Role runs** — concrete child Pi executions using one role spec.

Reusable, Spark-independent pieces live in `pi-roles`; Spark keeps task/workflow adaptation and facade policy.

## Current boundary

- `packages/pi-roles/src/index.ts` owns `RoleSpec`, `RoleRegistry`, role stores, builtin role definitions, Markdown role parsing/serialization, and simple `RoleRun` launch/control helpers.
- `packages/pi-extension-api/src/index.ts` owns shared refs, tool/result contracts, common task/run/review types, and light JSON/fs/time helpers.
- `packages/pi-tasks/src/*` owns project/task graphs, TODOs, dependencies, readiness, claim leases, and run history. It stores `roleRef` strings but does not import or resolve `RoleSpec` objects.
- `packages/spark-runtime/src/index.ts` owns single-task Spark adaptation: resolving an assigned/task/default `roleRef` through a `RoleRegistry`, creating `role-run` claims, calling `runRole()`, writing artifacts through `pi-artifacts`, updating task/run state, and tracking active background child processes.
- `packages/pi-workflows/src/orchestrator/index.ts` owns graph-level ready-task scheduling: dispatch-time executor role assignment, workflow-run state, and stale run reconciliation.
- `packages/pi-roles/src/extension.ts` exposes the canonical public/default `role({ action })` tool for role-spec management and one-off direct role calls; historical fragmented implementations are internal dispatch targets only.
- `packages/spark/src/extension/index.ts` exposes Spark commands, canonical tool handlers, and Spark-owned function/workflow presets; Spark task execution uses role refs through `task({ action: "run_ready" })`, not direct role wrapper tools.

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

`pi-roles` owns reusable role definition data and simple single-run execution, with no `spark-*` dependency:

- `RoleSource = "builtin" | "project" | "user"`.
- `RoleOriginKind = "manual" | "generated" | "builtin"`.
- `RoleRef` values use `role:${string}` and `RoleRunRef` values use `run:${string}`.
- `RoleSpec`, `RoleSpecProposal`, `RoleInstruction`, `RoleRunRequest`, `RoleRunRecord`, and `RoleRunResult`.
- `RoleRegistry` and Markdown role stores.
- Builtin Spark-oriented roles (`scout`, `planner`, `worker`, `reviewer`, `oracle`) and their declarative `allowedTools` profiles.
- Canonical Pi role tool `role({ action })`, including task-agnostic one-off `role({ action: "call" })`.
- Pi CLI argument construction, fresh/forked launch, stdout/stderr capture, tolerant JSONL parsing, timeout/cancel, and active-run listing.

Storage policy:

- Project roles: `.agents/roles/**/*.md`.
- User roles: `~/.agents/roles/**/*.md`.
- Old agent-shaped paths are not loaded at runtime. Migrate them explicitly into `.agents/roles/**/*.md` before using `pi-roles`.

## Spark package ownership

- `pi-tasks` owns projects, tasks, dependencies, task TODOs, claim leases, readiness, and run history.
- `spark-runtime` maps one Spark task to one `pi-roles` `RoleRun` primitive and maps completion back to task status, task claims, and artifacts.
- `pi-workflows` maps ready Spark task frontiers to scheduled `spark-runtime` runs and owns workflow-run scheduling/reconciliation state.
- `spark` extension tools keep Spark workflow semantics. Patcher-style child runs belong to `pi-graft` (`graft_patch`) so the child receives only Graft-related tools and unclear patch instructions are escalated upward.

## Non-goals

- Cross-project or cross-plugin DAG dependencies.
- Capabilities/topology/delegation hierarchy in `pi-roles` v0.1.
- Running roles that do not reference a persisted or builtin `RoleSpec`.
- Owning domain-specific preset semantics in `pi-roles`; package-specific functions/workflows should keep those presets in their owning package.
- Moving Spark command/widget/review-gate policy into generic Pi packages.
