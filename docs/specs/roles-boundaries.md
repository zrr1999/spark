# Role package boundaries

Spark separates two concerns:

1. **Role specs** — durable definitions of coding personas/instructions.
2. **Role runs** — concrete child Pi executions using one role spec.

Reusable, Spark-independent pieces live in `spark-roles`; Spark keeps task/workflow adaptation and facade policy.

## Current boundary

- `packages/spark-roles/src/index.ts` owns `RoleSpec`, `RoleRegistry`, role stores, builtin role definitions, Markdown role parsing/serialization, and simple `RoleRun` launch/control helpers.
- `packages/spark-extension-api/src/index.ts` owns shared refs, tool/result contracts, common task/run/review types, and light JSON/fs/time helpers.
- `packages/spark-tasks/src/*` owns project/task graphs, TODOs, dependencies, readiness, claim leases, and run history. It stores `roleRef` strings but does not import or resolve `RoleSpec` objects.
- `packages/spark-runtime/src/index.ts` owns single-task Spark adaptation: resolving an assigned/task/default `roleRef` through a `RoleRegistry`, creating `role-run` claims, calling `runRole()`, writing artifacts through `spark-artifacts`, updating task/run state, and tracking active background child processes.
- `packages/spark-workflows/src/orchestrator/index.ts` owns graph-level ready-task scheduling: dispatch-time executor role assignment, workflow-run state, and stale run reconciliation.
- `packages/spark-roles/src/extension.ts` exposes the canonical public/default `role({ action })` tool for role-spec management and one-off direct role calls; historical fragmented implementations are internal dispatch targets only.
- `packages/pi-extension/src/extension/index.ts` exposes Spark commands, canonical tool handlers, and Spark-owned function/workflow presets; Spark task execution uses role refs through `assign({ dryRun: true })`, not direct role wrapper tools.

## Spec/run separation invariant

- A **RoleSpec** is a reusable definition: ID/ref, source, description, system prompt, optional metadata/origin, and timestamps.
- A **RoleRun** is one concrete execution: run ID, launch mode, child process state, stdout/stderr/events, timeout/cancel status, and optional fork source.
- Every run references an existing role spec; specs do not embed run mode.
- `fresh` and `forked` are the only runtime launch modes in the current model.
- `builtin`, `extension`, `project`, and `user` describe where a reusable role came from.
- Generated roles are represented by metadata/origin, for example `origin.kind: "generated"`; generated is not a primary `RoleSource`.
- Extension roles are registered by loaded extension packages at runtime, for example `spark-graft` registering `role:extension-patcher`; they are not writable Markdown store roles.
- Spark role APIs use only `role:*`, `roleRef`, `runName`, and `role-run`; legacy agent-shaped names are rejected rather than migrated in place.

See [roles-run-modes.md](./roles-run-modes.md) for operational guidance.

## Role terminology boundary

Persisted state, runtime inputs, and docs use the current role vocabulary directly:

- Role definitions are identified by `role:*` refs.
- Task assignment and attribution use `roleRef`.
- Concrete child executions use `runName`.
- Task claims use `kind: "role-run"` for child role runs.

Old agent-shaped inputs are not part of the package boundary. A stale local snapshot should be repaired explicitly instead of being silently translated by readers.

## `spark-roles` ownership

`spark-roles` owns reusable role definition data and simple single-run execution, with no `spark-*` dependency:

- `RoleSource = "builtin" | "extension" | "project" | "user"`.
- `RoleOriginKind = "manual" | "generated" | "builtin" | "extension"`.
- `RoleRef` values use `role:${string}` and `RoleRunRef` values use `run:${string}`.
- `RoleSpec`, `RoleSpecProposal`, `RoleInstruction`, `RoleRunRequest`, `RoleRunRecord`, and `RoleRunResult`.
- `RoleRegistry`, runtime extension-role registration, and Markdown role stores for project/user roles.
- Builtin Spark-oriented roles (`scout`, `reviewer`, `worker`), the audited six-token capability vocabulary (`read | write | exec | net | interact | spawn`), and declarative `allowedTools` profiles derived from it.
- Canonical Pi role tool `role({ action })`, including task-agnostic one-off `role({ action: "call" })`.
- Pi CLI argument construction, fresh/forked launch, stdout/stderr capture, tolerant JSONL parsing, timeout/cancel, and active-run listing.

Storage policy:

- Project roles: `.agents/roles/**/*.md`.
- User roles: `~/.agents/roles/**/*.md`.
- Old agent-shaped paths are not loaded at runtime. Migrate them explicitly into `.agents/roles/**/*.md` before using `spark-roles`.

## Spark package ownership

- `spark-tasks` owns projects, tasks, dependencies, task plan items, TODO persistence/projection, claim leases, readiness, and run history.
- `spark-runtime` maps one Spark task to one `spark-roles` `RoleRun` primitive and maps completion back to task status, task claims, and artifacts.
- `spark-workflows` maps ready Spark task frontiers to scheduled `spark-runtime` runs and owns workflow-run scheduling/reconciliation state.
- `spark` extension tools keep Spark workflow semantics. Patcher-style child runs belong to explicit extension roles such as `role:extension-patcher` so the child receives only the relevant domain tools and unclear patch instructions are escalated upward.

## Builtin capability profiles

`spark-roles` audits only the shipped builtin profiles; it does not provide an open-ended delegation hierarchy for project/user roles.

| Builtin role | Capability profile       | Boundary |
| ------------ | ------------------------ | -------- |
| `scout`      | `read`, `net`            | context/file/web reconnaissance only |
| `reviewer`   | `read`, `net`, `exec`    | fresh verification through stdout JSON; host writes review artifacts/status; runtime gate strips interact/write/spawn orchestration tools from project/user reviewer roles |
| `worker`     | `read`, `net`, `exec`, `write` | implementation with file edits/writes |

`record` is intentionally absent from the capability vocabulary and is folded into `write`. No builtin role receives `interact` or `spawn`, and builtin allowlists exclude `ask`, `task`, `task_read`, `task_write`, `goal`, `role`, `assign`, `workflow`, and `graft_patch`.

## Non-goals

- Cross-project or cross-plugin workflow dependencies.
- Open-ended capabilities/topology/delegation hierarchy beyond the audited builtin profiles.
- Running roles that do not reference a persisted or builtin `RoleSpec`.
- Owning domain-specific preset semantics in `spark-roles`; package-specific functions/workflows should keep those presets in their owning package.
- Moving Spark command/widget/review-gate policy into generic Pi packages.
