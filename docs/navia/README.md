# Navia

> Spark's local web cockpit. A SvelteKit app and SQLite projection/cache layer
> render Spark-owned task runs, asks, artifacts, and workspace evidence without
> becoming the execution source of truth.

**Status.** Early `0.1.x` Spark-monorepo product line. The current merged build
supports local owner setup, token-based workspace registration, local workspace
connections, workspace and project cockpit surfaces, command delivery, and
Spark-runtime-backed task execution through `@zendev-lab/spark-daemon`. Remaining work
is tracked in [docs/plans/release-roadmap.md](./docs/plans/release-roadmap.md).

## Contents

- [Architecture at a glance](#architecture-at-a-glance)
- [Repository layout](#repository-layout)
- [Terminology](#terminology)
- [Requirements](#requirements)
- [Local development](#local-development)
- [Workspace registration](#workspace-registration)
- [Validation](#validation)
- [Release gates](#release-gates)
- [npm publishing](#npm-publishing)
- [Troubleshooting](#troubleshooting)
- [Further reading](#further-reading)

## Architecture at a glance

Navia separates three concerns by design:

1. **Browser ↔ server.** The SvelteKit app talks only to the local Navia
   server. Browser traffic stays server-mediated.
2. **Server ↔ local service.** The server brokers a typed protocol with one or
   more local `navia` services over `/api/v1/runtime/*`.
3. **Local service ↔ Spark workspace.** The local service registers workspace
   directories, routes task starts through Spark runtime primitives, and reports
   Spark task graphs, asks, reviews, invocations, and artifacts back to the
   server as projections.

Spark `.spark/` stores and Spark artifact stores remain the source of truth for
execution state. Navia's web app renders SQLite projections and preview caches
for the local cockpit; losing `.navia` projection/cache state must not corrupt
Spark execution truth.

## Repository layout

This is a pnpm + Vite-Plus monorepo.

```
spark/
├─ apps/
│  ├─ navia-web/          # SvelteKit web cockpit (private; bundled inside the server)
│  └─ spark-daemon/       # Spark daemon CLI/service entry
├─ packages/
│  ├─ navia-protocol/     # daemon ↔ server protocol schemas, envelopes, identifiers
│  ├─ navia-db/           # SQLite migrations and database helpers
│  ├─ navia-domain/       # shared domain utilities
│  ├─ navia-system/       # local path and private-file helpers
│  └─ navia-ui/           # shared UI surface
├─ docs/navia/            # Navia design, RFCs, release docs, troubleshooting
└─ packages/spark-runtime/, packages/pi-*  # Spark execution/source-of-truth packages
```

Published surface (npm, scoped `@zendev-lab/navia-*`):

| Package               | Role                                                   |
| --------------------- | ------------------------------------------------------ |
| `@zendev-lab/spark-daemon`   | Spark daemon CLI/service; routes task execution through Spark runtime |
| `@zendev-lab/navia-protocol` | Runner/server protocol schemas, envelopes, identifiers |
| `@zendev-lab/navia-db`       | SQLite migrations and database helpers                 |
| `@zendev-lab/navia-domain`   | Shared domain utilities                                |
| `@zendev-lab/navia-system`   | Local path and private-file helpers                    |
| `@zendev-lab/navia-ui`       | Shared UI surface                                      |

`@zendev-lab/navia-web` is intentionally private until the packaged server
distribution is finalized; the root package is private because it is a
workspace aggregator.

## Terminology

Navia distinguishes the product flow from the wire protocol:

- **Workspace registration** is the product setup flow. Users run
  `navia ws register` against a local directory; Navia then
  surfaces a server-visible workspace backed by that directory.
- **Spark daemon** names the internal `@zendev-lab/spark-daemon` package boundary behind
  workspace registration and Spark runtime bridging. The package binary is
  `spark-daemon`; public Spark CLI integration will route through `spark daemon`.
- **Runtime** is reserved for protocol, API route, database, and
  wire-contract names: `/api/v1/runtime/*`, `runtime.hello`,
  `runtime_workspace_bindings`, and similar identifiers. Spark runtime remains
  the execution owner behind the daemon bridge.

UI copy, setup docs, npm-facing docs, and release notes prefer
_workspace registration_ and _workspace directory_ language unless they
are describing implementation diagnostics or a literal protocol/storage
identifier.

## Requirements

- Node `>=26 <27`
- pnpm `>=11 <12`

## Local development

```bash
pnpm install
pnpm run cockpit:web
pnpm run spark-daemon:cli -- --help
```

`pnpm run cockpit:web` starts the local SvelteKit cockpit from the Spark root.
The Spark daemon CLI can be inspected with `pnpm run spark-daemon:cli -- --help` and can
register workspace directories once the server shows a registration command.

The production-style data layout uses XDG locations such as
`${XDG_DATA_HOME:-~/.local/share}/navia/server`, unless one of
`NAVIA_SERVER_DATA_DIR`, `NAVIA_SERVER_CACHE_DIR`, or
`NAVIA_SERVER_STATE_DIR` is set.

## Workspace registration

1. Start the web app and create the local owner.
2. From the **Create workspace** flow on Home or **Settings → Registration**,
   generate a one-time workspace registration token and the matching command.
3. Run that command against the local directory you want Navia to manage:

   ```bash
   navia ws register /path/to/workspace \
     --server-url http://127.0.0.1:5173 \
     --token <token>
   ```

   If you omit the path from an interactive `navia ws register`, `navia`
   prompts for it. Non-interactive registration should pass the path
   explicitly.

4. Once the directory comes online, confirm the workspace in the web app,
   create a project, and start the first task from the project cockpit.

Workspace registration tokens are shown exactly once. Navia stores only
their hash; if you lose a token, generate a new one.

## Validation

The fast inner loop:

```bash
pnpm run cockpit:check
pnpm run cockpit:test
pnpm run cockpit:build
pnpm run verify:merged
```

## Release gates

Layered gates, smallest first:

| Command                    | What it adds                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm release:check`       | `check` + `test` + `build` + `format:check`.                                          |
| `pnpm release:smoke`       | Above plus the simulator runner smoke (fake-runner projection fixtures).              |
| `pnpm release:e2e`         | Above plus the real `navia` local-service happy-path gate against an isolated server. |
| `pnpm release:gate`        | All of the above in one command.                                                      |
| `pnpm release:e2e:real-pi` | Legacy real-Pi compatibility gate; Spark runtime bridge coverage is preferred in the merged repo. |
| `pnpm pack:check`          | Validates each publishable package's `npm pack` output.                               |

`pnpm release:e2e` is retained for historical standalone release work. In the
merged Spark repo, prefer `pnpm run spark-daemon:e2e`, `pnpm run verify:cockpit`, and
`pnpm run verify:merged`. For the contract and trade-offs see
[docs/release/e2e-gate.md](./docs/release/e2e-gate.md); for failure modes
see [docs/release/troubleshooting.md](./docs/release/troubleshooting.md).

## npm publishing

The publish surface is the `@zendev-lab/navia-*` runner and shared packages
listed above. The root and `@zendev-lab/navia-web` are private by design.

The full publishing checklist — versioning, provenance, dist-tags, smoke
gates, and pre-release prerequisites — lives in
[docs/release/npm-publishing.md](./docs/release/npm-publishing.md). The package
scope/rename/collapse decision packet lives in
[docs/release/package-naming-publishing-decision.md](./docs/release/package-naming-publishing-decision.md).

Before a first public release the project still needs to:

- pick and commit a `LICENSE` file,
- publish the GitHub remote and add `repository` and `homepage` metadata
  to each publishable `package.json`,
- finalize the packaged server distribution before unprivating
  `@zendev-lab/navia-web`.

These are tracked items, not optional polish; do not publish without
them.

## Troubleshooting

[docs/release/troubleshooting.md](./docs/release/troubleshooting.md) covers:

- local server startup,
- format-check failures,
- the simulator and real-runner gates,
- runtime workspace binding timeouts,
- workspace registration in CI.

Start there before opening an issue.

## Further reading

Architecture and product context:

- [architecture-sketch.md](./architecture-sketch.md) — system shape and
  ownership boundaries.
- [implementation-plan.md](./implementation-plan.md) — staged delivery plan.
- [DESIGN.md](./DESIGN.md) — interface design contract for any UI work.

RFCs:

- [docs/rfcs/backend-server-rfc.md](./docs/rfcs/backend-server-rfc.md)
- [docs/rfcs/runner-protocol-rfc.md](./docs/rfcs/runner-protocol-rfc.md)
- [docs/rfcs/data-model-rfc.md](./docs/rfcs/data-model-rfc.md)
- [docs/rfcs/projection-store-boundary-rfc.md](./docs/rfcs/projection-store-boundary-rfc.md)
- [docs/rfcs/implementation-options-rfc.md](./docs/rfcs/implementation-options-rfc.md)
