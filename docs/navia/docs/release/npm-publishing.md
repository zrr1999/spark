# npm publishing

Navia's current npm publish surface is the Spark daemon and shared packages. The recommended staged policy and rename/collapse trade-off analysis live in [package-naming-publishing-decision.md](./package-naming-publishing-decision.md).

- `@zendev-lab/spark-daemon`
- `@zendev-lab/navia-protocol`
- `@zendev-lab/navia-system`
- `@zendev-lab/navia-db`
- `@zendev-lab/navia-domain`
- `@zendev-lab/navia-ui`

The repository root remains `private` because it is a pnpm workspace aggregator, not a package. `@zendev-lab/spark-cockpit` also remains private until the server distribution is finalized.

## Checks

```bash
pnpm run check
pnpm run build
```

Use focused package tests before a release candidate when the Spark daemon/server projection path should also be checked.

## Publish

Confirm the npm account owns the `@zendev-lab` scope before publishing.

```bash
pnpm login
pnpm run publish
```

## Release decisions still required

- Choose and add a project license before a public open-source release.
- Add repository/homepage metadata after the GitHub remote is created.
- Decide whether npm provenance/signing is required for the first public release.
