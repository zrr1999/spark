# pi-spark

`pi-spark` is the Spark suite for Pi: a controlled agentic
development system where the user-facing entry point is
`/spark`, and lower-level capabilities are kept as Spark
primitives.

## User-facing entry point

```text
/spark <idea>
```

`/spark` initializes local Spark state without asking the
user to complete a broad intake form. Spark first records
the initial intent and uses investigation tasks to gather
context. It does not synthesize placeholder current tasks;
the model claims one or more concrete tasks within the active
thread. Follow-up asks
should be targeted to the actual project state. The output
language defaults from the current request language and is
confirmed when Spark asks a targeted clarification.

The first vertical slice then creates local Spark state under `.spark/`:

- `.spark/thread.json`
- `.spark/review-gate.json`
- typed artifacts under `.spark/artifacts/`
- an initial task DAG
- an initial agent plan artifact
- a review gate
- a run trace artifact

A root `SPARK.md` is only materialized when the current
`cwd` looks like a concrete repo (currently: `.git`
exists in `cwd`). In workspace-like directories, Spark
still creates `.spark/` state and a `spark-md` artifact,
but skips the root `SPARK.md` file.

`GitHub` repo/issue creation is intentionally deferred.

## Packages

- `spark` — high-level `/spark` facade and Spark status/run tools.
- `spark-core` — internal shared refs, schemas, errors, and contracts.
- `pi-cue` — reusable Pi/cue-shell execution substrate;
  absorbs `pi-cue-shell` code without a compatibility
  package and does not depend on `spark-core`.
- `spark-agents` — builtin/managed agent registry and
  instruction-only runner surface; absorbs subagent
  runner ideas without exposing `subagents` as a product
  concept.
- `spark-tasks` — durable thread/task DAG, model-claimed current task, queue, runs, scheduler helpers, and agent bindings; TODO state is stored outside `.spark/thread.json` and can be session-scoped to avoid concurrent agent conflicts.
- `spark-artifacts` — typed durable artifacts with hashes,
  blobs, provenance, and lineage links.
- `spark-review` — verification gates and review artifacts.
- `pi-ask` — minimal `ask_user` plus reusable `ask_flow` protocol/state/renderer with direct custom input handling.
- `spark-ask` — lightweight Spark-specific ask presets and copy built on top of `pi-ask`.

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
