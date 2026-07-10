# Spark docs

Use this directory as the map of current Spark contracts. Prefer one concise source of truth per topic; delete or merge stale notes instead of keeping parallel histories.

## Start here

- [`../DESIGN.md`](../DESIGN.md) — product and architecture entry point.
- [`../README.md`](../README.md) — package and command overview.
- [`architecture/packages.md`](./architecture/packages.md) — package ownership and dependency direction.
- [`specs/tools.md`](./specs/tools.md) — public command/tool vocabulary.
- [`records/implementation-status.md`](./records/implementation-status.md) — current implementation status.

## Directory guide

| Directory | Purpose |
| --- | --- |
| [`architecture/`](./architecture/) | Durable system boundaries and ownership decisions. |
| [`specs/`](./specs/) | Contracts that code, tests, or external users can rely on. |
| [`operations/`](./operations/) | Validation gates, harnesses, and operator recipes. |
| [`cockpit/`](./cockpit/) | Spark Cockpit product/UI design material. |
| [`research/`](./research/) | Bounded research inputs for planned work. |
| [`records/`](./records/) | Current status records worth retaining. |

## Topic index

### Architecture

- [`architecture/hosts.md`](./architecture/hosts.md) — Pi host, Spark TUI host, and daemon execution boundaries.
- [`architecture/daemon.md`](./architecture/daemon.md) — daemon lock, queue, local IPC, and transport reference.
- [`architecture/cockpit-projection.md`](./architecture/cockpit-projection.md) — Cockpit SQLite projection vs Spark execution truth.
- [`architecture/capabilities-ui.md`](./architecture/capabilities-ui.md) — capability naming and artifact-backed Generative UI direction.

### Specs

- [`specs/command-planes.md`](./specs/command-planes.md) — canonical `spark daemon/server/tui` command planes.
- [`specs/assignment-and-channels.md`](./specs/assignment-and-channels.md) — unified session management; Assign ≡ channel entry surfaces.
- [`specs/daemon-workspace-clients.md`](./specs/daemon-workspace-clients.md) — daemon-owned workspace client contract.
- [`specs/store-inventory.md`](./specs/store-inventory.md) — local `.spark/` store ownership and cleanup policy.
- [`specs/turn.md`](./specs/turn.md) — turn/finish packet contract.
- [`specs/spark-runtime-integration.md`](./specs/spark-runtime-integration.md) — `spark run --json` event schema and third-party scheduler/runtime integration guide.
- [`specs/spark-cockpit-remote-access.md`](./specs/spark-cockpit-remote-access.md) — single-user token auth, 0.0.0.0 binding, and PWA install guide for remote Cockpit use.
- [`specs/spark-cockpit-notifications.md`](./specs/spark-cockpit-notifications.md) — opt-in browser/PWA notifications for long-task terminal states and blockers.
- [`specs/tools.md`](./specs/tools.md) — public command/tool vocabulary and runtime behavior.
- [`specs/roles-api.md`](./specs/roles-api.md), [`specs/roles-boundaries.md`](./specs/roles-boundaries.md), [`specs/roles-run-modes.md`](./specs/roles-run-modes.md) — role contracts and launch modes.
- [`specs/commits.md`](./specs/commits.md) — commit convention.

### Operations and UI

- [`operations/daemon-readiness.md`](./operations/daemon-readiness.md) — daemon readiness gate.
- [`operations/zellij-harness.md`](./operations/zellij-harness.md) — native TUI/zellij harness.
- [`cockpit/visual-design.md`](./cockpit/visual-design.md) — Spark Cockpit visual design authority.
- [`cockpit/agent-conversation-ui.md`](./cockpit/agent-conversation-ui.md) — provider-neutral Svelte agent conversation UI adoption plan.

### Research

- [`research/competitor-taxonomy-2026-07.md`](./research/competitor-taxonomy-2026-07.md) — competitor / adjacent-project taxonomy for Spark.
- [`research/pi-extension-ecosystem-2026-07.md`](./research/pi-extension-ecosystem-2026-07.md) — Pi extension ecosystem notes for self-owned capabilities.
