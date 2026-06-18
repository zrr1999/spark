# npm publishing

Navia's current npm publish surface is the runner and shared packages. The recommended staged policy and rename/collapse trade-off analysis live in [package-naming-publishing-decision.md](./package-naming-publishing-decision.md).

- `@zendev-lab/navia-runner`
- `@zendev-lab/navia-protocol`
- `@zendev-lab/navia-system`
- `@zendev-lab/navia-db`
- `@zendev-lab/navia-domain`
- `@zendev-lab/navia-ui`

The repository root remains `private` because it is a pnpm workspace aggregator, not a package. `@zendev-lab/navia-web` also remains private until the server distribution is finalized.

## Checks

```bash
pnpm release:check
pnpm pack:check
```

Use `pnpm release:smoke` before a release candidate when the runner smoke should also run.

## Publish

Confirm the npm account owns the `@zendev-lab` scope before publishing.

```bash
pnpm login
pnpm -r --filter @zendev-lab/navia-protocol --filter @zendev-lab/navia-system --filter @zendev-lab/navia-db --filter @zendev-lab/navia-domain --filter @zendev-lab/navia-ui --filter @zendev-lab/navia-runner publish --access public
```

## Release decisions still required

- Choose and add a project license before a public open-source release.
- Add repository/homepage metadata after the GitHub remote is created.
- Decide whether npm provenance/signing is required for the first public release.
