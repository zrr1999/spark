# spark

Spark is a controlled coding-agent suite for Pi and Spark-native hosts. The public command dispatcher exposes three surfaces:

```text
spark tui
spark daemon
spark cockpit
```

- `spark tui` is the interactive terminal host.
- `spark daemon` owns persistent sessions, SQLite invocations, channels, and local execution.
- `spark cockpit` owns project/task/goal/review/workflow coordination and launches the web UI.

The Pi extension and native hosts expose the same canonical capability tools. `role` manages reusable definitions and fresh anonymous calls; `session` owns persistent lifecycle, continuity, bindings, calls, and mail.

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

Inside an agent host, ordinary input is lightweight by default. `/plan` creates or refines durable tasks, `/implement` executes ready work, `/loop` schedules recurring work, `/goal` runs reviewer-gated autonomous work, and `/workflow` runs a selected saved workflow. In Spark-native TUI, `/btw` controls a daemon-owned read-only Side Thread using command/status output; its lifecycle and subcommands are specified in [`docs/specs/tools.md`](./docs/specs/tools.md#native-btw).

## Install

The npm release exposes one public product and one executable:

```text
npm install --global @zendev-lab/spark
spark --help
spark daemon start
spark cockpit
```

Node `>=26 <27` is required. The source monorepo and its workspaces stay private implementation boundaries; they are compiled into the published product rather than becoming separate public packages.

## Development

```text
pnpm install
pnpm run check
pnpm run test:npm-product
pnpm run preview
pnpm run check:zellij-harness -- --session spark
```

pnpm `>=11 <12` is required for source development. Maintainers can run `pnpm run publish` to execute the full validation and clean-install smoke before publishing only the generated `@zendev-lab/spark` artifact. `.spark/` (including `.spark/memory/`) is local runtime state and should remain uncommitted unless explicitly exported. Legacy `.learnings/` directories are also ignored if present.

Contracts, including state ownership and adapter boundaries, are indexed in [`docs/README.md`](./docs/README.md). Contributor and automation constraints are in [`AGENTS.md`](./AGENTS.md).
