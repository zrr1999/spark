# npm publishing

Navia's current npm publish surface is the runner and shared packages. The recommended staged policy and rename/collapse trade-off analysis live in [package-naming-publishing-decision.md](./package-naming-publishing-decision.md).

- `@navia-dev/runner`
- `@navia-dev/protocol`
- `@navia-dev/system`
- `@navia-dev/db`
- `@navia-dev/domain`
- `@navia-dev/ui`

The repository root remains `private` because it is a pnpm workspace aggregator, not a package. `@navia-dev/web` also remains private until the server distribution is finalized.

## Checks

```bash
pnpm release:check
pnpm pack:check
```

Use `pnpm release:smoke` before a release candidate when the runner smoke should also run.

## Publish

Confirm the npm account owns the `@navia-dev` scope before publishing.

```bash
pnpm login
pnpm -r --filter @navia-dev/protocol --filter @navia-dev/system --filter @navia-dev/db --filter @navia-dev/domain --filter @navia-dev/ui --filter @navia-dev/runner publish --access public
```

## Release decisions still required

- Choose and add a project license before a public open-source release.
- Add repository/homepage metadata after the GitHub remote is created.
- Decide whether npm provenance/signing is required for the first public release.
