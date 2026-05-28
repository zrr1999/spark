# pi-spark

`pi-spark` is the Spark suite for Pi: a controlled agentic development system where the user-facing entry point is `/spark`, and lower-level capabilities are kept as Spark primitives.

## User-facing entry point

```text
/spark <idea>
```

`/spark` initializes local Spark state without asking the user to complete a generic intake template. Spark first records the initial intent and uses investigation tasks to gather context. It does not synthesize placeholder current tasks; the model claims one concrete task at a time within the active thread. Follow-up asks should be grounded in the actual project state: when open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, Spark should use a context-specific `spark_ask` instead of leaving those questions as prose. The output language defaults from the current request language and is confirmed only when that decision is genuinely unclear.

Spark command modes are intentionally split:

- `/plan <focus>` plans or refines the task DAG and does not execute work.
- `/execute <focus>` executes at most one concrete task, then stops. If another task is ready, the finish output may point to it; run `/execute` again for one more step.
- `/run-sequential <focus>` starts or resumes the background Spark orchestrator with `maxConcurrency=1`, so ready tasks run one at a time until the run is done, blocked, failed, cancelled, or needs a decision.
- `/run-parallel <focus>` keeps the existing parallel ready-frontier scheduler for background progress.
- `/run <focus>` remains an inferred-strategy convenience entry point: parallel/concurrent wording selects `/run-parallel`; otherwise it uses safer sequential progress. Inspect progress with `spark_background_runs status`; compact progress also appears in `spark_status`, the Spark widget, and notifications, not synthetic follow-up user messages or a second main-agent turn.
- `/spark <focus>` infers planning or single-step execution when high confidence. If the prompt asks for continuous/until-done progress, Spark asks before entering inferred-strategy `/run`.

The first vertical slice then creates local Spark state under `.spark/`:

- `.spark/thread.json`
- `.spark/review-gate.json`
- typed artifacts under `.spark/artifacts/`
- an initial task DAG
- an initial role plan artifact
- a review gate
- a run trace artifact

A root `SPARK.md` is only materialized by `/spark` initialization, and only when the current `cwd` looks like a concrete repo (currently: `.git` exists in `cwd`). Direct modes such as `/plan`, `/execute`, `/run`, `/run-sequential`, and `/run-parallel` do not create or overwrite root `SPARK.md`; when they initialize minimal Spark state, intent is kept in `.spark` artifacts.

`.spark/` is local runtime state and should be ignored by Git. Stable shared knowledge, including Spark learnings, should be shared only through explicit exports, reports, or committed Markdown artifacts. Use `spark_state` for explicit cache status/cleanup; cleanup is dry-run by default and never targets protected stores such as thread graph, artifacts, notes, DAG runs, or review-gate state.

`GitHub` repo/issue creation is intentionally deferred.

## Packages

- `spark` — high-level `/spark`, `/plan`, `/execute`, `/run`, `/run-sequential`, and `/run-parallel` facade plus Spark status/run tools.
- `spark-core` — internal shared refs, schemas, errors, and contracts.
- `pi-cue` — reusable Pi/cue-shell execution substrate; absorbs `pi-cue-shell` code without a compatibility package and does not depend on `spark-core`.
- `pi-ask` — minimal `ask_user` plus reusable `ask_flow` protocol/state/renderer with direct custom input handling.
- `pi-roles` — reusable `RoleSpec` definitions, builtin/project/user role discovery, Markdown stores, role-spec management tools (`list_roles` / `get_role` / `create_role`), and one task-agnostic direct-call tool (`call_role`). It owns fresh/forked CLI launch, timeout/cancel, stdout/stderr capture, and tolerant JSONL parsing; it does not own Spark task DAGs, asks, artifacts, or review gates.
- `spark-tasks` — durable thread/task DAG, task names/titles/descriptions, TODOs, dependencies, readiness, runs, and unified claim/lease state. Optional task `roleRef` values are preferred executor hints, not readiness requirements.
- `spark-runtime` — Spark single-task runtime adapter that executes one task through `pi-roles`, writes artifacts, and owns task/run/timeout mapping above `RoleRun`.
- `spark-orchestrator` — Spark task-graph control plane that schedules ready frontiers, assigns executor roles at dispatch, and owns background orchestration state.
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
- [`docs/spark-store-inventory.md`](./docs/spark-store-inventory.md)
- [`docs/tools.md`](./docs/tools.md)
- [`docs/commit-convention.md`](./docs/commit-convention.md)
