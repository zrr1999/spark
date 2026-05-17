# pi-spark

`pi-spark` is the Spark suite for Pi: a controlled agentic
development system where the user-facing entry point is
`/spark`, and lower-level capabilities are kept as Spark
primitives.

## User-facing entry point

```text
/spark <idea>
```

Before `/spark` initializes a thread, it can ask for
clarification so Spark captures the concrete outcome,
delivery mode, confirmed output language, next action,
and smallest useful slice instead of guessing from an
ambiguous request. The output language defaults from the
current request language, but the user confirms that
choice during clarification.

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
- `spark-tasks` — thread/task DAG, current interaction task, per-task dynamic TODOs, queue, runs, scheduler helpers, and agent bindings.
- `spark-artifacts` — typed durable artifacts with hashes,
  blobs, provenance, and lineage links.
- `spark-review` — verification gates and review artifacts.
- `pi-ask` — minimal `ask_user` primitive and stable ask protocol with direct custom input handling.
- `spark-ask` — structured Spark ask workflows built on top of `pi-ask`.

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
