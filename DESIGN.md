# Spark design authority

This is the high-level design entry for Spark. It intentionally points to smaller owner documents instead of duplicating package, protocol, UI, or store contracts.

## Core boundaries

- **Daemon execution plane** — `apps/spark-daemon` is execution truth and local arbitration. Local RPC, runtime WebSocket/server uplink, queues, locks, dispatch policy, and headless `session.run` enter the daemon dispatcher; transports must not bypass it.
- **Coordination/query plane** — `packages/spark-server` owns Spark Cockpit server-side coordination, projection queries, artifact preview/cache helpers, and workspace route data. `apps/spark-cockpit` is the UI/server host and should call `spark-server` instead of importing `spark-db` or local workspace `.spark` stores outside its `src/lib/server` boundary.
- **Capability packages** — reusable mechanisms live in `packages/spark-*` owner packages. `packages/pi-extension` is a Pi-compatible facade and should shrink toward registration/command/widget glue as owner packages absorb domains.
- **Artifact-backed UI** — generated UI is represented as safe artifact-backed data/AST, not executable MDX/JS/JSX/import/export/raw HTML.
- **Stable public tools** — public names stay canonical: `artifact`, `ask`, `task_read`, `task_write`, `assign`, `cue_*`, `graft_*`, `learning`, `recall`, and `role`.

## Current authority map

- Package/dependency ownership: [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- Documentation map: [`docs/README.md`](./docs/README.md)
- Daemon/host architecture: [`docs/architecture/spark-host-architecture.md`](./docs/architecture/spark-host-architecture.md)
- Daemon execution reference: [`docs/architecture/spark-daemon-reference.md`](./docs/architecture/spark-daemon-reference.md)
- Tool and command surface: [`docs/specs/tools.md`](./docs/specs/tools.md)
- Store ownership: [`docs/specs/spark-store-inventory.md`](./docs/specs/spark-store-inventory.md)
- Turn contract: [`docs/specs/turn.md`](./docs/specs/turn.md)
- Spark Cockpit visual design: [`docs/navia/DESIGN.md`](./docs/navia/DESIGN.md)

## Design rules

1. Keep one owner for each stateful domain; adapters should translate to owner APIs instead of reading stores directly.
2. Prefer deleting obsolete docs or merging their durable essence into current authority docs over preserving parallel histories.
3. Keep runtime wire/storage markers stable when they are serialized contract data, even if package names have changed.
4. Add or update checks when a boundary can regress mechanically.
