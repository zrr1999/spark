# Spark design authority

This is the high-level design entry for Spark. It intentionally points to smaller owner documents instead of duplicating package, protocol, UI, or store contracts.

## Core boundaries

- **Daemon execution plane** — `apps/spark-daemon` is execution truth and local arbitration. Local RPC, runtime WebSocket/server uplink, queues, locks, dispatch policy, and headless `session.run` enter the daemon dispatcher; transports must not bypass it.
- **Server coordination plane** — `packages/spark-server` owns coordination, projection queries, artifact preview/cache helpers, and workspace route data. `apps/spark-cockpit` is the Cockpit web UI host (launch via `spark cockpit`); it mounts `spark-server` and must not import `spark-db` or local workspace `.spark` stores outside its `src/lib/server` boundary.
- **Capability packages** — reusable mechanisms live in `packages/spark-*` owner packages. `packages/pi-extension` is a Pi-compatible facade and should shrink toward registration/command/widget glue as owner packages absorb domains.
- **Artifact-backed UI** — generated UI is represented as safe artifact-backed data/AST, not executable MDX/JS/JSX/import/export/raw HTML.
- **Stable public tools** — public names stay canonical: `artifact`, `ask`, `task_read`, `task_write`, `assign`, `cue_*`, `graft_*`, `learning`, `recall`, and `role`.

## Current authority map

- Package/dependency ownership: [`docs/architecture/packages.md`](./docs/architecture/packages.md)
- Documentation map: [`docs/README.md`](./docs/README.md)
- Daemon/host architecture: [`docs/architecture/hosts.md`](./docs/architecture/hosts.md)
- Daemon execution reference: [`docs/architecture/daemon.md`](./docs/architecture/daemon.md)
- Cockpit projection boundary: [`docs/architecture/cockpit-projection.md`](./docs/architecture/cockpit-projection.md)
- Tool and command surface: [`docs/specs/tools.md`](./docs/specs/tools.md)
- Store ownership: [`docs/specs/store-inventory.md`](./docs/specs/store-inventory.md)
- Turn contract: [`docs/specs/turn.md`](./docs/specs/turn.md)
- Spark Cockpit visual design: [`docs/cockpit/visual-design.md`](./docs/cockpit/visual-design.md)

## Design rules

1. Keep one owner for each stateful domain; adapters should translate to owner APIs instead of reading stores directly.
2. Prefer deleting obsolete docs or merging their durable essence into current authority docs over preserving parallel histories.
3. Keep runtime wire/storage markers stable when they are serialized contract data, even if package names have changed.
4. Add or update checks when a boundary can regress mechanically.
