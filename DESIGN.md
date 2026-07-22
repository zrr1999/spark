# Spark design authority

## Boundaries

- `apps/spark-daemon` is execution truth and local arbitration. Local RPC and runtime WebSocket transports enter the same SQLite invocation scheduler and headless session executor.
- `packages/spark-cockpit-coordination` owns server coordination and Cockpit query/projection APIs. Cockpit projections are not task, run, artifact, ask, review, or invocation execution truth.
- Reusable capabilities live in `packages/spark-*`; app adapters translate into owner APIs instead of reading another owner's stores.
- `packages/pi-extension` is a host facade. It must remain usable without importing Spark app packages.
- Generated UI is artifact-backed data, never executable MDX, JS, JSX, imports, exports, or raw HTML.
- Public action-tool names stay canonical; serialized `.spark/` marker strings change only with an explicit migration.

## Rules

1. One authoritative owner per stateful domain.
2. Transports adapt; they do not duplicate execution or policy.
3. Persistent `session` and anonymous `role` are separate public concepts over one headless engine.
4. Cockpit may cache and project Spark state but may not mutate local Spark stores directly.
5. Boundary regressions must be mechanically checked.

Current contracts are indexed in [`docs/README.md`](./docs/README.md).
