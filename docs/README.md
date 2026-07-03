# Spark documentation map

This directory keeps current architecture contracts concise. Obsolete migration/evidence notes are removed instead of preserved in parallel when their durable essence is already covered by current docs or artifacts.

## Top-level authority

- [`../DESIGN.md`](../DESIGN.md) — high-level design entry and boundary map.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — package ownership and dependency direction.
- [`../README.md`](../README.md) — product/package overview.

## Structure

- [`architecture/`](./architecture/) — daemon, host, package, and capability architecture notes.
- [`specs/`](./specs/) — current contracts for turns, tools, stores, roles, daemon workspace clients, and conventions.
- [`research/`](./research/) — bounded research reports used to plan new capabilities.
- [`records/`](./records/) — current implementation status and retained validation/status records.
- [`navia/`](./navia/) — Spark Cockpit product/UI material from the older Navia naming era, pruned to files that still describe current Cockpit boundaries.

## Frequently used docs

- [`architecture/spark-host-architecture.md`](./architecture/spark-host-architecture.md) — Pi host, native TUI host, and daemon execution/transport boundaries.
- [`architecture/spark-daemon-reference.md`](./architecture/spark-daemon-reference.md) — daemon execution-plane ADR/reference for lock, queue, local IPC, and cockpit transport adapters.
- [`specs/spark-daemon-workspace-clients.md`](./specs/spark-daemon-workspace-clients.md) — daemon-owned workspace client/borrowed-workspace contract.
- [`specs/turn.md`](./specs/turn.md) — turn/finish packet contract.
- [`specs/tools.md`](./specs/tools.md) — public command/tool vocabulary and runtime behavior.
- [`specs/spark-store-inventory.md`](./specs/spark-store-inventory.md) — local `.spark/` store ownership and cleanup policy.
- [`specs/role-boundaries.md`](./specs/role-boundaries.md) — role spec/run terminology and package ownership.
- [`architecture/spark-capabilities-and-generative-ui.md`](./architecture/spark-capabilities-and-generative-ui.md) — selected capability naming plus artifact-backed Generative UI direction.
- [`research/pi-extension-ecosystem-2026-07.md`](./research/pi-extension-ecosystem-2026-07.md) — Pi extension ecosystem research and self-owned Spark capability plan.
