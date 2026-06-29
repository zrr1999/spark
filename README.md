# spark

`spark` is the Spark suite for Pi: a controlled agentic development system where intent-specific Pi commands and canonical tools compose lower-level `pi-*` extension capabilities through project/task orchestration policy.

The repository also contains standalone Spark entrypoints. The target topology mirrors cue-shell-style dispatch: `apps/spark-cli` publishes a thin `spark` dispatcher, and the dispatcher resolves public subcommands such as `spark tui`, `spark daemon`, and `spark cockpit` to Spark app surfaces.

```text
spark tui
spark daemon
spark cockpit
spark <extension-subcommand>
```

The standalone `spark` command is published by `@zendev-lab/spark-cli` from `apps/spark-cli` and is only a dispatcher. The Spark-first native TUI host lives in `apps/spark-tui` as `@zendev-lab/spark-tui-app` / `spark-tui`, built through the Spark-owned `@zendev-lab/spark-tui` boundary backed by `@earendil-works/pi-tui`. It owns the terminal loop, editor, transcript, follow-up queue, host runtime, provider registry, model selection, session store, and explicit Spark extension loading instead of embedding Pi SDK `InteractiveMode`. `spark --print`, `spark daemon submit`, and cockpit-triggered background role-runs now route through the single Spark daemon/client boundary. The daemon injects Spark's native headless role executor into `@zendev-lab/spark-runtime`, so daemon-owned background work no longer depends on spawning `pi --print --mode json`.

## Spark TUI native host vs Pi extension

Spark now has two supported host targets:

- **Pi extension host**: `packages/spark-extension/src/extension/` is loaded by `@earendil-works/pi-coding-agent` through Pi's normal extension/package discovery. This remains the canonical Spark command and tool surface inside Pi, centered on ordinary default research behavior plus `/plan`, `/implement`, `/goal`, `/loop`, and `/workflow`.
- **Spark TUI native host**: `apps/spark-tui` starts `SparkHostRuntime` with terminal presentation routed through `@zendev-lab/spark-tui` and the app-local `pi-tui` adapter, loads retained builtin extensions through explicit factories (`@zendev-lab/pi-ask`, `@zendev-lab/pi-cue`, `@zendev-lab/pi-roles`, `@zendev-lab/pi-graft`, `@zendev-lab/spark-extension`), registers providers such as `baidu-oneapi`, discovers workspace/user skills, and runs turns through `@earendil-works/pi-ai`. Spark product defaults no longer bundle project-idea or SPARK.md creation prompts; those live in external skills such as `project-spark`.

The extension packages depend on the shared `@zendev-lab/pi-extension-api` contract, not on Pi's concrete SDK package. Host-specific code belongs under `apps/spark-tui/src/host/` and TUI wrappers under `apps/spark-tui/src/tui/`; the Pi extension implementation should stay usable by Pi without importing Spark app packages.

Native TUI editor parity is intentionally implemented on the real `pi-tui` editor path: `@path` references become `<file>` context blocks, dragged/pasted image file paths or `@image` references become image attachment placeholders, `!command` submits captured shell output, and `!!command` records a folded shell tool result without sending output to the model. Busy input also follows Pi semantics: `Enter` queues steering updates, `Alt+Enter` queues follow-up turns, `Escape` aborts and restores queued text, and `Alt+Up` retrieves queued text. Clipboard binary image extraction and the `Alt+Enter` chord remain terminal/platform dependent; terminals such as Windows Terminal should paste image file paths and use terminal/keybinding remaps where needed.

Spark native CLI parity includes Pi-style global surfaces routed through the daemon-first app: `spark --mode json --print <prompt>` emits JSONL lifecycle/queue events, `spark --mode rpc` starts a JSONL command loop for prompt/state/message/session commands, `spark --list-models [search]` lists registered provider models, and top-level `spark install|remove|update|list|config` manages config-backed extensions/providers/skills/prompt templates/themes without implicit secret deletion or network package mutation. The `@zendev-lab/spark-tui-app` package also exports SDK building blocks (`createSparkCliHostServices`, `SparkAgentSession`, `SparkHostRuntime`, session store, provider/model registry, config/resource helpers) for embedding without spawning Pi.

### Research workflow

Spark's multi-perspective research flow is a builtin `pi-workflows` workflow, not a model-picker target and not project/task-bound Spark mode. Use `/workflow:research <question>` (or `/workflow builtin:research <question>`) to run planning, parallel exploration, cross-checking, and report synthesis through Spark workflow/runtime plumbing. The builtin registry marks `research` as research-shaped routing metadata, but the command remains an independent workflow capability and does not require initialized Spark project state or a selected project.

Workflow discovery and preview use the canonical workflow tool; explicit dynamic execution uses Spark's `workflow_run` surface:

```ts
workflow({ action: "list" });
workflow({ action: "read", selector: "builtin:research" });
workflow_run({ selector: "builtin:research", args: { question: "..." } });
```

Generated one-off scripts passed to `workflow_run({ script })` must be metadata-first JavaScript and run through Spark workflow role-run boundaries (`agent`, `parallel`, `pipeline`, `stage`, `workflow`, `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`, `budget`, and `artifactRecord`; deprecated `phase` remains an old-workflow alias). Risky generated or saved runs are approval-gated before any child agents or web/fetch adapters start: Spark summarizes fan-out, web/fetch use, write/isolation/shell tool policy, long timeouts, token/resource bounds, script hash, and Graft base metadata, then records scoped approval provenance on the dynamic run. Each dynamic run is persisted in the v2 event store under `.spark/dynamic-workflows/runs/<run-id>/` with script hash/body, args, metadata, append-only events, projected snapshots, result/error, captured base metadata, approval provenance when required, per-agent telemetry, usage totals, saved-workflow metadata, and acknowledgement state; `.spark/dynamic-workflow-runs.json` is legacy-import-only for old runs. Workflow token budgets use provider/role-run token usage when available and mark fallback estimates explicitly; `/workflows` and run-status surfaces render actual/estimated tokens, optional cost, child run refs, liveness timestamps, and token rates. The `/workflows` dashboard/navigator and run-status surface can inspect dynamic runs and apply manager-backed safe controls (`pause`, `resume`, `stop`, `restart`, `save`, and `ack`, depending on run state). Saving writes a metadata-first script to a controlled workspace workflow by default, can target user workflow scope with `workflowScope: "user"`, and chooses a numeric suffix instead of silently overwriting an existing workflow. For Graft-backed isolation, `agent(..., { isolation: "graft" })` injects the stored base as per-run `GRAFT_BASE_REF`, narrows child tools to Graft scratch/candidate/validation operations, and asks the child to return scratch/candidate/patch refs; Graft scratch/capture treats that env base as the implicit first-operation base when explicit base/from is absent, while direct working-tree writes stay outside the isolated path. The research workflow accepts `question`, `prompt`, or `task`, plus optional `queries`, `urls`, `maxQueries`, `searchResultsPerQuery`, `fetchTopN`, `collectErrors`, `panelModels`/`models`, `panelSize`, `concurrency`, `retry`, `plannerModel`, `verifierModel`, and `judgeModel`/`reportModel` arguments. It plans diverse searches, calls workflow `webSearch`/`fetchContent` adapters when configured, cross-checks fetched sources with source analysts, and writes a cited report that must not invent source URLs. The review workflow is an adversarial review loop with investigation/search, parallel critiques, rebuttal, and final verdict. `fusion` and `deep-research` are folded into this user-facing research workflow; fan-out remains an internal orchestration method. Spark CLI no longer registers the retired Fusion model-picker target, and `~/.spark/config.json#fusion` is ignored.

## User-facing commands

Spark exposes intent-specific commands instead of a generic duplicate entry. Project-bound commands initialize local Spark state only when durable graph, review, artifact, or run state is needed. Spark first records the initial intent and uses investigation/planning work to gather context. It does not synthesize placeholder current tasks; the model claims one concrete task at a time within the active project. Follow-up asks should be grounded in the actual project state: when open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, Spark should use context-specific `ask` questions instead of leaving those questions as prose. The output language defaults from the current request language and is confirmed only when that decision is genuinely unclear.

Spark command modes are intentionally split:

- Ordinary input defaults to lightweight investigation, clarification, and reporting unless the request needs durable planning/execution state.
- `/plan <focus>` plans or refines the task DAG and does not execute work.
- `/implement <focus>` works through ready project tasks until the next blocker. It claims and finishes one task at a time, continues after successful finishes, and blocks for human answers instead of auto-answering asks.
- `/loop <focus>` starts or resumes a persistent foreground loop for open-ended continuous work such as monitoring fresh information, periodic repo checks, or ongoing observation until the user stops it. It may drive repeated concrete research/plan/implement steps, but it is not a `/goal` alias and must not request reviewer-gated completion. Successful `/loop` turns choose their next cadence by calling the `loop` tool with `action: "schedule"` rather than relying on a fixed tick interval; they should use `ask` first when cadence/cost/urgency depends on user preference. `/loop stop` and Chinese stop aliases remove the plain loop instead of leaving a paused loop; `/loop pause` is removed. Spark shows active loops and scheduled cadence in the foreground widget slot as `◆ Loop(...)`.
- `/goal <focus>` runs autonomous verified foreground goal progress until complete or blocked. Spark builds this on loop primitives plus goal objective tracking, reviewer-backed auto-decision/auto-ask during goal work, and reviewer-gated completion at the end. A session can have either `/goal` or `/loop` as the active foreground driver, not both. If no focus is provided, Spark derives the goal from the current project/task state and asks when ambiguous.
- `/workflow[:selector] <focus>` runs builtin or saved workflow scripts as an independent capability; it does not require initialized Spark project/task state or a selected project. Use `/workflow:research <question>` for the builtin research workflow, `/workflow:review <focus>` for skeptical review, `/workflow builtin:<id>` for other builtin workflows, `/workflow workspace:<name>` for `.spark/workflows/*.js`, and `/workflow user:<name>` for `~/.agents/workflows/*.js`. Empty `/workflow` (or `/workflows`) opens the blocking workflow navigator to choose a saved workflow, describe a one-off workflow request, or inspect/control persisted dynamic `workflow_run` records.
- `/ultracode <focus>` is the explicit opt-in high-effort path for complex prompts: Spark asks the agent to reuse a saved workflow or generate one metadata-first JavaScript workflow with bounded fan-out, quality helpers, `workflow_run` approval/persistence, and standalone synthesis. Ordinary prompts are not silently rewritten into ultracode workflows.

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

Spark package names are type-first:

- `@zendev-lab/spark-cli` — thin dispatcher package for the root `spark` binary under `apps/spark-cli`. It routes public `spark ...` command groups to Spark app surfaces and does not own product runtime logic.
- `@zendev-lab/spark-tui` — Spark-owned reusable TUI boundary over `@earendil-works/pi-tui`; centralizes text width/truncation/wrapping, key parsing, and current `pi-tui` component/runtime exports so future renderer swaps do not leak through extension packages.
- `@zendev-lab/spark-tui-app` — executable Spark native TUI app under `apps/spark-tui`; publishes the `spark-tui` binary plus public provider/headless-executor surfaces used by the daemon.
- `@zendev-lab/spark-daemon` — Spark daemon executable app package under `apps/spark-daemon`.
- `@zendev-lab/spark-cockpit` — private Spark Cockpit SvelteKit executable app package under `apps/spark-cockpit`.
- `@zendev-lab/spark-extension` — Spark Pi-style extension facade: high-level `/plan`, `/implement`, `/goal`, `/loop`, and `/workflow[:selector]` command facade plus default lightweight research behavior that composes generic `pi-*` capabilities with Spark-owned orchestration policy, widget state, builtin Spark roles, and active-context provider registration.
- `@zendev-lab/spark-runtime` — Spark single-task runtime adapter that executes one task through `@zendev-lab/pi-roles`, writes artifacts, and owns task/run/timeout mapping above `RoleRun`.
- `@zendev-lab/spark-protocol` — single Spark shared protocol/schema package. It owns JSON-safe refs/errors plus runtime, cockpit, interaction, and view-model schemas; it is intentionally not named `spark-view-protocol` because non-view protocols live here too.
- `@zendev-lab/pi-extension-api` — shared extension host/tool contract, refs, errors, and light JSON/fs/time helpers. It remains separate from `spark-extension` so Pi-style host contracts stay host-neutral.
- `@zendev-lab/pi-artifacts` — reusable artifact/evidence store, durable artifact metadata/blobs, provenance/lineage contracts, and the canonical `artifact` action tool.
- `@zendev-lab/pi-tasks` — generic project/task/TODO/run graph capability and canonical `task_read` / `task_write` / `assign` tools; owns readiness, claims, TODO stores, and `.spark/projects.json` graph state without depending on Spark packages.
- `@zendev-lab/pi-learnings` — generic evidence-backed learning capability and canonical `learning({ action })` tool; owns `.learnings/` local/user learning stores.
- `@zendev-lab/pi-loop` — generic foreground loop and goal primitives, including non-completing loop continuation plus goal objective/completion prompt helpers; Spark owns the project-bound `/loop` and `/goal` facades while preserving historical serialized marker strings.
- `@zendev-lab/pi-workflows` — saved-script workflow discovery/runtime primitives plus workflow/DAG run-store support for `.spark/workflow-runs.json`.
- `@zendev-lab/pi-context` — registered context-provider capability with bounded list/preview actions and no freeform prompt injection.
- `@zendev-lab/pi-recall` — controlled explicit-scope recall candidate store/tool, separate from `.learnings/` and automatic memory.
- `@zendev-lab/pi-cue` — reusable Pi/cue-shell execution substrate.
- `@zendev-lab/pi-ask` — canonical public/default `ask` action tool with shared focused/flow protocol, state, renderer, and direct custom input handling behind that surface.
- `@zendev-lab/pi-roles` — canonical `role` action tool plus reusable `RoleSpec` definitions, builtin/extension/project/user role discovery, project/user Markdown stores, role model settings, and task-agnostic direct role calls. It owns fresh/forked CLI launch, timeout/cancel, stdout/stderr capture, model-setting resolution, and tolerant JSONL parsing; it does not own Spark task DAGs, asks, artifacts, review gates, or package-specific role semantics.

Spark Cockpit is the local web cockpit/projection product line while retaining separate implementation package boundaries:

- `@zendev-lab/spark-protocol` is the consolidated Spark protocol package for runtime, Cockpit, interaction, and view-model schemas.
- `@zendev-lab/spark-db` owns shared SQLite migrations, database helpers, and the Node SQLite dialect used by Spark Cockpit and the daemon.
- `@zendev-lab/spark-system` owns shared filesystem path, permission, command, and local runtime helpers used by Spark Cockpit and the daemon.
- Former `navia-domain` and `navia-ui` marker packages were removed instead of preserving empty shells.

Typical merged-repo development commands:

```text
pnpm run check                                    # full validation gate
pnpm run build                                    # daemon + cockpit production builds
pnpm run preview                                  # start the local cockpit dev server
pnpm install -g .                                 # link the unified spark CLI
pnpm run publish                                  # validate, build, publish public packages
```

Retired migration packages (`spark-core`, `spark-tasks`, `spark-learnings`, `spark-goal`, and `spark-workflows`) are no longer workspaces. No duplicate packages, long-lived `spark_*` tool aliases, or dual public/default tool surfaces are planned. Public action tools render as `tool action=<value> ...`. `spark-github` is intentionally deferred.

Pi package loading is manifest-first: the root `pi` manifest explicitly lists each user-visible extension entry (`@zendev-lab/pi-ask`, `@zendev-lab/pi-artifacts`, `@zendev-lab/pi-cue`, `@zendev-lab/pi-roles`, `@zendev-lab/pi-recall`, `@zendev-lab/pi-workflows`, `@zendev-lab/pi-graft`, the Baidu OneAPI provider, and `@zendev-lab/spark-extension`). Library-only packages stay as dependencies. `pi-* -> spark-*` regressions are guarded by the boundary checker inside `pnpm run check`, a `prek` hook, and the CI static-check workflow.

## Development

```text
pnpm install
pnpm run check
pnpm run build
pnpm run preview
pnpm run publish
apps/spark-cli/bin/spark --help
apps/spark-cli/bin/spark tui --help
apps/spark-cli/bin/spark daemon --help
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
