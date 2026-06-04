# pi-spark

`pi-spark` is the Spark suite for Pi: a controlled agentic development system where the Pi extension entry point is `/spark`, and lower-level capabilities are kept as Spark primitives.

The repository also contains an MVP standalone Spark-first TUI host:

```text
spark
spark <initial goal>
```

The standalone `spark` command is built directly on `@earendil-works/pi-tui`. It owns the terminal loop, editor, transcript, follow-up queue, host runtime, provider registry, model selection, session store, and explicit Spark extension loading instead of embedding Pi SDK `InteractiveMode`. It also now has a local-only `spark daemon ...` surface for file-queued detached `session.run` work. The daemon is intentionally not a gateway: no HTTP server, bearer token, remote job API, service installer, or Pi RPC wrapper. Child/background role-runs still use the existing `pi --print --mode json` runner, so `pi` must remain installed and authenticated for workflow execution until Spark gets its own non-TUI role executor.

## Spark CLI native host vs Pi extension

Spark now has two supported host targets:

- **Pi extension host**: `packages/spark/src/extension/` is loaded by `@earendil-works/pi-coding-agent` through Pi's normal extension/package discovery. This remains the canonical `/spark`, `/research`, `/plan`, `/execute`, `/workflow`, and Spark tool surface inside Pi.
- **Spark CLI native host**: `packages/spark-cli` starts `SparkHostRuntime` directly on `@earendil-works/pi-tui`, loads retained builtin extensions through explicit factories (`pi-ask`, `pi-cue`, `pi-roles`, `pi-graft`, `spark`), registers providers such as `baidu-oneapi`, discovers Spark skills from builtin/workspace/user layers, and runs turns through `@earendil-works/pi-ai`.

The extension packages depend on the shared `pi-extension-api` contract, not on Pi's concrete SDK package. Host-specific code belongs under `packages/spark-cli/src/host/` and TUI wrappers under `packages/spark-cli/src/tui/`; the Pi extension implementation should stay usable by Pi without importing spark-cli.

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

`.spark/` is local runtime state and should be ignored by Git. Spark learnings live separately under `.learning/` for repo/workspace knowledge or under the user learning directory for personal cross-project knowledge. Use `spark_state` for explicit cache status/cleanup; cleanup is dry-run by default and never targets protected stores such as project graph, artifacts, notes, workflow runs, or review-gate state.

`GitHub` repo/issue creation is intentionally deferred.

## Packages

- `spark` — high-level `/spark`, `/research`, `/plan`, `/execute`, and `/workflow[:selector]` facade plus Spark status/workflow tools.
- `spark-cli` — standalone Spark-first native TUI host built directly on `@earendil-works/pi-tui`; starts directly with `spark`, owns its local transcript/follow-up queue, and provides a local daemon queue for detached session-run tasks.
- `spark-core` — internal shared refs, schemas, errors, artifact store, durable artifact metadata/blobs, and contracts.
- `pi-cue` — reusable Pi/cue-shell execution substrate; absorbs `pi-cue-shell` code without a compatibility package and does not depend on `spark-core`.
- `pi-ask` — minimal `ask_user` plus reusable `ask_flow` protocol/state/renderer with direct custom input handling.
- `pi-roles` — reusable `RoleSpec` definitions, builtin/project/user role discovery, Markdown stores, role-spec management tools (`list_roles` / `get_role` / `create_role`), and one task-agnostic direct-call tool (`call_role`). It owns fresh/forked CLI launch, timeout/cancel, stdout/stderr capture, and tolerant JSONL parsing; it does not own Spark task DAGs, asks, artifacts, or review gates.
- `spark-tasks` — durable project/task DAG, task names/titles/descriptions, TODOs, dependencies, readiness, runs, and unified claim/lease state. Optional task `roleRef` values are preferred executor hints, not readiness requirements.
- `spark-runtime` — Spark single-task runtime adapter that executes one task through `pi-roles`, writes artifacts, and owns task/run/timeout mapping above `RoleRun`.
- `spark-workflows` — private Spark-owned workflow runtime, example workflow script factories, `/workflow:goal` goal continuation, `/workflow:ready` ready-frontier orchestration, workflow-run state in `.spark/workflow-runs.json`, and the role-run adapter boundary for `/workflow[:selector]`.
- `spark-learnings` — evidence-backed reusable learning records, lifecycle state, search, explicit export/import, and legacy `compound-learnings` migration helpers.
- `pi-ask` (formerly also `spark-ask`) — generic ask_user / ask_flow engine plus the Spark-specific ask artifact persistence/replay surface. The `spark_ask` tool wiring lives directly in `packages/spark/src/extension/spark-ask-tool.ts` and consumes pi-ask primitives by their original names. Callers provide context-specific questions instead of canned presets.

No compatibility packages are planned. `spark-github` is intentionally deferred.

Pi package loading is manifest-first: the root `pi` manifest explicitly lists each user-visible extension entry (`pi-ask`, `pi-cue`, `pi-roles`, `pi-graft`, the Baidu OneAPI provider, and `spark`). Library-only packages stay as dependencies, and `spark` does not embed-register lower-level `pi-*` tools.

## Development

```text
pnpm install
pnpm run verify
packages/spark-cli/bin/spark --help
packages/spark-cli/bin/spark daemon --help
```

Tooling (pnpm, Vite+ / `vp`, prek hooks, CI) matches the stack documented in [`AGENTS.md`](./AGENTS.md).

Pi loads raw TypeScript from the package manifest; there is no build step.

## Docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/implementation-status.md`](./docs/implementation-status.md)
- [`docs/spark-store-inventory.md`](./docs/spark-store-inventory.md)
- [`docs/tools.md`](./docs/tools.md)
- [`docs/spark-host-architecture.md`](./docs/spark-host-architecture.md)
- [`docs/commit-convention.md`](./docs/commit-convention.md)
