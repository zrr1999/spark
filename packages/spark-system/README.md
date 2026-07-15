# @zendev-lab/spark-system

Filesystem path, private-file permission, command, and local runtime helpers shared by Spark packages.

## Paths

`resolveSparkHome()` resolves the user-level Spark root. `resolveSparkUserPaths()` derives all Spark-owned user configuration and state paths, and `resolveSparkPaths({ app })` derives Cockpit/daemon data, cache, state, and runtime paths.

All Spark-owned user paths use one root: explicit API `sparkHome`, then `SPARK_HOME`, then `$HOME/.spark`. Workspace state remains under each workspace `.spark/` directory. Legacy component variables and XDG paths are not active path overrides.

See [`../../docs/specs/configuration-and-paths.md`](../../docs/specs/configuration-and-paths.md) for layout, precedence, and migration policy.

This package is part of the Spark monorepo and targets Node 26.
