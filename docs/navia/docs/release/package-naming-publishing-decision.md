# Package naming and publishing decision

Status: implemented for the merged Spark monorepo branch.

## Decision

Navia packages use the shared `@zendev-lab/*` npm scope with explicit
`navia-*` package names:

| Package | Release classification | Rationale |
| --- | --- | --- |
| `@zendev-lab/spark-daemon` | Daemon service package when release gates pass | Owns the daemon implementation invoked by the unified `spark daemon` command group. |
| `@zendev-lab/navia-protocol` | Public or semi-public integration contract | Protocol schemas and typed identifiers are the safest shared API for external Spark daemons, tests, and fixtures. |
| `@zendev-lab/navia-db` | Public only if downstream server embedders need migrations; otherwise internal initially | SQLite projection/cache implementation detail. Publishing creates migration-support obligations. |
| `@zendev-lab/navia-domain` | Internal initially | Shared domain utility boundary; no standalone user install story yet. |
| `@zendev-lab/navia-system` | Internal initially unless Spark daemon/web split requires it | Local path/private-file helpers for monorepo packages. |
| `@zendev-lab/navia-ui` | Internal/private initially | Svelte UI primitives tied to the Navia cockpit design contract. |
| `@zendev-lab/spark-cockpit` | Private | SvelteKit app; keep private until packaged server distribution is finalized. |
| root `spark` workspace | Private | pnpm workspace aggregator, not an npm package. |

The package names preserve the Navia cockpit/projection boundary while aligning
runtime ownership with Spark/Pi packages under `@zendev-lab/*`. Public user flows route through the unified `spark daemon` command group rather than a separate daemon binary.

## Implemented tree shape

- `apps/spark-cockpit` — private SvelteKit cockpit app, package
  `@zendev-lab/spark-cockpit`.
- `apps/spark-daemon` — Spark daemon service package,
  `@zendev-lab/spark-daemon`.
- `packages/navia-protocol`, `packages/navia-db`, `packages/navia-domain`,
  `packages/navia-system`, `packages/navia-ui` — reusable Navia libraries.

Spark runtime truth remains in `.spark` stores and Spark packages. Navia SQLite
state remains a projection/cache boundary.

## Alternatives considered

### Keep the former standalone Navia npm scope

Rejected for the merged branch. It preserved the original standalone Navia
namespace but left a second npm scope to explain and own after the product moved
under the Spark monorepo.

### Collapse Navia into one published package

Deferred. A single package may simplify installation later, but it would blur the
current high-cohesion boundaries between protocol, projection DB, domain helpers,
system helpers, UI, Spark daemon, and web app. Revisit after the packaged server
story is clear.

## Required follow-up before public npm release

1. Confirm npm ownership/access for the `@zendev-lab` scope.
2. Add/confirm package `license`, `repository`, `homepage`, and provenance
   metadata for every publishable package.
3. Decide the exact first-publish set. Recommended default: public
   `@zendev-lab/spark-daemon` + `@zendev-lab/navia-protocol`; keep
   `@zendev-lab/spark-cockpit` private; keep `db`, `domain`, `system`, and `ui`
   internal unless a release consumer is identified.
4. Run `pnpm run publish` after logging in; it validates, builds, and publishes the selected public package set.
5. If any packages were ever published under the former standalone Navia scope,
   publish compatibility shims or npm deprecation notices and document the migration.
