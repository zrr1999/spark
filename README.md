# spark

`spark` is the Spark suite for Pi: a controlled agentic development system where intent-specific Pi commands and canonical tools compose lower-level `pi-*` extension capabilities through project/task orchestration policy.

The repository also contains an MVP standalone Spark-first TUI host:

```text
spark
spark <initial goal>
```

The standalone `spark` command is published by `@zendev-lab/spark-cli` and built directly on `@earendil-works/pi-tui`. It owns the terminal loop, editor, transcript, follow-up queue, host runtime, provider registry, model selection, session store, and explicit Spark extension loading instead of embedding Pi SDK `InteractiveMode`. It also now has a local-only `spark daemon ...` surface for file-queued detached `session.run` work. The daemon is intentionally not a gateway: no HTTP server, bearer token, remote job API, service installer, or Pi RPC wrapper. Child/background role-runs still use the existing `pi --print --mode json` runner, so `pi` must remain installed and authenticated for workflow execution until Spark gets its own non-TUI role executor.

## Spark CLI native host vs Pi extension

Spark now has two supported host targets:

- **Pi extension host**: `packages/spark/src/extension/` is loaded by `@earendil-works/pi-coding-agent` through Pi's normal extension/package discovery. This remains the canonical Spark command and tool surface inside Pi, centered on ordinary default research behavior plus `/plan`, `/implement`, `/goal`, `/loop`, and `/workflow`.
- **Spark CLI native host**: `packages/spark-cli` starts `SparkHostRuntime` directly on `@earendil-works/pi-tui`, loads retained builtin extensions through explicit factories (`@zendev-lab/pi-ask`, `@zendev-lab/pi-cue`, `@zendev-lab/pi-roles`, `@zendev-lab/pi-graft`, `@zendev-lab/spark`), registers providers such as `baidu-oneapi`, discovers Spark skills from builtin/workspace/user layers, and runs turns through `@earendil-works/pi-ai`.

The extension packages depend on the shared `@zendev-lab/pi-extension-api` contract, not on Pi's concrete SDK package. Host-specific code belongs under `packages/spark-cli/src/host/` and TUI wrappers under `packages/spark-cli/src/tui/`; the Pi extension implementation should stay usable by Pi without importing spark-cli.

### Research workflow

Spark's multi-perspective research flow is a builtin `pi-workflows` workflow, not a model-picker target and not project/task-bound Spark mode. Use `/workflow:research <question>` (or `/workflow builtin:research <question>`) to run planning, parallel exploration, cross-checking, and report synthesis through Spark workflow/runtime plumbing. The builtin registry marks `research` as research-shaped routing metadata, but the command remains an independent workflow capability and does not require initialized Spark project state or a selected project.

Workflow discovery and preview use the canonical workflow tool:

```ts
workflow({ action: "list" });
workflow({ action: "read", selector: "builtin:research" });
```

The workflow accepts `question`, `prompt`, or `task`, plus optional `panelModels`/`models`, `panelSize`, `concurrency`, `retry`, `plannerModel`, `verifierModel`, and `judgeModel`/`reportModel` arguments. `fusion` and `deep-research` are folded into this user-facing research workflow; fan-out remains an internal orchestration method. Spark CLI no longer registers the retired Fusion model-picker target, and `~/.spark/config.json#fusion` is ignored.

## User-facing commands

Spark exposes intent-specific commands instead of a generic compatibility entry. Project-bound commands initialize local Spark state only when durable graph, review, artifact, or run state is needed. Spark first records the initial intent and uses investigation/planning work to gather context. It does not synthesize placeholder current tasks; the model claims one concrete task at a time within the active project. Follow-up asks should be grounded in the actual project state: when open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, Spark should use context-specific `ask` questions instead of leaving those questions as prose. The output language defaults from the current request language and is confirmed only when that decision is genuinely unclear.

Spark command modes are intentionally split:

- Ordinary input defaults to lightweight investigation, clarification, and reporting unless the request needs durable planning/execution state.
- `/plan <focus>` plans or refines the task DAG and does not execute work.
- `/implement <focus>` works through ready project tasks until the next blocker. It claims and finishes one task at a time, continues after successful finishes, and blocks for human answers instead of auto-answering asks.
- `/loop <focus>` starts or resumes a persistent foreground loop for open-ended continuous work such as monitoring fresh information, periodic repo checks, or ongoing observation until the user stops it. It may drive repeated concrete research/plan/implement steps, but it is not a `/goal` alias and must not request reviewer-gated completion. `/loop stop`, `/loop pause`, and Chinese pause aliases mark the loop `paused`; Spark shows it in the shared widget slot as `◆ Loop(...)`.
- `/goal <focus>` runs autonomous verified foreground goal progress until complete or blocked. Spark builds this on loop primitives plus goal objective tracking, reviewer-backed auto-decision/auto-ask during goal work, and reviewer-gated completion at the end. A session can have either `/goal` or `/loop` as the active foreground driver, not both. If no focus is provided, Spark derives the goal from the current project/task state and asks when ambiguous.
- `/workflow[:selector] <focus>` runs builtin or saved workflow scripts as an independent capability; it does not require initialized Spark project/task state or a selected project. Use `/workflow:research <question>` for the builtin research workflow, `/workflow:review <focus>` for skeptical review, `/workflow builtin:<id>` for other builtin workflows, `/workflow workspace:<name>` for `.spark/workflows/*.js`, and `/workflow user:<name>` for `~/.agents/workflows/*.js`. Empty `/workflow` (or `/workflows`) opens the blocking workflow navigator to choose a workflow or describe a one-off workflow request.

Project-bound flows create local Spark state under `.spark/` when durable graph, review, artifact, or run state is needed:

- `.spark/projects/` project/task file-tree state
- `.spark/reviews/index.json` rebuilt from subject-owned review records
- typed artifacts under `.spark/artifacts/`
- an initial task DAG
- an initial role plan artifact
- a run trace artifact

Spark is always available for lightweight investigation even before `.spark/` or `SPARK.md` exists. Direct commands such as `/plan`, `/implement`, `/goal`, and `/workflow[:selector]` do not create or overwrite root `SPARK.md`; when they initialize minimal Spark state, intent is kept in `.spark` artifacts.

`.spark/` is local runtime state and should be ignored by Git. Spark learnings live separately under the ignored local `.learnings/` directory for repo/workspace-scoped recall or under the user learning directory for personal cross-project knowledge; share them through explicit Markdown exports instead of committing the local artifact store by default. Use canonical owner tools for maintenance (`task_write({ action: "cache_cleanup" })`, `artifact({ action: "compact" })`, and workflow-run retention actions as they land); cleanup remains dry-run by default and must never target protected stores such as project graph, artifacts, notes, workflow runs, or subject-owned review records/indexes.

## Role model settings

Reusable role specs and model policy are intentionally separate. Role Markdown defines prompt, tools, rationale, and expected uses only; role-spec `model` and `defaultModel` fields are rejected. Model choices live in role model settings:

- project-local settings: `.spark/role-model-settings.json`
- user settings: `~/.agents/role-model-settings.json`
- resolution precedence: explicit run model, then project settings, then user settings

Manage settings through the canonical role tool actions: `role({ action: "model_list" })`, `role({ action: "model_get" })`, `role({ action: "model_set" })`, and `role({ action: "model_delete" })`. Spark ready-task dispatch resolves each executor role through those settings; non-interactive dispatch fails with guidance when a required role has no model, while interactive hosts may prompt for a model and save it as a user setting.

`GitHub` repo/issue creation is intentionally deferred.

## Packages

- `@zendev-lab/spark` — high-level `/plan`, `/implement`, `/goal`, `/loop`, and `/workflow[:selector]` command facade plus default lightweight research behavior that composes generic `pi-*` capabilities with Spark-owned orchestration policy, widget state, builtin Spark roles, and active-context provider registration.
- `@zendev-lab/spark-cli` — standalone Spark-first native TUI host built directly on `@earendil-works/pi-tui`; starts the `spark` command, owns its local transcript/follow-up queue, and provides a local daemon queue for detached session-run tasks.
- `@zendev-lab/spark-runtime` — Spark single-task runtime adapter that executes one task through `@zendev-lab/pi-roles`, writes artifacts, and owns task/run/timeout mapping above `RoleRun`.
- `@zendev-lab/pi-extension-api` — shared extension host/tool contract, refs, errors, and light JSON/fs/time helpers.
- `@zendev-lab/pi-artifacts` — reusable artifact/evidence store, durable artifact metadata/blobs, provenance/lineage contracts, and the canonical `artifact` action tool.
- `@zendev-lab/pi-tasks` — generic project/task/TODO/run graph capability and canonical `task_read` / `task_write` / `assign` tools; owns readiness, claims, TODO stores, and `.spark/projects.json` graph state without depending on Spark packages.
- `@zendev-lab/pi-learnings` — generic evidence-backed learning capability and canonical `learning({ action })` tool; owns `.learnings/` local/user learning stores.
- `@zendev-lab/pi-goal` — generic durable goal primitives and continuation prompt helpers; Spark owns the project-bound `/goal` facade while preserving historical serialized marker strings.
- `@zendev-lab/pi-workflows` — saved-script workflow discovery/runtime primitives plus workflow/DAG run-store support for `.spark/workflow-runs.json`.
- `@zendev-lab/pi-context` — registered context-provider capability with bounded list/preview actions and no freeform prompt injection.
- `@zendev-lab/pi-recall` — controlled explicit-scope recall candidate store/tool, separate from `.learnings/` and automatic memory.
- `@zendev-lab/pi-cue` — reusable Pi/cue-shell execution substrate.
- `@zendev-lab/pi-ask` — canonical public/default `ask` action tool with shared focused/flow protocol, state, renderer, and direct custom input handling behind that surface.
- `@zendev-lab/pi-roles` — canonical `role` action tool plus reusable `RoleSpec` definitions, builtin/extension/project/user role discovery, project/user Markdown stores, role model settings, and task-agnostic direct role calls. It owns fresh/forked CLI launch, timeout/cancel, stdout/stderr capture, model-setting resolution, and tolerant JSONL parsing; it does not own Spark task DAGs, asks, artifacts, review gates, or package-specific role semantics.

Navia is integrated as Spark's local web cockpit/projection product line while retaining separate package boundaries:

- `@navia-dev/web` — private SvelteKit local cockpit app under `apps/navia-web`; it renders Spark-owned task/run/artifact state from Navia SQLite projections and caches.
- `@navia-dev/runner` — Navia CLI/local service package under `packages/navia-runner`; task execution is routed through the Spark runtime bridge, while workspace registration and protocol delivery stay in the Navia boundary.
- `@navia-dev/protocol`, `@navia-dev/db`, `@navia-dev/domain`, `@navia-dev/system`, and `@navia-dev/ui` — Navia protocol, SQLite projection, domain, path, and UI packages under `packages/navia-*`.

Typical merged-repo Navia development commands:

```text
pnpm run navia:web                              # start the SvelteKit cockpit
pnpm --filter @navia-dev/runner run cli -- --help
pnpm run verify:navia                           # Navia check/test/build
```

Retired migration packages (`spark-core`, `spark-tasks`, `spark-learnings`, `spark-goal`, and `spark-workflows`) are no longer workspaces. No compatibility packages, long-lived `spark_*` tool aliases, or dual public/default tool surfaces are planned. Public action tools render as `tool action=<value> ...`. `spark-github` is intentionally deferred.

Pi package loading is manifest-first: the root `pi` manifest explicitly lists each user-visible extension entry (`@zendev-lab/pi-ask`, `@zendev-lab/pi-artifacts`, `@zendev-lab/pi-cue`, `@zendev-lab/pi-roles`, `@zendev-lab/pi-recall`, `@zendev-lab/pi-workflows`, `@zendev-lab/pi-graft`, the Baidu OneAPI provider, and `@zendev-lab/spark`). Library-only packages stay as dependencies. `pi-* -> spark-*` regressions are guarded by `pnpm run check:boundaries`, a `prek` hook, and the CI static-check workflow.

## Development

```text
pnpm install
pnpm run verify          # Spark package checks/tests
pnpm run verify:navia    # Navia check/test/build
packages/spark-cli/bin/spark --help
packages/spark-cli/bin/spark daemon --help
```

Use Node `>=26.0.0 <27` and pnpm `>=11 <12`; root `engines` plus `.npmrc` `engine-strict=true` make Node 26 mandatory for installs and scripts.

Tooling (pnpm, Vite+ / `vp`, prek hooks, CI) matches the stack documented in [`AGENTS.md`](./AGENTS.md).

Pi loads raw TypeScript from the package manifest; there is no build step.

## Docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/implementation-status.md`](./docs/implementation-status.md)
- [`docs/spark-store-inventory.md`](./docs/spark-store-inventory.md)
- [`docs/tools.md`](./docs/tools.md)
- [`docs/spark-host-architecture.md`](./docs/spark-host-architecture.md)
- [`docs/commit-convention.md`](./docs/commit-convention.md)
