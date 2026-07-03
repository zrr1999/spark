# Spark documentation map

This directory keeps current architecture contracts concise. Obsolete migration/evidence notes are removed instead of preserved in parallel when their durable essence is already covered by current docs or artifacts.

## Current authority

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — package ownership and dependency direction.
- [`spark-host-architecture.md`](./spark-host-architecture.md) — Pi host, native TUI host, and daemon execution/transport boundaries.
- [`spark-daemon-reference.md`](./spark-daemon-reference.md) — daemon execution-plane ADR/reference for lock, queue, local IPC, and cockpit transport adapters.
- [`spark-daemon-workspace-clients.md`](./spark-daemon-workspace-clients.md) — daemon-owned workspace client/borrowed-workspace contract.
- [`specs/turn.md`](./specs/turn.md) — turn/finish packet contract.
- [`tools.md`](./tools.md) — public command/tool vocabulary and runtime behavior.
- [`spark-store-inventory.md`](./spark-store-inventory.md) — local `.spark/` store ownership and cleanup policy.
- [`role-boundaries.md`](./role-boundaries.md) — role spec/run terminology and package ownership.
- [`spark-capabilities-and-generative-ui.md`](./spark-capabilities-and-generative-ui.md) — selected capability naming plus artifact-backed Generative UI direction.

## Product cockpit docs

[`navia/`](./navia/) contains Spark Cockpit product/RFC material from the Navia naming era. Those files remain useful where they describe `apps/spark-cockpit`, `packages/spark-server`, `packages/spark-protocol`, and `packages/spark-db`; legacy Navia package names should be read only as historical/migration context.
