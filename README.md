# pi-spark

`pi-spark` is the Spark suite for Pi: a controlled agentic development system where the Pi extension entry point is `/spark`, and lower-level capabilities are kept as Spark primitives.

The repository also contains an MVP standalone Spark-first TUI host:

```text
spark
spark <initial goal>
```

The standalone `spark` command is built on the Pi SDK `InteractiveMode`. It disables normal Pi extension/skill discovery, bundles Spark-related extensions as built-in capabilities, loads Spark skills explicitly, and routes ordinary TUI input through Spark mode by default. This MVP is intentionally TUI-only: it does not provide `--print`, JSON/RPC, or standalone subcommands yet. Child/background role-runs still use the existing `pi --print --mode json` runner, so `pi` must remain installed and authenticated for workflow execution.

## User-facing entry point

```text
/spark <idea>
```

`/spark` initializes local Spark state without asking the user to complete a generic intake template. Spark first records the initial intent and uses investigation tasks to gather context. It does not synthesize placeholder current tasks; the model claims one concrete task at a time within the active project. Follow-up asks should be grounded in the actual project state: when open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, Spark should use a context-specific `spark_ask` instead of leaving those questions as prose. The output language defaults from the current request language and is confirmed only when that decision is genuinely unclear.

Spark command modes are intentionally split:

- `/research <focus>` investigates and summarizes findings without changing tasks.
- `/plan <focus>` plans or refines the task DAG and does not execute work.
- `/execute <focus>` executes one bounded default step, normally claiming at most one concrete task before stopping.
- `/workflow[:selector] <focus>` runs Spark-owned workflows. Builtins are intentionally minimal: `/workflow:goal` and `/workflow:ready`; scripted workflows use `/workflow workspace:<name>` for `.spark/workflows/*.js` and `/workflow user:<name>` for `~/.agents/workflows/*.js`. Empty `/workflow` asks which workflow to use or whether to draft a workspace workflow.
- `/spark <focus>` infers research, planning, or default execution when high confidence. If the prompt asks for autonomous or workflow-style progress, Spark asks before selecting a goal or workflow execute strategy.

The first vertical slice then creates local Spark state under `.spark/`:

- `.spark/projects.json`
- `.spark/review-gate.json`
- typed artifacts under `.spark/artifacts/`
- an initial task DAG
- an initial role plan artifact
- a review gate
- a run trace artifact

A root `SPARK.md` is only materialized by `/spark` initialization, and only when the current `cwd` looks like a concrete repo (currently: `.git` exists in `cwd`). Direct modes such as `/research`, `/plan`, `/execute`, and `/workflow[:selector]` do not create or overwrite root `SPARK.md`; when they initialize minimal Spark state, intent is kept in `.spark` artifacts.

`.spark/` is local runtime state and should be ignored by Git. Stable shared knowledge, including Spark learnings, should be shared only through explicit exports, reports, or committed Markdown artifacts. Use `spark_state` for explicit cache status/cleanup; cleanup is dry-run by default and never targets protected stores such as project graph, artifacts, notes, workflow runs, or review-gate state.

`GitHub` repo/issue creation is intentionally deferred.

## Packages

- `spark` — high-level `/spark`, `/research`, `/plan`, `/execute`, and `/workflow[:selector]` facade plus Spark status/workflow tools.
- `spark-cli` — standalone Spark-first TUI host built on the Pi SDK; starts directly with `spark` and bundles Spark/pi-\* extensions as built-ins.
- `spark-core` — internal shared refs, schemas, errors, artifact store, durable artifact metadata/blobs, and contracts.
- `pi-cue` — reusable Pi/cue-shell execution substrate; absorbs `pi-cue-shell` code without a compatibility package and does not depend on `spark-core`.
- `pi-ask` — minimal `ask_user` plus reusable `ask_flow` protocol/state/renderer with direct custom input handling.
- `pi-roles` — reusable `RoleSpec` definitions, builtin/project/user role discovery, Markdown stores, role-spec management tools (`list_roles` / `get_role` / `create_role`), and one task-agnostic direct-call tool (`call_role`). It owns fresh/forked CLI launch, timeout/cancel, stdout/stderr capture, and tolerant JSONL parsing; it does not own Spark task DAGs, asks, artifacts, or review gates.
- `spark-tasks` — durable project/task DAG, task names/titles/descriptions, TODOs, dependencies, readiness, runs, and unified claim/lease state. Optional task `roleRef` values are preferred executor hints, not readiness requirements.
- `spark-runtime` — Spark single-task runtime adapter that executes one task through `pi-roles`, writes artifacts, and owns task/run/timeout mapping above `RoleRun`.
- `spark-workflows` — private Spark-owned workflow runtime, example workflow script factories, `/workflow:goal` goal continuation, `/workflow:ready` ready-frontier orchestration, workflow-run state in `.spark/workflow-runs.json`, and the role-run adapter boundary for `/workflow[:selector]`.
- `spark-learnings` — evidence-backed reusable learning records, lifecycle state, search, explicit export/import, and legacy `compound-learnings` migration helpers.
- `spark-ask` — Spark-specific ask artifact persistence/replay and tool helpers built on top of `pi-ask`; callers provide context-specific questions instead of canned presets.

No compatibility packages are planned. `spark-github` is intentionally deferred.

## Development

```text
pnpm install
pnpm run verify
packages/spark-cli/bin/spark --help
```

Tooling (pnpm, Vite+ / `vp`, prek hooks, CI) matches the stack documented in [`AGENTS.md`](./AGENTS.md).

Pi loads raw TypeScript from the package manifest; there is no build step.

## Docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/implementation-status.md`](./docs/implementation-status.md)
- [`docs/spark-store-inventory.md`](./docs/spark-store-inventory.md)
- [`docs/tools.md`](./docs/tools.md)
- [`docs/commit-convention.md`](./docs/commit-convention.md)
