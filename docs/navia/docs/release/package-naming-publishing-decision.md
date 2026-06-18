# Package naming and publishing decision

Status: implemented for the merged Spark monorepo branch.

## Decision

Navia packages use the shared `@zendev-lab/*` npm scope with explicit
`navia-*` package names:

| Package | Release classification | Rationale |
| --- | --- | --- |
| `@zendev-lab/navia-runner` | Public CLI package when release gates pass | Owns the `navia` binary and local service daemon. |
| `@zendev-lab/navia-protocol` | Public or semi-public integration contract | Protocol schemas and typed identifiers are the safest shared API for external runners, tests, and fixtures. |
| `@zendev-lab/navia-db` | Public only if downstream server embedders need migrations; otherwise internal initially | SQLite projection/cache implementation detail. Publishing creates migration-support obligations. |
| `@zendev-lab/navia-domain` | Internal initially | Shared domain utility boundary; no standalone user install story yet. |
| `@zendev-lab/navia-system` | Internal initially unless runner/web split requires it | Local path/private-file helpers for monorepo packages. |
| `@zendev-lab/navia-ui` | Internal/private initially | Svelte UI primitives tied to the Navia cockpit design contract. |
| `@zendev-lab/navia-web` | Private | SvelteKit app; keep private until packaged server distribution is finalized. |
| root `spark` workspace | Private | pnpm workspace aggregator, not an npm package. |

The package names preserve the Navia product boundary while aligning ownership
with Spark/Pi packages under `@zendev-lab/*`. The user-facing binary remains
`navia` regardless of package name.

## Implemented tree shape

- `apps/navia-web` — private SvelteKit cockpit app, package
  `@zendev-lab/navia-web`.
- `apps/navia-runner` — Navia CLI/local service daemon, package
  `@zendev-lab/navia-runner`.
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
system helpers, UI, runner, and web app. Revisit after the packaged server
story is clear.

## Required follow-up before public npm release

1. Confirm npm ownership/access for the `@zendev-lab` scope.
2. Add/confirm package `license`, `repository`, `homepage`, and provenance
   metadata for every publishable package.
3. Decide the exact first-publish set. Recommended default: public
   `@zendev-lab/navia-runner` + `@zendev-lab/navia-protocol`; keep
   `@zendev-lab/navia-web` private; keep `db`, `domain`, `system`, and `ui`
   internal unless a release consumer is identified.
4. Run `pnpm run verify:merged` and the final release gate before publishing.
5. If any packages were ever published under the former standalone Navia scope,
   publish compatibility shims or npm deprecation notices and document the migration.
