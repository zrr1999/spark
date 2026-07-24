---
title: CLI reference
description: Stable public Spark dispatcher commands and common daemon and Cockpit operations.
---

## Dispatcher

```text
spark
spark run [--json] [--wait] [--resume <session>] <prompt>
spark bg [--session <id>] [--json] <prompt>
spark paths [--json]
spark doctor
spark tui [initial message]
spark install --managed [--version <version>] [--prefix <path>]
spark update status|check|apply|rollback|retry|configure
spark version [--json]
spark daemon <command> [args...]
spark cockpit [command] [args...]
spark --help
spark --version
```

- `spark` opens the interactive TUI.
- `spark run` performs a foreground headless run.
- `spark bg` submits durable background work.
- `spark paths` reports effective configuration and state paths.
- `spark doctor` runs top-level health diagnostics through the daemon CLI.
- `spark install --managed` creates a managed installation with an immutable launcher.
- `spark update` owns managed update policy, version switching, and rollback.
- `spark version` reports exact package and build identity.
- `spark daemon` addresses execution-plane resources.
- `spark cockpit` starts or administers the web coordination surface.

Unknown subcommands fail instead of being treated as prompts.

## Managed installation and updates

```text
spark install --managed [--version <version>] [--prefix <path>]
spark update status [--json]
spark update check [--json]
spark update configure --policy manual|notify|auto --channel latest|next
spark update apply [version] --yes
spark update rollback --yes
spark update retry [version] --yes
spark version [--json]
```

`apply`, `rollback`, and `retry` mutate the managed installation and require
`--yes`. The default policy is `notify`; automatic application remains opt-in.
Package-manager installations and source checkouts are never modified by the
updater.

## Daemon service

```text
spark daemon status [--json]
spark daemon start
spark daemon stop
spark daemon restart [--yes] [--wait]
spark daemon sync [--wait]
spark daemon logs [--follow] [--lines <n>]
```

## Sessions and invocations

```text
spark daemon session list --json
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
```

## Workspaces and remote Cockpit

```text
spark daemon login --server-url <url>
spark daemon workspace register . --server-url <url> --token <token> --name <name>
spark daemon workspace ls --json
spark cockpit access create
spark cockpit workspace access create --workspace <id>
```

Use `--allow-insecure-http` only for an explicitly trusted private network.
Prefer HTTPS for every non-loopback Cockpit URL.
