# spark

Spark is a controlled coding-agent suite with native TUI, daemon, and Cockpit hosts. The public command dispatcher exposes three surfaces:

```text
spark tui
spark daemon
spark cockpit
```

- `spark tui` is the interactive terminal host.
- `spark daemon` owns persistent sessions, SQLite invocations, channels, local execution, and autonomous driver timing/retry/recovery.
- `spark cockpit` launches the web control and projection surface; it does not run autonomous timers.

The single `@zendev-lab/spark-extension` composition root exposes the canonical capability tools to native and structurally compatible hosts. `role` manages reusable definitions and fresh anonymous calls; `session` owns persistent lifecycle, continuity, bindings, calls, and mail.

User documentation is maintained in the
[`apps/spark-docs`](./apps/spark-docs/README.md) workspace and deployed as a
bilingual static site through the `CD - Docs` Cloudflare Workers workflow.

## Common commands

```text
spark
spark run "prompt"
spark run --json "prompt"
spark run --resume <session-id> "prompt"
spark bg --session <session-id> "prompt"
spark doctor
spark daemon status --json
spark daemon session list --json
spark daemon submit --session <session-id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
spark cockpit
```

Inside an agent host, ordinary input is lightweight by default. `/plan` creates or refines durable tasks, while daemon-owned drivers run `/implement`, `/loop`, `/goal`, `/repro`, and `/workflow` independently of the frontend. `/loop fresh <objective>` resets the hidden execution session for every tick while retaining the logical owner's workspace state. In Spark-native TUI, `/btw` controls a daemon-owned read-only Side Thread using command/status output; its lifecycle and subcommands are specified in [`docs/specs/tools.md`](./docs/specs/tools.md#native-btw).

## Install

The npm release exposes one public product and one executable. A managed
installation is recommended because it provides atomic upgrades and rollback:

```text
pnpm dlx @zendev-lab/spark install --managed
spark --help
spark daemon start
spark cockpit
```

Node `>=26 <27` is required. A normal npm/pnpm install remains usable, but it
only reports exact upgrade commands and never mutates its package-manager
installation or a source checkout. The source monorepo and its workspaces stay
private implementation boundaries; they are compiled into the published
product rather than becoming separate public packages.

## Development

```text
pnpm install
pnpm run check
pnpm run smoke
pnpm run preview
node --experimental-strip-types scripts/spark-zellij-harness.mts --session spark
```

pnpm `>=11 <12` is required for source development. `pnpm run release:pack`
builds the single public tarball locally; only a version-matching `vX.Y.Z` tag
may publish it through the protected release workflow. `.spark/` (including
`.spark/memory/`) is local runtime state and should remain uncommitted unless
explicitly exported. Legacy `.learnings/` directories are also ignored if
present.

Contracts, including state ownership and adapter boundaries, are indexed in [`docs/README.md`](./docs/README.md). Contributor and automation constraints are in [`AGENTS.md`](./AGENTS.md).
