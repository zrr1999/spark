# Spark Cockpit product docs

These docs describe the local Spark Cockpit product line that grew out of the older Navia planning name. Current code uses Spark package names:

- `apps/spark-cockpit` — SvelteKit web cockpit and server routes.
- `packages/spark-server` — Cockpit coordination/query plane.
- `packages/spark-protocol` — daemon/server protocol schemas, fixtures, and shared refs.
- `packages/spark-db` — SQLite migrations, client helpers, and dialect.
- `packages/spark-system` — local path, permission, and command helpers.
- `apps/spark-daemon` — execution truth and daemon transport adapters.

## Current boundary

Spark Cockpit is a projection/cache UI, not an execution authority.

1. Browser traffic stays server-mediated through `apps/spark-cockpit` routes.
2. Server-side route code should call `@zendev-lab/spark-server` query/coordination APIs rather than importing `@zendev-lab/spark-db` or local workspace `.spark` stores directly.
3. Cockpit ↔ daemon traffic uses the `spark-protocol` runtime transport. Runtime WebSocket/server uplink is transport only; daemon dispatcher policy remains the execution arbitration point.
4. Spark `.spark/` stores and `spark-artifacts` remain authoritative for task/run/artifact/ask/review truth. Cockpit SQLite state is a reconnect-safe projection/cache.

## Active docs

- [`DESIGN.md`](./DESIGN.md) — interface design system for Spark Cockpit UI work. Product and package architecture live in the root [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) and [`../README.md`](../README.md).
- [`docs/rfcs/backend-server-rfc.md`](./docs/rfcs/backend-server-rfc.md) — SvelteKit/server boundary.
- [`docs/rfcs/data-model-rfc.md`](./docs/rfcs/data-model-rfc.md) — SQLite projection/cache schema contract.
- [`docs/rfcs/projection-store-boundary-rfc.md`](./docs/rfcs/projection-store-boundary-rfc.md) — route/query boundary and projection-store ownership.

Old release, publishing, troubleshooting, and research-survey notes were removed after their useful content was folded into the active architecture/status docs and Spark task graph.
