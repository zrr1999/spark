# Spark docs

These files are current contracts or operator procedures. Product and package implementation details belong in source and package READMEs.

- [`specs/command-planes.md`](./specs/command-planes.md): canonical CLI planes and placement rules.
- [`specs/configuration-and-paths.md`](./specs/configuration-and-paths.md): `SPARK_HOME` and XDG path layout, precedence, and migration policy.
- [`specs/compact-v2.md`](./specs/compact-v2.md): compaction thresholds, token sources, repeated-overflow bounds, and Memory handoff.
- [`specs/tools.md`](./specs/tools.md): public agent-facing tools and commands.
- [`specs/sessions-and-channels.md`](./specs/sessions-and-channels.md): persistent sessions, origins, mail, and channel policy.
- [`specs/human-interaction.md`](./specs/human-interaction.md): ask/approval waits, status vocabulary, and correlation.
- [`specs/turn.md`](./specs/turn.md): daemon command and event vocabulary.
- [`specs/spark-runtime-integration.md`](./specs/spark-runtime-integration.md): `spark run --json` integration.
- [`specs/spark-cockpit-remote-access.md`](./specs/spark-cockpit-remote-access.md): remote Cockpit operation.
- [`operations/cockpit-relocation.md`](./operations/cockpit-relocation.md): feature-only Cockpit snapshot relocation, HTTPS/WSS cutover, validation, and rollback.
- [`operations/zellij-harness.md`](./operations/zellij-harness.md): real TUI validation and pane capture.
- [`operations/mutation-ce.md`](./operations/mutation-ce.md): leaf-package Stryker continuous evaluation, timing table, and hygiene.

## Terminology: three “runtime” meanings

Spark uses “runtime” in three unrelated senses; do not conflate them:

1. **`@zendev-lab/spark-runtime`** — task → role execution adapter.
2. **`SparkHostRuntime` (`spark-host`)** — SparkHostAPI host instance for tools/commands/events.
3. **Coordination “runtime”** — a registered remote daemon peer (`runtime-registration`, `runtime-session-control`, `runtime-ws`).
