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

`/spark` initializes local Spark state without asking the user to complete a generic intake template. Spark first records the initial intent and uses investigation tasks to gather context. It does not synthesize placeholder current tasks; the model claims one concrete task at a time within the active project. Follow-up asks should be grounded in the actual project state: when open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, Spark should use context-specific `ask` questions instead of leaving those questions as prose. The output language defaults from the current request language and is confirmed only when that decision is genuinely unclear.

Spark command modes are intentionally split:

- `/research <focus>` investigates and summarizes findings without changing tasks.
- `/plan <focus>` plans or refines the task DAG and does not execute work.
- `/execute <focus>` executes one bounded default step, normally claiming at most one concrete task before stopping.
- `/goal <focus>` runs autonomous verified foreground goal progress until complete or blocked. If no focus is provided, Spark derives the goal from the current project/task state and asks when ambiguous.
- `/workflow[:selector] <focus>` runs saved Spark workflow scripts. Use `/workflow workspace:<name>` for `.spark/workflows/*.js` and `/workflow user:<name>` for `~/.agents/workflows/*.js`. Empty `/workflow` asks which workflow to use or whether to draft a workspace workflow.
- `/spark <focus>` infers research, planning, or default execution when high confidence. If the prompt asks for autonomous or workflow-style progress, Spark asks before selecting a goal or workflow execute strategy.

The first vertical slice then creates local Spark state under `.spark/`:

- `.spark/projects.json`
- `.spark/review-gate.json`
- typed artifacts under `.spark/artifacts/`
- an initial task DAG
- an initial role plan artifact
- a review gate
- a run trace artifact

A root `SPARK.md` is only materialized by `/spark` initialization, and only when the current `cwd` looks like a concrete repo (currently: `.git` exists in `cwd`). Direct modes such as `/research`, `/plan`, `/execute`, `/goal`, and `/workflow[:selector]` do not create or overwrite root `SPARK.md`; when they initialize minimal Spark state, intent is kept in `.spark` artifacts.

`.spark/` is local runtime state and should be ignored by Git. Spark learnings live separately under the ignored local `.learnings/` directory for repo/workspace-scoped recall or under the user learning directory for personal cross-project knowledge; share them through explicit Markdown exports instead of committing the local artifact store by default. Use canonical owner tools for maintenance (`task({ action: "cache_cleanup" })`, `artifact({ action: "compact" })`, and workflow-run retention actions as they land); cleanup remains dry-run by default and must never target protected stores such as project graph, artifacts, notes, workflow runs, or review-gate state.

`GitHub` repo/issue creation is intentionally deferred.

## Packages

- `spark` — high-level `/spark`, `/research`, `/plan`, `/execute`, `/goal`, and `/workflow[:selector]` mode facade that composes generic `pi-*` capabilities with Spark-owned orchestration policy, widget state, builtin Spark roles, and active-context provider registration.
- `spark-cli` — standalone Spark-first native TUI host built directly on `@earendil-works/pi-tui`; starts directly with `spark`, owns its local transcript/follow-up queue, and provides a local daemon queue for detached session-run tasks.
- `spark-runtime` — Spark single-task runtime adapter that executes one task through `pi-roles`, writes artifacts, and owns task/run/timeout mapping above `RoleRun`.
- `pi-extension-api` — shared extension host/tool contract, refs, errors, and light JSON/fs/time helpers.
- `pi-artifacts` — reusable artifact/evidence store, durable artifact metadata/blobs, provenance/lineage contracts, and the canonical `artifact` action tool.
- `pi-tasks` — generic project/task/TODO/run graph capability and canonical `task({ action })` tool; owns readiness, claims, TODO stores, and `.spark/projects.json` graph state without depending on Spark packages.
- `pi-learnings` — generic evidence-backed learning capability and canonical `learning({ action })` tool; owns `.learnings/` local/user learning stores.
- `pi-goal` — generic durable goal primitives and continuation prompt helpers; Spark owns the project-bound `/goal` facade while preserving historical serialized marker strings.
- `pi-workflows` — saved-script workflow discovery/runtime primitives plus workflow/DAG run-store support for `.spark/workflow-runs.json`.
- `pi-context` — registered context-provider capability with bounded list/preview actions and no freeform prompt injection.
- `pi-recall` — controlled explicit-scope recall candidate store/tool, separate from `.learnings/` and automatic memory.
- `pi-cue` — reusable Pi/cue-shell execution substrate.
- `pi-ask` — canonical public/default `ask` action tool with shared focused/flow protocol, state, renderer, and direct custom input handling behind that surface.
- `pi-roles` — canonical `role` action tool plus reusable `RoleSpec` definitions, builtin/project/user role discovery, Markdown stores, and task-agnostic direct role calls. It owns fresh/forked CLI launch, timeout/cancel, stdout/stderr capture, and tolerant JSONL parsing; it does not own Spark task DAGs, asks, artifacts, review gates, or package-specific role semantics.

Retired migration packages (`spark-core`, `spark-tasks`, `spark-learnings`, `spark-goal`, and `spark-workflows`) are no longer workspaces. No compatibility packages, long-lived `spark_*` tool aliases, or dual public/default tool surfaces are planned. Public action tools render as `tool action=<value> ...`. `spark-github` is intentionally deferred.

Pi package loading is manifest-first: the root `pi` manifest explicitly lists each user-visible extension entry (`pi-ask`, `pi-artifacts`, `pi-cue`, `pi-roles`, `pi-recall`, `pi-workflows`, `pi-graft`, the Baidu OneAPI provider, and `spark`). Library-only packages stay as dependencies. `pi-* -> spark-*` regressions are guarded by `pnpm run check:boundaries`, a `prek` hook, and the CI static-check workflow.

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
