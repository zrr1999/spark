# Package naming and publishing decision packet

Status: decision packet / recommended default, not an implemented rename.

## Question

After merging Navia into the Spark monorepo, should the Navia packages:

1. stay under `@navia-dev/*`,
2. move to `@zendev-lab/navia-*`, or
3. collapse into one or a smaller number of published packages?

## Recommendation

Keep the existing `@navia-dev/*` package names for the current merged Spark
release gate. Do **not** rename packages or collapse the package graph until the
Spark-runtime-backed cockpit has passed the final merged release gate and a
separate approval exists for an npm migration.

For the first public release, keep these classifications:

| Package | Release classification | Rationale |
| --- | --- | --- |
| `@navia-dev/runner` | Public CLI package when release gates pass | Owns the `navia` binary and local service daemon. Keep the binary name stable even if the package scope later changes. |
| `@navia-dev/protocol` | Public or semi-public integration contract | Protocol schemas and typed identifiers are the safest shared API for external runners, tests, and fixtures. |
| `@navia-dev/db` | Public only if downstream server embedders need migrations; otherwise internal initially | It is a SQLite projection/cache implementation detail for the local cockpit. Publishing creates migration-support obligations. |
| `@navia-dev/domain` | Internal initially | Currently a shared implementation utility that depends on `db` and `protocol`; no standalone user install story yet. |
| `@navia-dev/system` | Internal initially unless runner/web split requires it | Local path/private-file helpers are useful inside the monorepo but not yet a stable user API. |
| `@navia-dev/ui` | Internal/private initially | UI exports are tied to the SvelteKit cockpit design contract and are not required for the `navia` CLI install path. |
| `@navia-dev/web` | Private | It is the SvelteKit app; keep private until the packaged server distribution is finalized. |
| root `spark` workspace | Private | It is a pnpm workspace aggregator, not an npm package. |

This is a staged recommendation: **keep names now**, publish only the surfaces
that are actually supported, and revisit scope alignment after the product has a
validated release candidate.

## Evidence from the current tree

- The Spark root workspace is private and the Navia verification scripts are
  already keyed to the current `@navia-dev/*` selectors:
  `package.json:4`, `package.json:34`, `package.json:35`, `package.json:36`,
  `package.json:37`, `package.json:38`, `package.json:39`, `package.json:40`,
  `package.json:41`.
- Spark-owned packages use the `@zendev-lab/*` scope, including
  `@zendev-lab/spark-cli` and `@zendev-lab/spark-runtime`:
  `README.md:81`, `README.md:82`, `README.md:83`.
- Navia is documented as a separate product boundary inside the Spark monorepo,
  not as a renamed Spark package: `README.md:98`, `README.md:99`,
  `README.md:100`.
- `@navia-dev/runner` is the only package with a user-facing binary (`navia`)
  and already has public publish metadata: `packages/navia-runner/package.json:2`,
  `packages/navia-runner/package.json:5`, `packages/navia-runner/package.json:14`.
- The runner depends on Spark runtime packages rather than replacing them:
  `packages/navia-runner/package.json:31`.
- The private web app remains explicitly private and depends on all shared Navia
  packages from the workspace: `apps/navia-web/package.json:2`,
  `apps/navia-web/package.json:4`, `apps/navia-web/package.json:18`,
  `apps/navia-web/package.json:19`, `apps/navia-web/package.json:20`,
  `apps/navia-web/package.json:21`, `apps/navia-web/package.json:22`.
- The Navia README currently presents a `@navia-dev/*` publish surface while
  stating that `@navia-dev/web` is private: `docs/navia/README.md:64`,
  `docs/navia/README.md:75`, `docs/navia/README.md:176`,
  `docs/navia/README.md:177`.
- The npm publishing checklist still requires scope ownership, license,
  repository metadata, provenance/signing decisions, and server distribution
  work before public release: `docs/navia/docs/release/npm-publishing.md:25`,
  `docs/navia/docs/release/npm-publishing.md:32`,
  `docs/navia/docs/release/npm-publishing.md:34`,
  `docs/navia/docs/release/npm-publishing.md:35`,
  `docs/navia/docs/release/npm-publishing.md:36`.

## Option comparison

### Option A — keep `@navia-dev/*` for the merged release

Benefits:

- Lowest migration risk; no import, lockfile, package, script, or docs churn in
  the release gate.
- Preserves the Navia product boundary while Spark owns runtime truth.
- Keeps the user-facing `navia` binary stable.
- Avoids burning npm package names under `@zendev-lab/*` before the server
  distribution and public API surface are stable.

Costs:

- The npm scope differs from Spark's `@zendev-lab/*` packages.
- Release docs must explain that Navia is a Spark product line with its own
  package scope.
- The project must confirm npm ownership of the `@navia-dev` scope before any
  public publish.

Release impact:

- No code rename required now.
- Release gate remains focused on functionality and package correctness.
- Public publishing still blocked on license, repository metadata, and package
  support decisions already listed in the release docs.

### Option B — rename to `@zendev-lab/navia-*`

Benefits:

- Aligns npm scope with Spark/Pi packages.
- Makes monorepo ownership obvious in package names.
- Removes the need to explain a separate `@navia-dev` npm scope.

Costs:

- Requires coordinated renames in all package manifests, imports, scripts,
  docs, `pnpm-lock.yaml`, and generated package metadata.
- Requires a compatibility/deprecation plan for any already published
  `@navia-dev/*` packages.
- Increases release risk while the Spark runtime bridge and final merged gate
  are still being proven.

If selected later, use these target names:

| Current | Rename target |
| --- | --- |
| `@navia-dev/runner` | `@zendev-lab/navia-runner` |
| `@navia-dev/protocol` | `@zendev-lab/navia-protocol` |
| `@navia-dev/db` | `@zendev-lab/navia-db` |
| `@navia-dev/domain` | `@zendev-lab/navia-domain` |
| `@navia-dev/system` | `@zendev-lab/navia-system` |
| `@navia-dev/ui` | `@zendev-lab/navia-ui` |
| `@navia-dev/web` | `@zendev-lab/navia-web` (still private) |

Keep the `navia` binary name regardless of package scope.

### Option C — collapse the publish surface

Variants:

- Publish only `@navia-dev/runner` (or later `@zendev-lab/navia-runner`) and
  bundle/internalize the rest.
- Publish a single `@zendev-lab/navia` package containing CLI, server, protocol,
  and migrations.

Benefits:

- Simpler install story for users.
- Fewer public APIs to support.
- Less npm version choreography.

Costs:

- Blurs the current high-cohesion boundaries between protocol, projection DB,
  domain helpers, system helpers, UI, runner, and web app.
- Makes protocol-only integrations harder.
- Requires packaging/server-distribution work that is not complete yet.
- Would need extra build changes because the web app is still private and the
  runner/server distribution path is not finalized.

Release impact:

- Not recommended before the first successful merged release gate.
- Revisit only after the packaged server distribution is designed.

## Required follow-up before public npm release

1. Decide whether this packet's default is accepted or whether a scope rename is
   required before first publish.
2. Confirm npm ownership/access for the chosen scope.
3. Add/confirm package `license`, `repository`, `homepage`, and provenance
   metadata for every publishable package.
4. Decide the exact first-publish set. Recommended default: public
   `runner` + `protocol`; keep `web` private; keep `db`, `domain`, `system`, and
   `ui` internal unless a release consumer is identified.
5. Run `pnpm run verify:merged` and the final release gate before publishing.
6. If renaming after any public `@navia-dev/*` publish, publish compatibility
   shims or npm deprecation notices and document the migration.

## Decision boundary

This packet does not implement a rename, unprivate `@navia-dev/web`, or publish
anything. It exists to keep the current migration moving while making the later
npm decision explicit and evidence-backed.
