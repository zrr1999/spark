# Releases and managed updates

Spark production releases use one immutable source:

```text
version-matching Git tag
  → one generated @zendev-lab/spark tarball
  → npm registry
  → published GitHub Release
```

`main`, a source checkout, and a mutable GitHub branch are never production
update sources. Root `package.json#version` is the only version source. A tag
must match it exactly (`vX.Y.Z`).

## Release gate

`.github/workflows/cd-publish.yml` runs the complete repository gate, Cockpit
browser tests, exact-tarball product smoke, and the N-1 expand-only migration
gate. `pnpm run release:pack` builds once and writes:

- `dist/release/*.tgz`
- `dist/release/release-manifest.json`
- `dist/release/SHA256SUMS`

The manifest binds npm integrity, asset SHA256, Git SHA, build fingerprint,
minimum updater version, rollback range, and migration mode. Stable versions
publish with npm tag `latest`; prereleases use `next` and a GitHub prerelease.
The workflow passes the immutable candidate between jobs with GitHub's artifact
actions, stages a draft with `softprops/action-gh-release`, publishes the exact
tarball with `JS-DevTools/npm-publish`, and publishes the GitHub Release only
after npm succeeds. A rerun compares the already-published npm and GitHub asset
integrities and fails closed on any difference.

Configure the GitHub `npm-release` environment with required reviewers and
enable immutable releases in repository settings. Give the workflow
`contents`, `id-token`, and attestation write permissions only.

### First npm publication

The first publication may use a short-lived, package-scoped granular
`NPM_TOKEN` stored only in the protected `npm-release` environment:

1. Push the first reviewed version tag and let the protected workflow publish.
2. Configure npm trusted publishing for repository `zrr1999/spark`, workflow
   `.github/workflows/cd-publish.yml`, and environment `npm-release`.
3. Rerun a prerelease through OIDC provenance to verify trusted publishing.
4. Revoke and remove the one-time token from npm and GitHub.

Do not retain a broad automation token as a fallback.

## Managed layout

`spark install --managed` creates:

```text
$XDG_DATA_HOME/spark/versions/<version>/
$XDG_DATA_HOME/spark/versions/current
$XDG_CONFIG_HOME/spark/update.toml
$XDG_STATE_HOME/spark/update/
$XDG_CACHE_HOME/spark/update/
$PREFIX/bin/spark
```

The executable under `$PREFIX/bin` is version-independent. launchd and daemon
restart helpers always reference it. The updater owns update state; daemon and
Cockpit only read its projection.

Default policy:

```toml
policy = "notify"
channel = "latest"
checkIntervalHours = 6
```

`SPARK_UPDATE_POLICY` and `SPARK_UPDATE_CHANNEL` override the file. `manual`
disables background network checks. `auto` is opt-in, requires a provably idle
daemon and an expand-only candidate, and never crosses a pre-1.0 minor
boundary.

Useful commands:

```text
spark update status --json
spark update check
spark update apply 0.1.1 --yes --wait
spark update rollback --yes --wait
spark update retry 0.1.1 --yes
spark update configure --policy notify --channel latest
spark version --json
```

An update downloads and verifies one exact npm version, runs candidate smoke
under an isolated `SPARK_HOME`, switches `current` atomically, and fences daemon
restart to the target build fingerprint. Three matching health checks are
required. Failure switches back to the rollback version and quarantines the
candidate; retry requires an explicit command or a newer version.

Database migrations eligible for automatic update must be expand-only and
readable by N-1. Destructive migrations require manual confirmation. Rollback
switches executable versions; it never restores an old database snapshot or
discards daemon sessions/messages.

## Rollout order

Keep the pre-1.0 rollout deliberately gated:

1. Land build fingerprints, target-fenced daemon restart, and `daemon sync --wait`.
2. Publish the first reviewed npm package and matching GitHub Release.
3. Exercise managed install plus manual apply/rollback on macOS.
4. Enable the `notify` launchd job by default; keep `auto` opt-in.
5. Open `auto` only after three real upgrades and one failed-candidate rollback
   preserve the daemon database, sessions, transcripts, Cockpit reconnection,
   and exact successor build identity.

Linux uses the same launcher, layout, lock, transaction, and CLI contracts.
Automated systemd installation is intentionally deferred.
