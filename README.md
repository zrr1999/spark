# pi-spark

`pi-spark` is the Spark suite for Pi: a controlled agentic development system where the user-facing entry point is `/spark`, and lower-level capabilities are kept as Spark primitives.

## User-facing entry point

```text
/spark <idea>
```

`/spark` initializes local Spark state without asking the user to complete a broad intake form. Spark first records the initial intent and uses investigation tasks to gather context. It does not synthesize placeholder current tasks; the model claims one or more concrete tasks within the active thread. Follow-up asks should be targeted to the actual project state. The output language defaults from the current request language and is confirmed when Spark asks a targeted clarification.

The first vertical slice then creates local Spark state under `.spark/`:

- `.spark/thread.json`
- `.spark/review-gate.json`
- typed artifacts under `.spark/artifacts/`
- an initial task DAG
- an initial role plan artifact
- a review gate
- a run trace artifact

A root `SPARK.md` is only materialized when the current `cwd` looks like a concrete repo (currently: `.git` exists in `cwd`). In workspace-like directories, Spark still creates `.spark/` state and a `spark-md` artifact, but skips the root `SPARK.md` file.

`.spark/` is local runtime state and should be ignored by Git. Stable shared knowledge, including Spark learnings, should be shared only through explicit exports, reports, or committed Markdown artifacts.

`GitHub` repo/issue creation is intentionally deferred.

## Packages

- `spark` — high-level `/spark` facade and Spark status/run tools.
- `spark-core` — internal shared refs, schemas, errors, and contracts.
- `pi-cue` — reusable Pi/cue-shell execution substrate; absorbs `pi-cue-shell` code without a compatibility package and does not depend on `spark-core`.
- `pi-ask` — minimal `ask_user` plus reusable `ask_flow` protocol/state/renderer with direct custom input handling.
- `pi-roles` — reusable `RoleSpec` definitions, builtin/project/user role discovery, Markdown stores, role-spec management tools (`list_roles` / `get_role` / `create_role`), and one task-agnostic direct-call tool (`call_role`). It owns fresh/forked CLI launch, timeout/cancel, stdout/stderr capture, and tolerant JSONL parsing; it does not own Spark task DAGs, asks, artifacts, or review gates.
- `spark-tasks` — durable thread/task DAG, task names/titles/descriptions, TODOs, dependencies, readiness, runs, and unified claim/lease state. Optional task `roleRef` values are preferred executor hints, not readiness requirements.
- `spark-runtime` — Spark single-task runtime adapter that executes one task through `pi-roles`, writes artifacts, and owns task/run/timeout mapping above `RoleRun`.
- `spark-orchestrator` — Spark task-graph control plane that schedules ready frontiers, assigns executor roles at dispatch, and owns DAG manager state.
- `spark-artifacts` — typed durable artifacts with hashes, blobs, provenance, and lineage links.
- `spark-learnings` — evidence-backed reusable learning records, lifecycle state, search, explicit export/import, and legacy `compound-learnings` migration helpers.
- `spark-review` — verification gates and review artifacts.
- `spark-ask` — Spark-specific ask artifact persistence/replay and tool helpers built on top of `pi-ask`; callers provide context-specific questions instead of canned presets.

No compatibility packages are planned. `spark-github` is intentionally deferred.

## Development

```text
pnpm install
pnpm run verify
```

Tooling (pnpm, Vite+ / `vp`, prek hooks, CI) matches the stack documented in [`AGENTS.md`](./AGENTS.md).

Pi loads raw TypeScript from the package manifest; there is no build step.

## Docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/implementation-status.md`](./docs/implementation-status.md)
- [`docs/tools.md`](./docs/tools.md)
- [`docs/commit-convention.md`](./docs/commit-convention.md)
